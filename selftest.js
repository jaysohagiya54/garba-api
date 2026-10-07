'use strict';
/* Boots the server on a spare port and exercises every route. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 4187;
const TOKEN = 'test-token-' + 'x'.repeat(20);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(__dirname, 'var-selftest');

const fail = [];
const ck = (c, m) => { if (!c) fail.push(m); else console.log('  ok  ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Start from the bundled snapshot every time. A leftover prices.json would be
   loaded in preference to it (that is the server's intended behaviour on a
   deploy, but it makes this test depend on the previous run). */
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT), INGEST_TOKEN: TOKEN, DATA_DIR,
    POLL_HOURS: '0', /* no live District calls during the test */
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch (e) {}
    await sleep(250);
  }

  console.log('\n-- page --');
  const pg = await fetch(BASE + '/');
  const html = await pg.text();
  ck(pg.status === 200, 'GET / is 200');
  ck(/<title>Garba Guide/.test(html), 'page has its title');
  ck(html.includes('window.EVENT_RESEARCH'), 'price data is inlined');
  const kb = Buffer.byteLength(html) / 1024;
  console.log('      page is ' + kb.toFixed(0) + 'KB uncompressed');
  ck(kb < 900, 'page is under 900KB (posters pulled out), got ' + kb.toFixed(0) + 'KB');
  ck(!/data:image\/(jpeg|jpg|png|webp|avif);base64/i.test(html), 'no base64 photo data left in the HTML');
  /* posters are rendered by the page script, so the path lives in the data blob */
  ck(/"\/img\/[0-9a-f]{16}\.(jpg|png|webp|avif)"/.test(html), 'posters reference /img/ paths');
  ck(pg.headers.get('etag') !== null, 'page sends an ETag');

  const again = await fetch(BASE + '/', { headers: { 'if-none-match': pg.headers.get('etag') } });
  ck(again.status === 304, 'ETag revalidation returns 304');

  console.log('\n-- status --');
  const st = await (await fetch(BASE + '/api/status')).json();
  console.log('      ' + JSON.stringify(st.counts) + ' posters=' + st.posters + ' dataDate=' + st.dataDate);
  /* expectations derived from the bundled snapshot, so a price refresh cannot
     fail the suite merely by changing the counts */
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'snapshot.json'), 'utf8'));
  const rowCount = f => fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').trim().split('\n').length;
  const exp = {
    listings: rowCount('bms.txt') + rowCount('district.txt'),
    priced: Object.values(snap).filter(e => (e.catalogue || []).length).length,
    categories: Object.values(snap).reduce((n, e) => n + ((e.catalogue || []).length), 0),
    posters: Object.values(snap).filter(e => typeof e.posterAsset === 'string' && e.posterAsset.startsWith('data:')).length,
  };
  console.log('      expected from snapshot: ' + JSON.stringify(exp));
  ck(st.counts.listings === exp.listings, 'knows ' + exp.listings + ' listings, got ' + st.counts.listings);
  ck(st.counts.priced === exp.priced, 'has ' + exp.priced + ' priced listings, got ' + st.counts.priced);
  ck(st.counts.categories === exp.categories, 'has ' + exp.categories + ' categories, got ' + st.counts.categories);
  ck(st.posters === exp.posters, 'extracted ' + exp.posters + ' posters, got ' + st.posters);
  ck(st.ingestConfigured === true, 'ingest token is configured');
  ck(st.gzipBytes < st.pageBytes, 'gzip is smaller than raw (' + (st.gzipBytes / 1024).toFixed(0) + 'KB vs ' + (st.pageBytes / 1024).toFixed(0) + 'KB)');

  console.log('\n-- images --');
  const name = (html.match(/\/img\/([0-9a-f]{16}\.\w+)/) || [])[1];
  const img = await fetch(BASE + '/img/' + name);
  const bytes = Buffer.from(await img.arrayBuffer());
  ck(img.status === 200 && bytes.length > 1000, 'poster serves real bytes (' + (bytes.length / 1024).toFixed(0) + 'KB)');
  ck(/image\//.test(img.headers.get('content-type') || ''), 'poster has an image content-type');
  ck(/immutable/.test(img.headers.get('cache-control') || ''), 'poster is cached immutably');
  ck((await fetch(BASE + '/img/deadbeefdeadbeef.jpg')).status === 404, 'unknown poster is 404');

  console.log('\n-- prices api --');
  const pr = await fetch(BASE + '/api/prices');
  const prJson = await pr.json();
  ck(pr.status === 200 && prJson.build && Object.keys(prJson.research || {}).length > 20,
    '/api/prices returns {build, research} (' + Object.keys(prJson.research || {}).length + ' listings)');

  console.log('\n-- ingest auth --');
  const noAuth = await fetch(BASE + '/api/ingest', { method: 'POST', body: '{}' });
  ck(noAuth.status === 401, 'no token is rejected 401');
  const badAuth = await fetch(BASE + '/api/ingest', {
    method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  ck(badAuth.status === 401, 'wrong token is rejected 401');

  const post = (body, tok, qs) => fetch(BASE + '/api/ingest' + (qs || ''), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + (tok || TOKEN), 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  console.log('\n-- ingest validation --');
  ck((await post('not json')).status === 400, 'invalid JSON is 400');
  ck((await post({ pages: {} })).status === 422, 'empty harvest is 422 and changes nothing');
  const unknown = await post({ pages: { x: { url: 'https://evil.example/x', tiers: [{ name: 'A', price: 100 }] } } });
  ck(unknown.status === 422, 'prices for an unknown URL are ignored');

  console.log('\n-- ingest guard --');
  const oneGood = {
    pages: {
      a: { url: 'https://in.bookmyshow.com/activities/dholki-garba/ET00512260',
           tiers: [{ name: 'GUARD TEST', price: 1234 }], at: '2026-10-09T00:00:00Z' },
    },
  };
  const guard = await post(oneGood);
  const guardBody = await guard.json();
  ck(guard.status === 409, 'a one-page upload is refused as a partial run (got ' + guard.status + ')');
  ck(/partial run/.test(guardBody.error || ''), 'refusal explains itself');
  const stAfter = await (await fetch(BASE + '/api/status')).json();
  ck(stAfter.counts.priced === 85, 'refused upload left the data untouched');
  ck(stAfter.dataDate === st.dataDate, 'refused upload did not move the data date');

  const forced = await post(oneGood, TOKEN, '?force=1');
  ck(forced.status === 200, 'the same upload is accepted with ?force=1 (got ' + forced.status + ')');
  const stForced = await (await fetch(BASE + '/api/status')).json();
  ck(stForced.dataDate === st.dataDate, 'one fresh listing does NOT make the catalogue look fresh (date stays ' + stForced.dataDate + ')');
  ck(stForced.mixedDates === true, 'status flags that listings were checked on different dates');

  console.log('\n-- ingest success --');
  const real = [
    JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'garba-bulk-bookmyshow.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'garba-bulk-district.json'), 'utf8')),
  ];
  const good = await post(real);
  const goodBody = await good.json();
  ck(good.status === 200, 'a full two-platform upload is accepted (got ' + good.status + ')');
  console.log('      report ' + JSON.stringify(goodBody.report));
  ck(goodBody.report.listings === 85, 'merged 85 listings, got ' + goodBody.report.listings);
  ck(goodBody.report.cats > 200, 'the JSON-LD upload still merges, got ' + goodBody.report.cats + ' categories');
  ck(goodBody.persisted === true, 'data was written to the persist dir');
  ck(fs.existsSync(path.join(DATA_DIR, 'prices.json')), 'prices.json exists on disk');

  console.log('\n-- cors preflight (readers push cross-origin) --');
  const pre = await fetch(BASE + '/api/ingest', {
    method: 'OPTIONS',
    headers: { origin: 'https://in.bookmyshow.com', 'access-control-request-method': 'POST',
               'access-control-request-headers': 'authorization,content-type' },
  });
  ck(pre.status === 204, 'preflight returns 204 (got ' + pre.status + ')');
  ck(pre.headers.get('access-control-allow-origin') === '*', 'preflight allows the origin');
  ck(/authorization/i.test(pre.headers.get('access-control-allow-headers') || ''), 'preflight allows the Authorization header');
  const corsReply = await post({ pages: {} });
  ck(corsReply.headers.get('access-control-allow-origin') === '*', 'ingest replies are readable cross-origin');

  console.log('\n-- misc --');
  ck((await fetch(BASE + '/nope')).status === 404, 'unknown path is 404');
  ck((await fetch(BASE + '/api/prices', { method: 'DELETE' })).status === 405, 'DELETE is 405');

  console.log(fail.length ? '\nFAILURES:\n- ' + fail.join('\n- ') : '\nSERVER SELFTEST: ALL CHECKS PASSED');
  if (fail.length) console.log('\n--- server log ---\n' + serverLog);
  child.kill();
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error('selftest crashed:', e.message);
  console.error('\n--- server log ---\n' + serverLog);
  child.kill();
  process.exit(1);
});
