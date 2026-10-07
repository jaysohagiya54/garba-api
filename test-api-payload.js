'use strict';
/* Checks what /api/prices hands to a UI hosted on another origin (Vercel). */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 4199;
const PUBLIC = 'https://garba-api.onrender.com';
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(__dirname, 'var-apitest');
const fail = [];
const ck = (c, m) => { if (!c) fail.push(m); else console.log('  ok  ' + m); };

try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT), INGEST_TOKEN: 'test', DATA_DIR, POLL_HOURS: '0', PUBLIC_URL: PUBLIC,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {}
    await sleep(250);
  }

  console.log('-- payload size --');
  const res = await fetch(BASE + '/api/prices');
  const text = await res.text();
  const kb = Buffer.byteLength(text) / 1024;
  console.log('      ' + kb.toFixed(0) + 'KB');
  ck(res.status === 200, '/api/prices is 200');
  ck(kb < 300, 'payload is small: ' + kb.toFixed(0) + 'KB (raw data is 3.3MB)');
  ck(!text.includes('base64'), 'no base64 poster data in the payload');
  ck(res.headers.get('access-control-allow-origin') === '*', 'readable cross-origin from Vercel');
  ck(/max-age/.test(res.headers.get('cache-control') || ''), 'payload is cacheable');

  const j = JSON.parse(text);
  console.log('\n-- shape matches the static prices.json --');
  ck(j.build && j.build.dataDate, 'has build.dataDate (' + (j.build || {}).dataDate + ')');
  ck(j.research && typeof j.research === 'object', 'has research object');
  const vals = Object.values(j.research);
  const cats = vals.flatMap(e => e.catalogue || []);
  console.log('      ' + vals.length + ' listings, ' + cats.length + ' category rows, ' +
    cats.filter(c => c.total != null).length + ' with real totals');
  ck(cats.length > 300, 'category rows present: ' + cats.length);
  ck(cats.filter(c => c.total != null).length > 100, 'real published totals present');

  console.log('\n-- posters work from another origin --');
  const abs = vals.map(e => e.posterAsset).filter(u => typeof u === 'string' && u.startsWith('http'));
  ck(abs.length === 17, 'all 17 posters are absolute URLs, got ' + abs.length);
  ck(abs.every(u => u.startsWith(PUBLIC + '/img/')), 'every poster URL uses PUBLIC_URL');
  const one = abs[0].replace(PUBLIC, BASE);
  const img = await fetch(one);
  const bytes = img.ok ? (await img.arrayBuffer()).byteLength : 0;
  ck(img.ok && bytes > 1000, 'a poster is served (' + (bytes / 1024).toFixed(0) + 'KB from ' + one.split('/img/')[1] + ')');
  ck(/image\//.test(img.headers.get('content-type') || ''), 'poster has an image content-type');

  console.log('\n-- etag revalidation --');
  const et = res.headers.get('etag');
  ck(et, '/api/prices sends an ETag');
  const again = await fetch(BASE + '/api/prices', { headers: { 'if-none-match': et } });
  ck(again.status === 304, 'repeat request returns 304, got ' + again.status);

  console.log('\n-- relative paths when PUBLIC_URL is unset --');
  child.kill();
  await sleep(400);
  const c2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT + 1), INGEST_TOKEN: 't', DATA_DIR, POLL_HOURS: '0' }),
    stdio: 'ignore',
  });
  const B2 = 'http://127.0.0.1:' + (PORT + 1);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(B2 + '/healthz')).ok) break; } catch (e) {}
    await sleep(250);
  }
  const j2 = await (await fetch(B2 + '/api/prices')).json();
  const rel = Object.values(j2.research).map(e => e.posterAsset).filter(u => typeof u === 'string' && u.startsWith('/img/'));
  ck(rel.length === 17, 'posters stay relative without PUBLIC_URL, got ' + rel.length);
  c2.kill();

  console.log(fail.length ? '\nFAILURES:\n- ' + fail.join('\n- ') : '\nAPI PAYLOAD CHECKS PASSED');
  if (fail.length) console.log('\n--- server log ---\n' + log);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error('crashed:', e.message);
  console.error(log);
  child.kill();
  process.exit(1);
});
