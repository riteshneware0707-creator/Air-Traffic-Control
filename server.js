/**
 * SkyTrace ATC — Lightweight Local Proxy Server
 * 
 * Provides:
 * 1. Static file serving (index.html, style.css, script.js)
 * 2. Server-side proxy for OpenSky Network API (solves browser CORS restrictions)
 * 3. 10-second response caching (protects against OpenSky 429 rate limits)
 * 4. Optional authentication support via OPENSKY_USERNAME / OPENSKY_PASSWORD
 * 
 * Usage:
 *   node server.js
 *   Open http://localhost:3000 in your browser
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const OPENSKY_USER = process.env.OPENSKY_USERNAME || '';
const OPENSKY_PASS = process.env.OPENSKY_PASSWORD || '';

// In-memory cache: bbox_query -> { data, timestamp }
const cache = new Map();
const CACHE_TTL_MS = 10000; // 10 seconds cache

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;

  // Handle CORS Preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. API Proxy Endpoint: /api/states/all
  if (pathname === '/api/states/all') {
    handleOpenSkyProxy(parsedUrl.query, res);
    return;
  }

  // 2. Static File Serving
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  
  // Security check: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

/**
 * Proxies request to OpenSky API with caching and optional basic auth
 */
function handleOpenSkyProxy(query, clientRes) {
  const queryStr = new URLSearchParams(query).toString();
  const cacheKey = queryStr;
  const now = Date.now();

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    clientRes.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Data-Source': 'server-cache',
    });
    clientRes.end(cached.data);
    return;
  }

  const targetUrl = `https://opensky-network.org/api/states/all?${queryStr}`;
  const options = {
    headers: {
      'User-Agent': 'SkyTrace-ATC/1.0',
    },
  };

  if (OPENSKY_USER && OPENSKY_PASS) {
    const auth = Buffer.from(`${OPENSKY_USER}:${OPENSKY_PASS}`).toString('base64');
    options.headers['Authorization'] = `Basic ${auth}`;
  }

  https.get(targetUrl, options, (openSkyRes) => {
    let body = '';

    openSkyRes.on('data', (chunk) => { body += chunk; });
    openSkyRes.on('end', () => {
      if (openSkyRes.statusCode === 200) {
        // Cache successful response
        cache.set(cacheKey, { data: body, timestamp: Date.now() });
        clientRes.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Data-Source': 'opensky-live',
        });
        clientRes.end(body);
      } else if (openSkyRes.statusCode === 429 && cached) {
        // Rate limited — serve stale cache if available
        clientRes.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Data-Source': 'server-stale-cache',
        });
        clientRes.end(cached.data);
      } else {
        clientRes.writeHead(openSkyRes.statusCode, { 'Content-Type': 'application/json' });
        clientRes.end(body || JSON.stringify({ error: `OpenSky returned HTTP ${openSkyRes.statusCode}` }));
      }
    });
  }).on('error', (err) => {
    if (cached) {
      clientRes.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Data-Source': 'server-offline-cache',
      });
      clientRes.end(cached.data);
    } else {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Failed to reach OpenSky Network', details: err.message }));
    }
  });
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  ✈️  SkyTrace ATC — Server running at:`);
  console.log(`      http://localhost:${PORT}`);
  console.log(`  📡  OpenSky Proxy Endpoint active at:`);
  console.log(`      http://localhost:${PORT}/api/states/all`);
  console.log(`======================================================\n`);
});
