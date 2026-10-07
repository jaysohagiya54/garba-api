'use strict';
/* Garba Guide — public site + price ingest API. Zero dependencies.
 *
 * This server never contacts BookMyShow or District. It cannot: both refuse
 * datacenter requests. Prices arrive by POST from a signed-in browser.
 *
 *   GET  /              the page, built from the newest data it holds
 *   GET  /img/<file>    posters, extracted out of the data
 *   GET  /api/prices    the raw price data
 *   GET  /api/status    data date, age, counts
 *   POST /api/ingest    accepts a bulk-reader export  (Bearer INGEST_TOKEN)
 *   GET  /healthz
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { buildPage } = require('./lib/build');
const { mergeHarvest } = require('./lib/merge');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.INGEST_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'var');
/* Absolute base for poster URLs handed to a UI on another origin (Vercel). */
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const DATA_FILE = path.join(DATA_DIR, 'prices.json');
const SNAPSHOT = path.join(__dirname, 'data', 'snapshot.json');
const MAX_BODY = 40 * 1024 * 1024;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- listing tables: the set of URLs we accept prices for ---------- */
const listingUrls = (() => {
  const r = f => fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').trim().split('\n');
  return [
    ...r('bms.txt').map(l => 'https://in.bookmyshow.com/activities/' + l.split('|')[3]),
    ...r('district.txt').map(l => 'https://www.district.in/events/' + l.split('|')[3]),
  ];
})();

/* ---------- state ---------- */
let prices = {};
let page = { html: '', gzip: null, etag: '', dataDate: null };
let images = new Map();

function loadPrices() {
  for (const src of [DATA_FILE, SNAPSHOT]) {
    try {
      const raw = fs.readFileSync(src, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        log('loaded prices from', src);
        return parsed;
      }
    } catch (e) { /* try the next source */ }
  }
  log('WARNING: no price data found; serving an empty catalogue');
  return {};
}

function wirePayload(built) {
  const data = built.data;
  if (PUBLIC_URL) {
    for (const e of Object.values(data)) {
      if (typeof e.posterAsset === 'string' && e.posterAsset.startsWith('/img/')) {
        e.posterAsset = PUBLIC_URL + e.posterAsset;
      }
    }
  }
  return JSON.stringify({
    build: { dataDate: built.dataDate, newestDate: built.newestDate, builtAt: new Date().toISOString() },
    research: data,
  });
}

function rebuild() {
  const built = buildPage(prices);
  const html = Buffer.from(built.html, 'utf8');
  page = {
    html,
    gzip: zlib.gzipSync(html, { level: 6 }),
    etag: '"' + crypto.createHash('sha1').update(html).digest('hex').slice(0, 20) + '"',
    dataDate: built.dataDate,
    newestDate: built.newestDate,
    wire: Buffer.from(wirePayload(built), 'utf8'),
  };
  images = built.images;
  log('rebuilt page:', (html.length / 1024).toFixed(0) + 'KB raw,',
    (page.gzip.length / 1024).toFixed(0) + 'KB gzip,',
    images.size, 'posters, data date', built.dataDate);
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(prices));
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (e) {
    log('persist failed:', e.message);
    return false;
  }
}

/* ---------- helpers ---------- */
function send(req, res, status, body, type, extra) {
  const headers = Object.assign({
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }, extra || {});
  let out = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  if (!headers['content-encoding'] && out.length > 1400 && /text|json|javascript/.test(type)
      && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    out = zlib.gzipSync(out, { level: 6 });
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = out.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}
const json = (req, res, status, obj, extra) =>
  send(req, res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8',
    Object.assign({ 'access-control-allow-origin': '*' }, extra || {}));

function ageDays(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d + 'T12:00:00Z').getTime()) / 86400000);
}
function counts() {
  const vals = Object.values(prices);
  const cats = vals.reduce((n, r) => n + ((r.catalogue || []).length), 0);
  return { listings: listingUrls.length, priced: vals.filter(r => (r.catalogue || []).length).length, categories: cats };
}

/* crude per-IP throttle on ingest */
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 600000) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 500) hits.clear();
  return rec.n > 12;
}

function readBody(req, cb) {
  let len = 0;
  const chunks = [];
  req.on('data', c => {
    len += c.length;
    if (len > MAX_BODY) { req.destroy(); return cb(new Error('body too large')); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', e => cb(e));
}

/* ---------- ingest ---------- */
function handleIngest(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  if (!TOKEN) return json(req, res, 503, { error: 'INGEST_TOKEN is not configured on the server' });
  const auth = req.headers.authorization || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const ok = given.length === TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(given.padEnd(TOKEN.length, '\0')), Buffer.from(TOKEN));
  if (!ok) { log('ingest rejected from', ip); return json(req, res, 401, { error: 'bad token' }); }
  if (throttled(ip)) return json(req, res, 429, { error: 'too many uploads, wait a few minutes' });

  readBody(req, (err, buf) => {
    if (err) return json(req, res, 413, { error: err.message });
    let payload;
    try { payload = JSON.parse(buf.toString('utf8')); }
    catch (e) { return json(req, res, 400, { error: 'invalid JSON' }); }

    const payloads = Array.isArray(payload) ? payload : [payload];
    const before = counts();
    let merged;
    try { merged = mergeHarvest(prices, payloads, listingUrls); }
    catch (e) { log('merge threw:', e.message); return json(req, res, 500, { error: 'merge failed' }); }

    if (!merged.report.listings) {
      return json(req, res, 422, { error: 'no priced listings in that upload, nothing changed', report: merged.report });
    }

    /* A partial push is almost always an interrupted reader run. Merging is additive,
       so it cannot delete anything, but it does overwrite those listings and skew the
       data date, so refuse it unless explicitly forced. */
    const candidate = merged.data;
    const force = url.searchParams.get('force') === '1';
    if (!force && before.priced > 10 && merged.report.listings < before.priced * 0.5) {
      return json(req, res, 409, {
        error: 'upload covers only ' + merged.report.listings + ' of ' + before.priced + ' priced listings; refused as a partial run',
        hint: 'let both platform readers finish before pushing, or POST to /api/ingest?force=1 to accept a partial update',
        report: merged.report,
      });
    }

    const prev = prices;
    prices = candidate;
    try { rebuild(); }
    catch (e) { prices = prev; rebuild(); log('rebuild failed, rolled back:', e.message); return json(req, res, 500, { error: 'rebuild failed, data rolled back' }); }
    const saved = persist();
    log('ingest ok from', ip, JSON.stringify(merged.report));
    json(req, res, 200, { ok: true, persisted: saved, before, after: counts(), dataDate: page.dataDate, report: merged.report });
  });
}

/* ---------- routes ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  /* The readers push from in.bookmyshow.com / district.in, so the browser
     sends a preflight for the Authorization header. The bearer token is the
     actual authentication; the origin is not trusted for anything. */
  if (req.method === 'OPTIONS') {
    return send(req, res, 204, '', 'text/plain', {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
  }

  if (req.method === 'POST' && p === '/api/ingest') return handleIngest(req, res, url);
  if (req.method === 'POST' && p === '/api/poll-district') {
    const a = req.headers.authorization || '';
    if (!TOKEN || a !== 'Bearer ' + TOKEN) return json(req, res, 401, { error: 'bad token' });
    if (polling) return json(req, res, 409, { error: 'a poll is already running' });
    pollDistrict('manual');
    return json(req, res, 202, { ok: true, note: 'poll started, watch /api/status' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(req, res, 405, { error: 'method not allowed' });
  }

  if (p === '/healthz') return send(req, res, 200, 'ok', 'text/plain; charset=utf-8');

  if (p === '/api/status') {
    return json(req, res, 200, {
      dataDate: page.dataDate, ageDays: ageDays(page.dataDate),
      newestDate: page.newestDate, mixedDates: page.newestDate !== page.dataDate,
      lastDistrictPoll: lastPoll, pollHours: POLL_HOURS,
      counts: counts(), posters: images.size,
      pageBytes: page.html.length, gzipBytes: page.gzip ? page.gzip.length : null,
      ingestConfigured: !!TOKEN, persistDir: DATA_DIR,
    }, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  }

  if (p === '/api/prices') {
    if (req.headers['if-none-match'] === page.etag + '-p') { res.writeHead(304); return res.end(); }
    return send(req, res, 200, page.wire, 'application/json; charset=utf-8', {
      'cache-control': 'public, max-age=300, must-revalidate',
      'access-control-allow-origin': '*',
      etag: page.etag + '-p',
    });
  }

  if (p.startsWith('/img/')) {
    const name = path.posix.basename(p);
    const img = images.get(name);
    if (!img) return send(req, res, 404, 'not found', 'text/plain; charset=utf-8');
    if (req.headers['if-none-match'] === '"' + name + '"') { res.writeHead(304); return res.end(); }
    return send(req, res, 200, img.buf, img.type, {
      'cache-control': 'public, max-age=31536000, immutable',
      etag: '"' + name + '"',
    });
  }

  if (p === '/') {
    if (req.headers['if-none-match'] === page.etag) { res.writeHead(304, { etag: page.etag }); return res.end(); }
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = wantsGzip ? page.gzip : page.html;
    return send(req, res, 200, body, 'text/html; charset=utf-8', Object.assign({
      'cache-control': 'public, max-age=120, must-revalidate',
      etag: page.etag,
    }, wantsGzip ? { 'content-encoding': 'gzip' } : {}));
  }

  send(req, res, 404, 'not found', 'text/plain; charset=utf-8');
});

/* ---------- District refreshes itself; BookMyShow cannot ----------
   District's event API answers plain server-side requests, so we poll it here.
   BookMyShow sits behind a Cloudflare challenge and is fed by the browser
   reader pushing to /api/ingest. */
const POLL_HOURS = Number(process.env.POLL_HOURS || 12);
const districtListings = (() => {
  try { return require('./data/district-slugs.json'); } catch (e) { return []; }
})();
let polling = false;
let lastPoll = null;

async function pollDistrict(reason) {
  if (polling || !districtListings.length) return;
  polling = true;
  const started = Date.now();
  try {
    const { harvestDistrict } = require('./lib/district');
    const { harvest, report } = await harvestDistrict(districtListings, { gapMs: 1200 });
    lastPoll = { at: new Date().toISOString(), reason, ...report, errors: report.errors.slice(0, 5) };
    if (!report.ok) { log('district poll (' + reason + ') got nothing:', report.errors.slice(0, 2).join(' | ')); return; }
    const merged = mergeHarvest(prices, [harvest], listingUrls);
    if (!merged.report.listings) { log('district poll merged nothing'); return; }
    const prev = prices;
    prices = merged.data;
    try { rebuild(); }
    catch (e) { prices = prev; rebuild(); log('district poll rebuild failed, rolled back:', e.message); return; }
    persist();
    log('district poll (' + reason + ') ok:', JSON.stringify(merged.report),
      ((Date.now() - started) / 1000).toFixed(0) + 's');
  } catch (e) {
    log('district poll threw:', e.message);
    lastPoll = { at: new Date().toISOString(), reason, error: e.message };
  } finally {
    polling = false;
  }
}

prices = loadPrices();
rebuild();
if (!TOKEN) log('NOTE: INGEST_TOKEN unset — POST /api/ingest will refuse everything');
server.listen(PORT, () => {
  log('listening on ' + PORT + ' (data dir ' + DATA_DIR + ')');
  if (POLL_HOURS > 0 && districtListings.length) {
    log('district auto-refresh every ' + POLL_HOURS + 'h (' + districtListings.length + ' listings)');
    setTimeout(() => pollDistrict('boot'), 15000);
    setInterval(() => pollDistrict('schedule'), POLL_HOURS * 3600 * 1000).unref?.();
  }
});
