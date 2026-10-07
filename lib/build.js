'use strict';
/* Assembles the page from parts + price data.
   Posters that arrive as base64 data URIs are pulled out into separate
   image files so the HTML stays small and the images cache on their own. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function extractPosters(research) {
  const images = new Map();
  for (const entry of Object.values(research)) {
    const src = entry.posterAsset;
    if (typeof src !== 'string' || !src.startsWith('data:')) continue;
    const m = src.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) continue;
    const ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' }[m[1].toLowerCase()];
    if (!ext) continue;
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch (e) { continue; }
    if (!buf.length) continue;
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
    images.set(name, { buf, type: m[1].toLowerCase() });
    entry.posterAsset = '/img/' + name;
  }
  return images;
}

function buildPage(research) {
  const data = JSON.parse(JSON.stringify(research));
  const images = extractPosters(data);

  /* Date the page claims for its prices.
     Deliberately the OLDEST check across priced listings, not the newest:
     one freshly-pushed listing must not make the other 84 look current. */
  const good = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const priced = Object.values(data).filter(r => (r.catalogue || []).length);
  const catDates = priced.map(r => r.catalogueCheckedAt).filter(good).sort();
  const anyDates = Object.values(data).flatMap(r => [r.catalogueCheckedAt, r.checkedAt]).filter(good).sort();
  const pool = catDates.length ? catDates : anyDates;
  const dataDate = pool[0] || new Date().toISOString().slice(0, 10);
  const newestDate = pool[pool.length - 1] || dataDate;

  const bms = read('data/bms.txt').trim();
  const district = read('data/district.txt').trim();
  if (/[`]/.test(bms + district)) throw new Error('backtick in listing table');

  let app = read('parts/app.js');
  for (const [token, val] of [['__BMS_DATA__', bms], ['__DISTRICT_DATA__', district]]) {
    if (!app.includes(token)) throw new Error('missing token ' + token);
    app = app.replace(token, () => val);
  }

  const json = JSON.stringify(data);
  if (json.includes('</script')) throw new Error('script break in price data');
  const stamp = JSON.stringify({ dataDate, newestDate, builtAt: new Date().toISOString() });

  const html = read('parts/head.html') + read('parts/body.html') +
    '\n<script>window.GG_BUILD=' + stamp + ';window.EVENT_RESEARCH=' + json + ';</script>\n' +
    '<script>\n' + app + '\n</script>\n</body>\n</html>\n';

  /* `data` is the poster-extracted copy: base64 replaced by /img/<hash> paths.
     The API serves this, never the raw research with its megabytes of base64. */
  return { html, images, dataDate, newestDate, data };
}

module.exports = { buildPage };
