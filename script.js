/* ═══════════════════════════════════════════════════════════════════════
   SkyTrace ATC — script.js
   Full air traffic monitoring application
   Sections:
     1. CONFIG          — constants, region presets, helpers
     2. STATE           — aircraft store, history ring-buffer
     3. API             — OpenSky fetch, retry, circuit-breaker, cache
     4. MAP             — Leaflet map, plane markers, trails, draw tool
     5. UI              — sidebar list, stats, filters, detail panel, alerts
     6. MAIN            — boot, poll loop, visibility API, wiring
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════
   1. CONFIG
   ══════════════════════════════════════════════════════════════ */
const CONFIG = {
  API_BASE: 'https://opensky-network.org/api',
  LOCAL_PROXY: '/api/states/all',
  LOCAL_SERVER_URL: 'http://localhost:3000/api/states/all',
  POLL_INTERVAL_MS:  15000,             // 15 s — respects OpenSky's ~10 s state cadence
  STALE_THRESHOLD_MS: 90000,            // 90 s  → mark stale
  REMOVE_THRESHOLD_MS: 300000,          // 5 min → remove from store
  MAX_HISTORY: 20,                      // observations per aircraft
  MAX_RETRIES: 2,
  CIRCUIT_BREAK_AFTER: 3,              // failures before circuit opens
  CIRCUIT_RESET_MS: 60000,             // 60 s circuit reset
};

// Geographical presets [minLat, minLon, maxLat, maxLon]
const REGIONS = {
  india:  { label: 'India',          bbox: [6.5,  68.0,  35.5, 97.5]  },
  europe: { label: 'Europe',         bbox: [36.0, -10.0, 70.0, 32.0]  },
  usa:    { label: 'United States',  bbox: [24.0,-125.0, 49.5,-66.0]  },
  sea:    { label: 'South-East Asia',bbox: [-10.0, 95.0, 25.0,140.0]  },
  world:  { label: 'World',          bbox: [-90.0,-180.0, 90.0,180.0] },
};

// Country code → flag emoji helper
function countryFlag(name) {
  const MAP = {
    'India':'🇮🇳','United States':'🇺🇸','Germany':'🇩🇪','United Kingdom':'🇬🇧',
    'France':'🇫🇷','Netherlands':'🇳🇱','Spain':'🇪🇸','China':'🇨🇳','Japan':'🇯🇵',
    'Canada':'🇨🇦','Australia':'🇦🇺','Brazil':'🇧🇷','Russia':'🇷🇺','Turkey':'🇹🇷',
    'Italy':'🇮🇹','United Arab Emirates':'🇦🇪','Singapore':'🇸🇬','Thailand':'🇹🇭',
    'Malaysia':'🇲🇾','Indonesia':'🇮🇩','Pakistan':'🇵🇰','Bangladesh':'🇧🇩',
    'Sri Lanka':'🇱🇰','Nepal':'🇳🇵','Qatar':'🇶🇦','Saudi Arabia':'🇸🇦',
    'Switzerland':'🇨🇭','Sweden':'🇸🇪','Norway':'🇳🇴','Poland':'🇵🇱',
    'South Korea':'🇰🇷','Mexico':'🇲🇽','Argentina':'🇦🇷','South Africa':'🇿🇦',
  };
  return MAP[name] || '✈️';
}

function metersToFeet(m)   { return m != null ? Math.round(m * 3.28084) : null; }
function msToKnots(ms)     { return ms != null ? Math.round(ms * 1.94384) : null; }
function secAgo(ts) {
  if (!ts) return '?';
  const s = Math.floor(Date.now()/1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

/* ══════════════════════════════════════════════════════════════
   2. STATE
   ══════════════════════════════════════════════════════════════ */

/** Circular ring buffer for per-aircraft history */
class RingBuffer {
  constructor(capacity) {
    this.cap  = capacity;
    this.data = [];
  }
  push(item) {
    if (this.data.length >= this.cap) this.data.shift();
    this.data.push(item);
  }
  toArray() { return [...this.data]; }
  get length() { return this.data.length; }
}

/** Central aircraft store — Map<icao24 → aircraftEntry> */
const store = {
  aircraft: new Map(),   // icao24 → entry
  filters:  {
    callsign:   '',
    country:    '',
    altMin:     0,
    altMax:     45000,
    spdMin:     0,
    groundOnly: false,
    hideStale:  true,
  },
  sort: 'callsign',
  selectedIcao: null,
  currentRegion: 'india',
  customBbox: null,       // [minLat, minLon, maxLat, maxLon] if drawn
  alertRules: { altMin: 1000, spdMax: 600, boundary: true, enabled: true },
  lastFetch: null,
  previousIcaos: new Set(), // for boundary alerts

  /** Merge a fresh OpenSky state vector into the store */
  upsert(sv) {
    const icao   = sv[0];
    const now    = Math.floor(Date.now()/1000);
    const existing = this.aircraft.get(icao) || { history: new RingBuffer(CONFIG.MAX_HISTORY) };

    const lat = sv[6];
    const lon = sv[5];
    const alt = sv[7]; // baro altitude metres
    const spd = sv[9]; // m/s
    const hdg = sv[10];
    const vr  = sv[11];

    // push to history whenever position is valid
    if (lat != null && lon != null) {
      existing.history.push({
        ts:  sv[4] || now,
        lat, lon,
        alt: metersToFeet(alt),
        spd: msToKnots(spd),
      });
    }

    this.aircraft.set(icao, {
      ...existing,
      icao24:        icao,
      callsign:      (sv[1] || '').trim() || icao,
      originCountry: sv[2] || 'Unknown',
      lastSeen:      sv[4] || now,
      lon:           lon,
      lat:           lat,
      baroAlt:       alt,
      velocity:      spd,
      heading:       hdg,
      verticalRate:  vr,
      onGround:      sv[8] || false,
      squawk:        sv[14] || '—',
      posSource:     sv[16],
      altFt:         metersToFeet(alt),
      spdKt:         msToKnots(spd),
      isStale:       false,
      _updated:      Date.now(),
    });
  },

  /** Called after every fetch to mark/remove aircraft */
  reconcile(freshIcaos) {
    const now = Date.now();
    const current = new Set(freshIcaos);

    for (const [icao, ac] of this.aircraft) {
      const age = now - ac._updated;
      if (age > CONFIG.REMOVE_THRESHOLD_MS) {
        this.aircraft.delete(icao);
      } else if (age > CONFIG.STALE_THRESHOLD_MS) {
        ac.isStale = true;
      }
    }

    // Boundary alerts
    if (this.alertRules.enabled && this.alertRules.boundary) {
      const entered = [...current].filter(i => !this.previousIcaos.has(i));
      const exited  = [...this.previousIcaos].filter(i => !current.has(i) && this.aircraft.has(i));
      if (entered.length) ui.toast(`✈ ${entered.length} aircraft entered the region`, 'info');
      if (exited.length)  ui.toast(`↗ ${exited.length} aircraft left the region`, 'info');
    }
    this.previousIcaos = current;
  },

  /** Returns filtered + sorted array for rendering */
  filtered() {
    const f = this.filters;
    const now = Math.floor(Date.now()/1000);
    let arr = [...this.aircraft.values()];

    if (f.callsign)   arr = arr.filter(a => a.callsign.toLowerCase().includes(f.callsign.toLowerCase()));
    if (f.country)    arr = arr.filter(a => a.originCountry === f.country);
    if (f.groundOnly) arr = arr.filter(a => a.onGround);
    if (f.hideStale)  arr = arr.filter(a => !a.isStale);
    arr = arr.filter(a => {
      const alt = a.altFt ?? 0;
      const spd = a.spdKt ?? 0;
      return alt >= f.altMin && alt <= f.altMax && spd >= f.spdMin;
    });

    switch (this.sort) {
      case 'altitude': arr.sort((a,b) => (b.altFt??0)-(a.altFt??0)); break;
      case 'speed':    arr.sort((a,b) => (b.spdKt??0)-(a.spdKt??0)); break;
      case 'lastseen': arr.sort((a,b) => (b.lastSeen??0)-(a.lastSeen??0)); break;
      default:         arr.sort((a,b) => a.callsign.localeCompare(b.callsign));
    }
    return arr;
  },

  activeBbox() {
    if (this.customBbox) return this.customBbox;
    const r = REGIONS[this.currentRegion] || REGIONS.india;
    return r.bbox;
  },
};

/* ══════════════════════════════════════════════════════════════
   3. API & DATA PIPELINE
   ══════════════════════════════════════════════════════════════ */
const api = (() => {
  let simulatedFlights = null;
  const CACHE_KEY   = 'skytrace_last_response';

  // Realistic movement simulation for fallback data
  function getSimulatedStates(minLat, minLon, maxLat, maxLon) {
    if (!simulatedFlights && typeof RECORDED_STATES !== 'undefined') {
      simulatedFlights = JSON.parse(JSON.stringify(RECORDED_STATES));
    }
    if (!simulatedFlights) return [];

    const now = Math.floor(Date.now() / 1000);

    return simulatedFlights.filter(sv => {
      let lon = sv[5];
      let lat = sv[6];
      if (lat == null || lon == null) return false;

      // Update positions dynamically between 15s polls
      if (!sv[8] && sv[9] && sv[10] != null) {
        const dt = 15; // 15 seconds forward
        const speed = sv[9]; // m/s
        const dist = speed * dt;
        const R = 6371000;
        const rad = Math.PI / 180;
        const deg = 180 / Math.PI;

        const phi1 = lat * rad;
        const lam1 = lon * rad;
        const theta = sv[10] * rad;
        const delta = dist / R;

        const phi2 = Math.asin(Math.sin(phi1)*Math.cos(delta) + Math.cos(phi1)*Math.sin(delta)*Math.cos(theta));
        const lam2 = lam1 + Math.atan2(Math.sin(theta)*Math.sin(delta)*Math.cos(phi1), Math.cos(delta) - Math.sin(phi1)*Math.sin(phi2));

        sv[6] = +(phi2 * deg).toFixed(5);
        sv[5] = +(lam2 * deg).toFixed(5);

        if (sv[11]) {
          sv[7] = Math.max(100, (sv[7] || 10000) + sv[11] * dt);
        }
      }

      sv[3] = now;
      sv[4] = now;

      return sv[6] >= minLat && sv[6] <= maxLat && sv[5] >= minLon && sv[5] <= maxLon;
    });
  }

  async function fetchWithTimeout(url, ms = 5000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(id);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  }

  async function fetchAircraft() {
    const [minLat, minLon, maxLat, maxLon] = store.activeBbox();
    const query = `lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}`;

    // Endpoint candidates:
    // 1. Same-origin proxy (if running via node server.js on localhost:3000)
    // 2. Direct localhost:3000 proxy
    // 3. Direct OpenSky (works if browser permits or when authenticated)
    const candidates = [];
    if (window.location.protocol.startsWith('http')) {
      candidates.push({ url: `${CONFIG.LOCAL_PROXY}?${query}`, type: 'proxy' });
    }
    candidates.push({ url: `${CONFIG.LOCAL_SERVER_URL}?${query}`, type: 'proxy' });
    candidates.push({ url: `${CONFIG.API_BASE}/states/all?${query}`, type: 'direct' });

    for (const candidate of candidates) {
      try {
        const data = await fetchWithTimeout(candidate.url, 4000);
        if (data && Array.isArray(data.states)) {
          saveCache(data);
          ui.setStatus(candidate.type === 'proxy' ? 'proxy' : 'online');
          ui.hideBanner();
          return data;
        }
      } catch (_) {
        // Continue to next candidate
      }
    }

    // Fallback: Realistic recorded OpenSky flight dataset with simulation
    const simStates = getSimulatedStates(minLat, minLon, maxLat, maxLon);
    if (simStates.length > 0) {
      ui.setStatus('cached');
      ui.showBanner('Offline / CORS Fallback: Displaying realistic recorded OpenSky flight data. Run "node server.js" for live API feed.');
      return { states: simStates, time: Math.floor(Date.now() / 1000) };
    }

    // Last resort: cached data from localStorage
    const cached = loadCache();
    if (cached) {
      ui.setStatus('cached');
      return cached;
    }

    ui.setStatus('offline');
    return { states: [], time: Math.floor(Date.now() / 1000) };
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch(_) {}
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if ((Date.now() - ts) > 1800000) return null; // 30 min cache
      return data;
    } catch(_) { return null; }
  }

  return { fetchAircraft };
})();

/* ══════════════════════════════════════════════════════════════
   4. MAP
   ══════════════════════════════════════════════════════════════ */
const mapModule = (() => {
  let map;
  const markerPool  = new Map();  // icao24 → L.marker
  const trailPool   = new Map();  // icao24 → L.polyline
  const replayLayer = new Map();  // icao24 → replay line

  // SVG airplane icon factory
  function planeIcon(heading, status) {
    const color = status === 'stale' ? '#ef4444' : status === 'ground' ? '#f59e0b' : '#22d3ee';
    const glow  = status === 'stale' ? 'rgba(239,68,68,.4)' : status === 'ground' ? 'rgba(245,158,11,.3)' : 'rgba(34,211,238,.35)';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
      <filter id="glow${Math.random().toString(36).slice(2)}">
        <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <g transform="rotate(${heading ?? 0}, 14, 14)" filter="url(#glow)">
        <path d="M14 2 L17 10 L26 12 L20 17 L22 26 L14 22 L6 26 L8 17 L2 12 L11 10 Z"
          fill="${color}" stroke="rgba(0,0,0,.4)" stroke-width="1"/>
      </g>
    </svg>`;
    return L.divIcon({
      html: svg, className: '', iconSize: [28,28], iconAnchor: [14,14],
    });
  }

  function init() {
    map = L.map('map', {
      center: [20.5, 78.9],
      zoom:   5,
      zoomControl: true,
      renderer: L.canvas(),   // canvas renderer for performance
      preferCanvas: true,
    });

    // Base tile layers (NO API KEY REQUIRED, NO ACCESS BLOCKED)
    const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    });

    const esriDark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
      maxZoom: 16
    });

    const cartoLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    });

    // Default to CARTO Dark Matter
    cartoDark.addTo(map);

    // Add layer switcher control
    L.control.layers({
      'Dark Matter (Default)': cartoDark,
      'ESRI Dark Gray': esriDark,
      'Positron Light': cartoLight
    }, null, { position: 'topright' }).addTo(map);

    // Invalidate size to ensure map fills container properly
    setTimeout(() => { map.invalidateSize(); }, 200);
    window.addEventListener('resize', () => { map.invalidateSize(); });

    // Leaflet Draw
    const drawnItems = new L.FeatureGroup().addTo(map);
    const drawControl = new L.Control.Draw({
      draw: { rectangle: true, polyline: false, polygon: false, circle: false, marker: false, circlemarker: false },
      edit: { featureGroup: drawnItems, remove: true },
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (e) => {
      drawnItems.clearLayers();
      drawnItems.addLayer(e.layer);
      const b = e.layer.getBounds();
      store.customBbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      document.getElementById('region-select').value = 'custom';
      store.currentRegion = 'custom';
      main.triggerRefresh();
    });

    // Zoom to region
    zoomToRegion('india');
    return map;
  }

  function zoomToRegion(key) {
    const r = REGIONS[key];
    if (!r) return;
    const [minLat, minLon, maxLat, maxLon] = r.bbox;
    if (key === 'world') { map.setView([20, 0], 2); return; }
    map.fitBounds([[minLat, minLon],[maxLat, maxLon]], { padding: [20,20] });
  }

  function updateMarkers(aircraftList) {
    const seenIcaos = new Set();

    for (const ac of aircraftList) {
      if (ac.lat == null || ac.lon == null) continue;
      seenIcaos.add(ac.icao24);

      const status = ac.isStale ? 'stale' : ac.onGround ? 'ground' : 'air';
      const icon   = planeIcon(ac.heading, status);

      let marker = markerPool.get(ac.icao24);
      if (!marker) {
        marker = L.marker([ac.lat, ac.lon], { icon })
          .addTo(map)
          .on('click', () => ui.openDetail(ac.icao24));
        markerPool.set(ac.icao24, marker);
      } else {
        marker.setLatLng([ac.lat, ac.lon]);
        marker.setIcon(icon);
      }

      marker.bindPopup(buildPopup(ac), { maxWidth: 220 });

      // Trail polyline
      const history = ac.history.toArray().filter(h => h.lat != null && h.lon != null);
      if (history.length > 1) {
        const latlngs = history.map(h => [h.lat, h.lon]);
        let trail = trailPool.get(ac.icao24);
        if (!trail) {
          trail = L.polyline(latlngs, {
            color: '#22d3ee', weight: 1.5, opacity: .5,
            dashArray: '4 4',
          }).addTo(map);
          trailPool.set(ac.icao24, trail);
        } else {
          trail.setLatLngs(latlngs);
        }
      }
    }

    // Remove stale markers
    for (const [icao, marker] of markerPool) {
      if (!seenIcaos.has(icao)) {
        marker.remove();
        markerPool.delete(icao);
        trailPool.get(icao)?.remove();
        trailPool.delete(icao);
      }
    }
  }

  function buildPopup(ac) {
    const altFt  = ac.altFt  != null ? `${ac.altFt.toLocaleString()} ft` : '—';
    const spdKt  = ac.spdKt  != null ? `${ac.spdKt} kt` : '—';
    const hdg    = ac.heading != null ? `${Math.round(ac.heading)}°` : '—';
    const vr     = ac.verticalRate != null ? `${Math.round(ac.verticalRate)} m/s` : '—';

    return `<div>
      <div class="popup-callsign">${countryFlag(ac.originCountry)} ${ac.callsign}</div>
      <div class="popup-row">Altitude  <span>${altFt}</span></div>
      <div class="popup-row">Speed     <span>${spdKt}</span></div>
      <div class="popup-row">Heading   <span>${hdg}</span></div>
      <div class="popup-row">Vert Rate <span>${vr}</span></div>
      <div class="popup-row">Country   <span>${ac.originCountry}</span></div>
      <div class="popup-row">Last Seen <span>${secAgo(ac.lastSeen)}</span></div>
      ${ac.isStale ? '<div style="color:#ef4444;font-size:11px;margin-top:4px">⚠ Stale data</div>' : ''}
      <button class="popup-btn" onclick="ui.openDetail('${ac.icao24}')">
        <i class="fas fa-chart-line"></i> Inspect Details & History
      </button>
    </div>`;
  }

  /** Fly map to a specific aircraft */
  function flyTo(icao24) {
    const ac = store.aircraft.get(icao24);
    if (!ac || ac.lat == null) return;
    map.flyTo([ac.lat, ac.lon], Math.max(map.getZoom(), 7), { duration: 1 });
    markerPool.get(icao24)?.openPopup();
  }

  /** Position interpolation — called by rAF loop */
  function interpolate(dtSec) {
    for (const [icao, ac] of store.aircraft) {
      if (ac.isStale || ac.onGround || ac.lat == null || ac.velocity == null || ac.heading == null) continue;
      const marker = markerPool.get(icao);
      if (!marker) continue;

      const RAD   = Math.PI / 180;
      const DEG   = 180 / Math.PI;
      const speed = ac.velocity; // m/s
      const dist  = speed * dtSec;
      const R     = 6371000; // Earth radius m

      const φ1  = ac.lat * RAD;
      const λ1  = ac.lon * RAD;
      const θ   = ac.heading * RAD;
      const δ   = dist / R;

      const φ2  = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ));
      const λ2  = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));

      marker.setLatLng([φ2*DEG, λ2*DEG]);
    }
  }

  /** Replay stored history on map */
  let _replayTimer = null;
  function replayHistory(icao24, speedMult) {
    stopReplay();
    const ac = store.aircraft.get(icao24);
    if (!ac) return;

    const history = ac.history.toArray().filter(h => h.lat != null);
    if (history.length < 2) {
      ui.toast('Not enough history data for replay', 'warning');
      return;
    }

    // Draw the replay trail
    const replayLine = L.polyline([], { color: '#f59e0b', weight: 2, opacity: .8 }).addTo(map);
    replayLayer.set(icao24, replayLine);

    const marker = markerPool.get(icao24);
    let i = 0;
    const step = () => {
      if (i >= history.length) { stopReplay(); return; }
      const pt = history[i++];
      replayLine.addLatLng([pt.lat, pt.lon]);
      marker?.setLatLng([pt.lat, pt.lon]);
      document.getElementById('replay-btn').disabled = true;
      document.getElementById('replay-stop').disabled = false;
      _replayTimer = setTimeout(step, (1000 / speedMult));
    };
    step();
  }

  function stopReplay() {
    if (_replayTimer) { clearTimeout(_replayTimer); _replayTimer = null; }
    for (const line of replayLayer.values()) line.remove();
    replayLayer.clear();
    document.getElementById('replay-btn').disabled = false;
    document.getElementById('replay-stop').disabled = true;
  }

  return { init, updateMarkers, flyTo, zoomToRegion, interpolate, replayHistory, stopReplay };
})();

/* ══════════════════════════════════════════════════════════════
   5. UI
   ══════════════════════════════════════════════════════════════ */
const ui = (() => {

  // ── Stat updates ──────────────────────────────────────────
  function updateStats() {
    const all      = [...store.aircraft.values()];
    const airborne = all.filter(a => !a.onGround && !a.isStale);
    const ground   = all.filter(a =>  a.onGround);
    const stale    = all.filter(a =>  a.isStale);
    const speeds   = airborne.map(a => a.spdKt).filter(Boolean);
    const alts     = airborne.map(a => a.altFt).filter(Boolean);

    el('stat-total').textContent    = all.length;
    el('stat-airborne').textContent = airborne.length;
    el('stat-ground').textContent   = ground.length;
    el('stat-stale').textContent    = stale.length;
    el('stat-speed').textContent    = speeds.length ? Math.round(avg(speeds)) + ' kt' : '— kt';
    el('stat-alt').textContent      = alts.length   ? Math.round(avg(alts)).toLocaleString() + ' ft' : '— ft';
  }

  // ── Aircraft list ──────────────────────────────────────────
  function renderList() {
    const list = store.filtered();
    const container = el('aircraft-list');
    el('aircraft-list-count').textContent = list.length;

    if (!list.length) {
      container.innerHTML = `<div class="empty-state">
        <i class="fas fa-satellite-dish fa-2x"></i>
        <p>No aircraft match current filters</p>
      </div>`;
      return;
    }

    container.innerHTML = list.map(ac => {
      const status  = ac.isStale ? 'stale' : ac.onGround ? 'ground' : 'air';
      const icon    = ac.onGround ? 'fa-plane-arrival' : 'fa-plane';
      const altStr  = ac.altFt  != null ? `FL${Math.round(ac.altFt/100).toString().padStart(3,'0')}` : '—';
      const spdStr  = ac.spdKt  != null ? `${ac.spdKt} kt` : '—';
      const flag    = countryFlag(ac.originCountry);
      const sel     = store.selectedIcao === ac.icao24 ? 'selected' : '';
      const staleBadge = ac.isStale ? '<span class="ac-stale-badge">STALE</span>' : '';

      return `<div class="aircraft-item ${status} ${sel}" data-icao="${ac.icao24}" onclick="ui.openDetail('${ac.icao24}')">
        <div class="ac-icon ${status}"><i class="fas ${icon}"></i></div>
        <div class="ac-body">
          <div class="ac-callsign">${flag} ${ac.callsign}</div>
          <div class="ac-country">${ac.originCountry}</div>
        </div>
        <div class="ac-meta">
          <div class="ac-alt">${altStr}</div>
          <div class="ac-spd">${spdStr}</div>
          ${staleBadge}
        </div>
      </div>`;
    }).join('');
  }

  // ── Detail panel ───────────────────────────────────────────
  function openDetail(icao24) {
    const ac = store.aircraft.get(icao24);
    if (!ac) return;
    store.selectedIcao = icao24;
    renderList(); // highlight selected

    el('detail-flag').textContent          = countryFlag(ac.originCountry);
    el('detail-callsign-text').textContent = ac.callsign;
    el('detail-icao').textContent          = ac.icao24;

    el('d-altitude').textContent  = ac.altFt  != null ? `${ac.altFt.toLocaleString()} ft (${Math.round(ac.baroAlt ?? 0)} m)` : '—';
    el('d-speed').textContent     = ac.spdKt  != null ? `${ac.spdKt} kt` : '—';
    el('d-heading').textContent   = ac.heading != null ? `${Math.round(ac.heading)}°` : '—';
    el('d-vrate').textContent     = ac.verticalRate != null ? `${Math.round(ac.verticalRate)} m/s` : '—';
    el('d-country').textContent   = ac.originCountry;
    el('d-squawk').textContent    = ac.squawk || '—';
    el('d-lastseen').textContent  = secAgo(ac.lastSeen);
    el('d-position').textContent  = ac.lat != null ? `${ac.lat.toFixed(3)}, ${ac.lon.toFixed(3)}` : '—';

    drawAltChart(ac);

    const hist = ac.history.toArray();
    el('replay-note').textContent = hist.length < 2
      ? `${hist.length} observation(s) — need at least 2 for replay`
      : `${hist.length} observations recorded`;

    el('detail-panel').classList.remove('hidden');
    mapModule.flyTo(icao24);

    // Alert checks
    checkAlerts(ac);
  }

  function closeDetail() {
    el('detail-panel').classList.add('hidden');
    store.selectedIcao = null;
    mapModule.stopReplay();
    renderList();
  }

  // ── Altitude sparkline chart ────────────────────────────────
  function drawAltChart(ac) {
    const canvas  = el('altitude-chart');
    const ctx     = canvas.getContext('2d');
    const W = canvas.clientWidth || 300;
    const H = canvas.clientHeight || 90;
    canvas.width  = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const hist = ac.history.toArray().filter(h => h.alt != null);
    if (hist.length < 2) {
      ctx.fillStyle = '#4a6080';
      ctx.font = '12px Arial';
      ctx.fillText('Not enough data yet', 10, H/2);
      return;
    }

    const alts  = hist.map(h => h.alt);
    const minA  = Math.min(...alts);
    const maxA  = Math.max(...alts) || 1;
    const pad   = 10;

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(34,211,238,.35)');
    grad.addColorStop(1, 'rgba(34,211,238,.02)');

    ctx.beginPath();
    hist.forEach((h, i) => {
      const x = pad + (i / (hist.length - 1)) * (W - 2*pad);
      const y = H - pad - ((h.alt - minA) / (maxA - minA)) * (H - 2*pad);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    // close fill
    const lastX = pad + (W - 2*pad);
    const lastY = H - pad;
    ctx.lineTo(lastX, lastY);
    ctx.lineTo(pad, lastY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    hist.forEach((h, i) => {
      const x = pad + (i / (hist.length - 1)) * (W - 2*pad);
      const y = H - pad - ((h.alt - minA) / (maxA - minA)) * (H - 2*pad);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Min/max labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.fillText(`${maxA.toLocaleString()} ft`, pad, pad + 10);
    ctx.fillText(`${minA.toLocaleString()} ft`, pad, H - 2);
  }

  // ── Alert system ────────────────────────────────────────────
  let alertCount = 0;
  function checkAlerts(ac) {
    if (!store.alertRules.enabled) return;
    const msgs = [];

    if (ac.altFt != null && !ac.onGround && ac.altFt < store.alertRules.altMin) {
      msgs.push(`⚠ ${ac.callsign} low altitude: ${ac.altFt.toLocaleString()} ft`);
    }
    if (ac.spdKt != null && ac.spdKt > store.alertRules.spdMax) {
      msgs.push(`🚨 ${ac.callsign} high speed: ${ac.spdKt} kt`);
    }

    msgs.forEach(m => { toast(m, 'error'); alertCount++; });
    updateAlertBadge();
  }

  function updateAlertBadge() {
    const badge = el('alert-badge');
    if (alertCount > 0) {
      badge.textContent = alertCount > 99 ? '99+' : alertCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ── Filters ─────────────────────────────────────────────────
  function updateCountryDropdown() {
    const countries = [...new Set([...store.aircraft.values()].map(a => a.originCountry))].sort();
    const sel = el('filter-country');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All countries</option>' +
      countries.map(c => `<option value="${c}"${c===cur?' selected':''}>${countryFlag(c)} ${c}</option>`).join('');
  }

  // ── Status / Banner ─────────────────────────────────────────
  function setStatus(mode) {  // 'online' | 'proxy' | 'offline' | 'cached'
    const s    = el('api-status');
    const text = el('status-text');
    if (!s || !text) return;
    s.className = `api-status ${mode === 'proxy' ? 'online' : mode}`;
    if (mode === 'online') text.textContent = 'LIVE OPENSKY';
    else if (mode === 'proxy') text.textContent = 'LOCAL PROXY';
    else if (mode === 'cached') text.textContent = 'RECORDED / DEMO';
    else text.textContent = 'OFFLINE';
  }
  function showBanner(msg) {
    el('api-banner-msg').textContent = msg;
    el('api-banner').classList.remove('hidden');
  }
  function hideBanner() { el('api-banner').classList.add('hidden'); }

  // ── Toast notifications ──────────────────────────────────────
  function toast(message, type = 'info', duration = 4000) {
    const icons = { info:'fa-info-circle', success:'fa-check-circle', warning:'fa-exclamation-triangle', error:'fa-times-circle' };
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.innerHTML = `<i class="fas ${icons[type]}"></i> ${message}`;
    el('toast-container').prepend(div);
    setTimeout(() => {
      div.classList.add('toast-out');
      setTimeout(() => div.remove(), 300);
    }, duration);
  }

  // ── Poll countdown bar ───────────────────────────────────────
  let _pollStart = Date.now();
  function startCountdown(totalMs) {
    _pollStart = Date.now();
    tick();
    function tick() {
      const elapsed = Date.now() - _pollStart;
      const pct     = Math.max(0, 1 - elapsed / totalMs);
      const secLeft = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      el('poll-bar').style.width = (pct * 100) + '%';
      el('poll-countdown').textContent = `${secLeft}s`;
      if (pct > 0) requestAnimationFrame(tick);
    }
  }

  // ── Loading overlay ──────────────────────────────────────────
  function showLoading()  { el('map-loading').style.display = 'flex'; }
  function hideLoading()  { el('map-loading').style.display = 'none'; }

  // ── Refresh button spinner ───────────────────────────────────
  function setRefreshing(v) {
    const btn = el('refresh-btn');
    btn.disabled = v;
    btn.innerHTML = v
      ? '<i class="fas fa-sync-alt spin"></i> Refreshing…'
      : '<i class="fas fa-sync-alt"></i> Refresh';
  }

  // ── Helper ───────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function avg(arr) { return arr.reduce((s,v)=>s+v,0)/arr.length; }

  return {
    updateStats, renderList, openDetail, closeDetail,
    drawAltChart, checkAlerts, updateCountryDropdown,
    setStatus, showBanner, hideBanner, toast,
    startCountdown, showLoading, hideLoading, setRefreshing,
  };
})();

// Make ui.openDetail globally callable (used in popup HTML)
window.ui = ui;

/* ══════════════════════════════════════════════════════════════
   6. MAIN — boot, poll loop, event wiring
   ══════════════════════════════════════════════════════════════ */
const main = (() => {
  let pollTimer  = null;
  let rafId      = null;
  let lastRafTs  = null;
  let isPaused   = false;

  async function fetchAndRender() {
    ui.setRefreshing(true);
    ui.showLoading();

    const data = await api.fetchAircraft();
    const freshIcaos = new Set();

    if (data && data.states) {
      for (const sv of data.states) {
        if (!sv[0]) continue;
        store.upsert(sv);
        freshIcaos.add(sv[0]);
      }
      store.reconcile(freshIcaos);
      store.lastFetch = Date.now();
    }

    ui.updateStats();
    ui.renderList();
    ui.updateCountryDropdown();

    const filtered = store.filtered();
    mapModule.updateMarkers(filtered);

    // Re-draw detail panel if open
    if (store.selectedIcao && store.aircraft.has(store.selectedIcao)) {
      const ac = store.aircraft.get(store.selectedIcao);
      ui.drawAltChart(ac);
    }

    ui.hideLoading();
    ui.setRefreshing(false);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!isPaused) await fetchAndRender();
      ui.startCountdown(CONFIG.POLL_INTERVAL_MS);
      schedulePoll();
    }, CONFIG.POLL_INTERVAL_MS);
  }

  /** Public: force an immediate refresh */
  async function triggerRefresh() {
    clearTimeout(pollTimer);
    await fetchAndRender();
    ui.startCountdown(CONFIG.POLL_INTERVAL_MS);
    schedulePoll();
  }

  /** rAF interpolation loop */
  function rafLoop(ts) {
    if (lastRafTs != null) {
      const dtMs  = ts - lastRafTs;
      const dtSec = dtMs / 1000;
      if (!isPaused && dtSec < 2) {     // sanity cap
        mapModule.interpolate(dtSec);
      }
    }
    lastRafTs = ts;
    rafId = requestAnimationFrame(rafLoop);
  }

  function wireEvents() {
    const el = id => document.getElementById(id);

    // Refresh button
    el('refresh-btn').addEventListener('click', triggerRefresh);

    // Region selector
    el('region-select').addEventListener('change', e => {
      const val = e.target.value;
      if (val === 'custom') return; // wait for draw
      store.currentRegion = val;
      store.customBbox    = null;
      mapModule.zoomToRegion(val);
      triggerRefresh();
    });

    // Filter panel toggle
    el('filter-toggle').addEventListener('click', () => el('filter-panel').classList.toggle('hidden'));
    el('filter-close').addEventListener('click',  () => el('filter-panel').classList.add('hidden'));

    // Alert panel toggle
    el('alert-toggle').addEventListener('click', () => el('alert-panel').classList.toggle('hidden'));
    el('alert-panel-close').addEventListener('click', () => el('alert-panel').classList.add('hidden'));

    // Detail panel close
    el('detail-close').addEventListener('click', ui.closeDetail.bind(ui));

    // Sort
    el('sort-select').addEventListener('change', e => { store.sort = e.target.value; ui.renderList(); });

    // Filter inputs
    el('filter-callsign').addEventListener('input', e => { store.filters.callsign = e.target.value; ui.renderList(); });
    el('filter-country').addEventListener('change', e => { store.filters.country = e.target.value; ui.renderList(); });
    el('filter-ground').addEventListener('change',  e => { store.filters.groundOnly = e.target.checked; ui.renderList(); });
    el('filter-stale').addEventListener('change',   e => { store.filters.hideStale = e.target.checked; ui.renderList(); });

    el('filter-alt-min').addEventListener('input', e => {
      store.filters.altMin = +e.target.value;
      el('alt-min-val').textContent = (+e.target.value).toLocaleString();
      ui.renderList();
    });
    el('filter-alt-max').addEventListener('input', e => {
      store.filters.altMax = +e.target.value;
      el('alt-max-val').textContent = (+e.target.value).toLocaleString();
      ui.renderList();
    });
    el('filter-spd-min').addEventListener('input', e => {
      store.filters.spdMin = +e.target.value;
      el('spd-min-val').textContent = e.target.value;
      ui.renderList();
    });
    el('filter-reset').addEventListener('click', () => {
      store.filters = { callsign:'', country:'', altMin:0, altMax:45000, spdMin:0, groundOnly:false, hideStale:true };
      el('filter-callsign').value   = '';
      el('filter-country').value    = '';
      el('filter-alt-min').value    = 0;
      el('filter-alt-max').value    = 45000;
      el('filter-spd-min').value    = 0;
      el('filter-ground').checked   = false;
      el('filter-stale').checked    = true;
      el('alt-min-val').textContent = '0';
      el('alt-max-val').textContent = '45,000';
      el('spd-min-val').textContent = '0';
      ui.renderList();
    });

    // Alert rules
    el('alert-alt-min').addEventListener('change', e => { store.alertRules.altMin = +e.target.value; });
    el('alert-spd-max').addEventListener('change', e => { store.alertRules.spdMax = +e.target.value; });
    el('alert-boundary').addEventListener('change',e => { store.alertRules.boundary = e.target.checked; });
    el('alert-enabled').addEventListener('change', e => { store.alertRules.enabled  = e.target.checked; });

    // Replay controls
    el('replay-btn').addEventListener('click', () => {
      if (!store.selectedIcao) return;
      const speed = +el('replay-speed').value;
      mapModule.replayHistory(store.selectedIcao, speed);
    });
    el('replay-stop').addEventListener('click', () => mapModule.stopReplay());

    // Tab visibility — pause polling when tab hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        isPaused = true;
      } else {
        isPaused = false;
        triggerRefresh(); // immediate refresh on tab focus
      }
    });

    // Keyboard: Escape closes panels
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        el('detail-panel').classList.add('hidden');
        el('filter-panel').classList.add('hidden');
        el('alert-panel').classList.add('hidden');
        store.selectedIcao = null;
        mapModule.stopReplay();
        ui.renderList();
      }
    });
  }

  async function boot() {
    // Init map
    mapModule.init();

    // Wire all events
    wireEvents();

    // Show loading
    ui.showLoading();

    // Initial fetch
    await fetchAndRender();

    // Start poll loop + countdown
    ui.startCountdown(CONFIG.POLL_INTERVAL_MS);
    schedulePoll();

    // Start interpolation loop
    rafId = requestAnimationFrame(rafLoop);

    ui.toast('✅ SkyTrace ATC is live — tracking aircraft', 'success', 3000);
  }

  return { boot, triggerRefresh };
})();

// ── Kick off when DOM ready ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => main.boot());
