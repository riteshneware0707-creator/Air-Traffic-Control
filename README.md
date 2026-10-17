# SkyTrace ATC — Air Traffic Monitoring Dashboard

A real-time air traffic monitoring dashboard built with vanilla JavaScript, Leaflet.js, and the OpenSky Network REST API. No build step required — open `index.html` directly in any modern browser.

---

## Live Demo

Open `index.html` in Chrome, Edge, or Firefox. No server needed.

---

## Architecture

```
Air traffic Control/
├── index.html   — App shell (CDN imports: Leaflet 1.9, Leaflet.Draw, Font Awesome)
├── style.css    — Dark ATC design system (custom properties, responsive)
└── script.js    — Full application logic (6 self-contained modules)
    ├── CONFIG   — Constants, region presets, unit-conversion helpers
    ├── STATE    — Aircraft store (Map<icao24→entry>) + RingBuffer history
    ├── API      — OpenSky fetch, retry, circuit-breaker, localStorage cache
    ├── MAP      — Leaflet map, SVG plane markers, trail polylines, draw tool
    ├── UI       — Stats bar, aircraft list, detail panel, filters, toasts
    └── MAIN     — Boot sequence, 15 s poll loop, rAF interpolation, event wiring
```

### State Management

Aircraft state is held in a central `store.aircraft` Map keyed by ICAO24 address. Each entry contains:

```js
{
  icao24, callsign, originCountry,
  lat, lon, baroAlt, velocity, heading, verticalRate,
  onGround, squawk, lastSeen, isStale,
  altFt, spdKt,                          // pre-converted
  history: RingBuffer(20),               // last 20 observations
  _updated,                              // internal timestamp for staleness
}
```

On every API response, `store.upsert()` merges the new state vector, pushes a history point, and `store.reconcile()` marks or removes aircraft that did not appear in the response.

`store.filtered()` returns a lazily computed, filtered+sorted array that drives both the map and the sidebar list — no duplication.

---

## API Integration

**Endpoint:** `GET https://opensky-network.org/api/states/all?lamin=…&lomin=…&lamax=…&lomax=…`

- **Anonymous access** — No API key required for read-only use.
- **CORS handling** — The app first attempts a direct fetch. If CORS is blocked by the browser, it retries through `corsproxy.io` automatically.
- **Poll interval:** 15 seconds (OpenSky refreshes state vectors every ~10 s; 15 s is a safe, respectful cadence).
- **Tab visibility:** Polling is paused when the browser tab is hidden and resumes immediately on tab focus.

### Retry Strategy

```
Attempt 1 → 2 → 3 (max retries)
Wait:     1s → 2s → 4s  (exponential back-off)
```

On HTTP 429 (rate limit), the app backs off for 60 seconds and shows a warning toast.

---

## Handling Stale Data, API Failures & Rate Limits

| Scenario | Behaviour |
|---|---|
| Aircraft not in response for **> 90 s** | Marked `isStale = true`, icon turns red, dimmed in list |
| Aircraft not in response for **> 5 min** | Removed from store and map entirely |
| Any API error (network, 5xx, timeout) | Failure counter incremented; cached data shown with orange banner |
| **3 consecutive failures** | Circuit-breaker opens: API paused for 60 s, cached data served |
| HTTP **429 rate limit** | 60 s back-off + warning toast; no further requests during cooldown |
| **Tab hidden** | Polling suspended; single refresh on tab restore |
| Last successful response | Persisted to `localStorage` (LRU, expires after 60 min) |
| No cache available offline | Empty state UI shown, map remains interactive |

---

## Features

### Required
1. ✅ Live aircraft positions via OpenSky Network API
2. ✅ Interactive Leaflet map with custom rotated SVG plane icons
3. ✅ Altitude, velocity, heading, vertical rate, squawk, last-seen in detail panel
4. ✅ 15-second smart polling with debounced manual refresh
5. ✅ Region presets (India, Europe, USA, SE Asia, World) + custom draw-on-map bounding box
6. ✅ `store.reconcile()` tracks aircraft entering/leaving; stale/remove thresholds
7. ✅ Circuit-breaker, retry, 429 back-off, localStorage cache, stale indicators
8. ✅ Detail panel with altitude sparkline + replay of stored history positions

### Bonus
- ✅ **Position interpolation** — `requestAnimationFrame` advances each aircraft's lat/lon using `velocity × Δt × heading` (great-circle calculation) between API updates
- ✅ **Historical movement replay** — Animate the aircraft moving through its stored history on the map at 1×/2×/5× speed
- ✅ **Rendering optimisation** — Leaflet `L.canvas()` renderer + marker pool (markers reused, not recreated every tick)
- ✅ **Offline / cached mode** — `localStorage` fallback activates automatically on failure
- ✅ **Alert system** — Configurable low-altitude and high-speed alerts; region entry/exit notifications
- ✅ **Request caching** — `localStorage` LRU cache (60-min TTL); circuit-breaker prevents redundant failing requests

---

## Map Controls

| Control | Action |
|---|---|
| Click plane icon | Open popup with summary; click "Inspect" for full detail |
| Click aircraft in list | Open detail panel + fly map to aircraft |
| Draw rectangle | Set custom query region (replaces preset) |
| Region dropdown | Switch to a preset geographic region |
| Escape key | Close all panels |

---

## Filters

Open the **filter panel** (≡ Sliders icon) to:
- Search by callsign (live, no re-fetch)
- Filter by origin country
- Set min/max altitude slider (0–45,000 ft)
- Set minimum speed
- Toggle "On-Ground only" or "Hide Stale"

---

## Tech Stack

| Concern | Technology |
|---|---|
| Framework | Vanilla JavaScript (ES2020, no bundler) |
| Map | Leaflet 1.9 + Leaflet.Draw |
| Tiles | CartoDB Dark Matter (free, attribution-only) |
| Styling | Custom CSS with design tokens |
| State | Custom Map-based store with ring-buffer history |
| API | OpenSky Network REST API (anonymous) |
| Cache | `localStorage` (JSON, 60-min TTL) |
| Icons | Font Awesome 6 (CDN) |

---

## Known Limitations

- OpenSky anonymous API rate-limits browsers to ~1 request per 10 s. The 15 s poll interval respects this.
- Some aircraft may have `null` positions when transponders are blocked or data is unavailable.
- CORS proxy (`corsproxy.io`) is a public service — for production, deploy a lightweight server-side proxy (Node/Express ~10 lines) and set `CONFIG.PROXY` to your own endpoint.
- Aircraft type (e.g., Boeing 737) is not available in the OpenSky state vectors API; the detail panel shows ICAO24 and callsign instead.
