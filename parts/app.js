'use strict';
/* ============================================================
   Garba Guide — Ahmedabad Navratri 2026
   Official rates only: every price is the pass price as published
   by BookMyShow / District. No fees are added or estimated.
   ============================================================ */

/* ---------- source tables: name|venue|price|path|flag ---------- */
const bmsRaw = `__BMS_DATA__`;
const districtRaw = `__DISTRICT_DATA__`;
const research = window.EVENT_RESEARCH || {};
const BUILD = window.GG_BUILD || {};
const DATA_DATE = BUILD.dataDate || null;
const STALE_AFTER_DAYS = 2;

/* ---------- helpers ---------- */
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const fmtDate = (iso, opt) => /^\d{4}-\d{2}-\d{2}$/.test(iso)
  ? new Intl.DateTimeFormat('en-IN', Object.assign({ timeZone: 'UTC' }, opt)).format(new Date(iso + 'T12:00:00Z'))
  : String(iso);

/* ---------- nights ---------- */
const isoDay = d => '2026-10-' + String(d).padStart(2, '0');
const ALL_NIGHTS = [];
for (let d = 7; d <= 21; d++) ALL_NIGHTS.push(isoDay(d));
const nightNo = iso => {
  const n = Number(iso.slice(-2)) - 10;
  return n >= 1 && n <= 9 ? n : null;
};
function parseDateText(t) {
  if (!t) return null;
  const s = String(t);
  let m = s.match(/(\d{1,2})\s*[–—-]\s*(\d{1,2})\s*Oct/i);
  if (m) { const out = []; for (let d = +m[1]; d <= +m[2]; d++) out.push(isoDay(d)); return out; }
  m = s.match(/(\d{1,2})\s*Oct\s*onwards/i);
  if (m) { const out = []; for (let d = +m[1]; d <= 21; d++) out.push(isoDay(d)); return out; }
  m = s.match(/(\d{1,2})\s*Oct/i);
  if (m) return [isoDay(+m[1])];
  return null;
}

/* ---------- build the catalogue ---------- */
function rows(raw, map) {
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(map);
}
const data = [
  ...rows(bmsRaw, line => {
    const [name, venue, price, path, onwards] = line.split('|');
    return { name, venue, listed: price ? Number(price) : null, onwards: onwards === '1',
      platform: 'BookMyShow', dateText: null, url: 'https://in.bookmyshow.com/activities/' + path };
  }),
  ...rows(districtRaw, line => {
    const [name, venue, price, path, dateText] = line.split('|');
    return { name, venue, listed: price ? Number(price) : null, onwards: !!price,
      platform: 'District', dateText, url: 'https://www.district.in/events/' + path };
  })
].map((d, i) => {
  d.id = i;
  const r = research[d.url] || {};
  d.r = r;
  d.sessions = (r.sessions || []).filter(s => s.date);
  const catPrices = d.sessions.flatMap(s => (s.categories || []).map(c => c.price)).filter(p => typeof p === 'number');
  /* event-level category list, read from the platform's own listing data */
  d.catalogue = (r.catalogue || []).filter(c => typeof c.price === 'number');
  d.catSource = r.catalogueSource || null;
  d.catCount = d.sessions.reduce((n, s) => n + ((s.categories || []).length), 0) || d.catalogue.length;
  /* cheapest genuine single entry. Group passes only count divided by party size,
     and never become the headline when a real single exists. */
  const singles = d.catalogue.filter(c => !c.admits).map(c => c.price).concat(catPrices);
  const perHead = d.catalogue.map(c => c.perPerson || c.price);
  if (singles.length) { d.base = Math.min(...singles); d.baseIsDivided = false; }
  else if (perHead.length) { d.base = Math.min(...perHead); d.baseIsDivided = true; }
  else { d.base = d.listed; d.baseIsDivided = false; }
  d.official = singles.length > 0 || perHead.length > 0;
  d.spread = perHead.length ? [Math.min(...perHead), Math.max(...perHead)] : null;
  d.soldOut = d.catalogue.filter(c => c.availability === 'Sold out').length;
  d.allSoldOut = d.catalogue.length > 0 && d.soldOut === d.catalogue.length;
  d.onwards = d.onwards || catPrices.length > 1 || d.catalogue.length > 1;
  const sessionDates = [...new Set(d.sessions.map(s => s.date))].sort();
  d.nights = sessionDates.length ? sessionDates : (parseDateText(d.dateText) || []);
  d.nightsKnown = d.nights.length > 0;
  d.poster = r.posterAsset || r.posterUrl || null;
  return d;
});
const priceOf = d => (d.base === null || d.base === undefined) ? null : d.base;

/* ---------- state ---------- */
let budget = 6000, activeBand = null, activeNight = null, onlyFav = false;
let visible = [], activeEvent = null, activeDate = null, activeSession = null, lastFocus = null;
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem('gg-favs') || '[]')); } catch (e) {}
const saveFavs = () => { try { localStorage.setItem('gg-favs', JSON.stringify([...favs])); } catch (e) {} };
try {
  const t = localStorage.getItem('gg-theme');
  if (t) document.documentElement.dataset.theme = t;
} catch (e) {}

const BANDS = [
  { lo: 0,    hi: 499,   label: 'Budget',  sub: 'Under ₹500' },
  { lo: 500,  hi: 999,   label: 'Easy',    sub: '₹500–999' },
  { lo: 1000, hi: 1999,  label: 'Mid',     sub: '₹1,000–1,999' },
  { lo: 2000, hi: 3999,  label: 'Premium', sub: '₹2,000–3,999' },
  { lo: 4000, hi: 1e9,   label: 'Splurge', sub: '₹4,000 and up' }
];

/* ---------- how old is this data? ---------- */
const CHECKED = DATA_DATE ? fmtDate(DATA_DATE, { day: 'numeric', month: 'long', year: 'numeric' }) : 'an earlier date';
function dataAgeDays() {
  if (!DATA_DATE) return null;
  const then = new Date(DATA_DATE + 'T12:00:00Z').getTime();
  return Math.floor((Date.now() - then) / 86400000);
}
function paintStaleness() {
  const age = dataAgeDays();
  const stamp = $('dateStamp');
  if (stamp) {
    stamp.innerHTML = age === null ? ''
      : `Prices as checked on <b>${esc(CHECKED)}</b>${age <= 0 ? ' · today' : age === 1 ? ' · yesterday' : ` · ${age} days ago`}`;
  }
  const bar = $('staleBar');
  if (!bar) return;
  if (age === null || age <= STALE_AFTER_DAYS) { bar.hidden = true; return; }
  bar.hidden = false;
  $('staleText').innerHTML = `<b>This price list is ${age} days old.</b> It was checked on ${esc(CHECKED)} and does not update by itself — phases sell out and organisers revise rates during Navratri. Treat these as a guide and confirm the current price on the official listing before you pay.`;
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ---------- petals ---------- */
(function petals() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = $('petals');
  const n = innerWidth < 720 ? 9 : 17;
  const kinds = ['', 'm', 't'];
  let html = '';
  for (let i = 0; i < n; i++) {
    const left = Math.round(Math.random() * 100);
    const dur = (11 + Math.random() * 13).toFixed(1);
    const delay = (Math.random() * -24).toFixed(1);
    const size = (9 + Math.random() * 9).toFixed(0);
    html += `<span class="petal ${kinds[i % 3]}" style="left:${left}%;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
  }
  host.innerHTML = html;
})();

/* ---------- posters ---------- */
function posterHTML(d, big) {
  if (d.poster) {
    return `<img src="${esc(d.poster)}" alt="${esc(d.name)} poster" ${big ? '' : 'loading="lazy"'} decoding="async" data-fb="${d.id}">`;
  }
  return fallbackHTML(d);
}
function fallbackHTML(d) {
  return `<span class="fallback"><span class="mo" aria-hidden="true">✹</span><span class="fn">${esc(d.name)}</span><small>artwork unavailable</small></span>`;
}
function wireFallbacks(root) {
  root.querySelectorAll('img[data-fb]').forEach(img => img.addEventListener('error', () => {
    const d = data[Number(img.dataset.fb)];
    const span = document.createElement('span');
    span.innerHTML = fallbackHTML(d);
    img.replaceWith(span.firstElementChild);
  }, { once: true }));
}

/* ---------- night chips ---------- */
function renderNights() {
  const chips = ALL_NIGHTS.map(iso => {
    const n = nightNo(iso);
    const count = data.filter(d => d.nights.includes(iso)).length;
    if (!count && !n) return '';
    return `<button class="night-chip" data-night="${iso}" aria-pressed="${activeNight === iso}">
      ${fmtDate(iso, { day: 'numeric', month: 'short' })}<i>${n ? 'Night ' + n : fmtDate(iso, { weekday: 'short' })}</i></button>`;
  }).join('');
  $('nights').innerHTML = `<button class="night-chip" data-night="" aria-pressed="${activeNight === null}">All 9 nights<i>&amp; pre-events</i></button>` + chips;
}

/* ---------- bands ---------- */
function renderBands() {
  const priced = data.map(priceOf).filter(p => p !== null);
  const max = Math.max(1, ...BANDS.map(b => priced.filter(p => p >= b.lo && p <= b.hi).length));
  $('bands').innerHTML = BANDS.map((b, i) => {
    const c = priced.filter(p => p >= b.lo && p <= b.hi).length;
    return `<button class="band" data-band="${i}" aria-pressed="${activeBand === i}" style="--w:${Math.round(c / max * 100)}%">
      <span class="bl">${b.label}</span><span class="bv tnum">${c}</span><span class="bn">${b.sub}</span><span class="bar"></span></button>`;
  }).join('');
}

/* ---------- cards ---------- */
function cardHTML(d) {
  const p = priceOf(d);
  const nightTxt = d.nightsKnown
    ? (d.nights.length > 1
        ? fmtDate(d.nights[0], { day: 'numeric', month: 'short' }) + ' – ' + fmtDate(d.nights[d.nights.length - 1], { day: 'numeric', month: 'short' })
        : fmtDate(d.nights[0], { weekday: 'short', day: 'numeric', month: 'short' }))
    : 'Dates on listing';
  const catTags = (() => {
    const fromSessions = d.sessions.flatMap(s => (s.categories || []).map(c => c.name));
    const names = [...new Set(fromSessions.length ? fromSessions : d.catalogue.map(c => c.name))].slice(0, 3);
    return names.length ? `<span class="cats">${names.map(n => `<span>${esc(n.replace(/\.$/, ''))}</span>`).join('')}</span>` : '';
  })();
  const spread = d.spread && d.spread[1] > d.spread[0]
    ? `${inr(d.spread[0])} – ${inr(d.spread[1])} per head`
    : null;
  const priceBlock = p === null
    ? `<span class="allin"><span class="amt" style="font-size:19px">Price not published</span></span>
       <span class="plabel">Check the official listing</span>`
    : `<span class="allin"><span class="amt tnum">${inr(p)}</span>${d.onwards ? '<span class="ow">onwards</span>' : ''}</span>
       <span class="plabel">${d.official
          ? `${d.baseIsDivided ? 'per head in a group' : 'cheapest single entry'} <span class="est v">official rate</span>`
          : `advertised starting price <span class="est">as listed</span>`}</span>
       ${spread ? `<span class="plabel tnum">${spread}</span>` : ''}`;
  const meta = d.catalogue.length
    ? `${d.catalogue.length} categor${d.catalogue.length === 1 ? 'y' : 'ies'}${d.soldOut ? ' · ' + d.soldOut + ' sold out' : ''}`
    : (d.catCount ? `${d.catCount} categories priced` : 'Nights &amp; categories');
  return `<article class="card${d.allSoldOut ? ' gone' : ''}" data-id="${d.id}">
    <button class="fav" data-fav="${d.id}" aria-pressed="${favs.has(d.id)}" aria-label="Shortlist ${esc(d.name)}">${favs.has(d.id) ? '♥' : '♡'}</button>
    <button class="media" data-open="${d.id}" aria-haspopup="dialog" aria-label="Open ${esc(d.name)} details">
      ${posterHTML(d)}
      <span class="plat ${d.platform === 'District' ? 'd' : 'b'}">${d.platform}</span>
      ${d.allSoldOut ? '<span class="ribbon">sold out</span>' : ''}
      <span class="card-nights">◉ ${esc(nightTxt)}</span>
    </button>
    <button class="body" data-open="${d.id}">
      <span class="title">${esc(d.name)}</span>
      <span class="venue">${esc(d.venue || 'Venue to be announced')}</span>
      ${catTags}
    </button>
    <button class="pricebox" data-open="${d.id}">${priceBlock}</button>
    <button class="go" data-open="${d.id}">${meta} →</button>
  </article>`;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const plat = $('platform').value;
  const sort = $('sort').value;

  visible = data.filter(d => {
    if (plat !== 'all' && d.platform !== plat) return false;
    if (onlyFav && !favs.has(d.id)) return false;
    if (q && !(d.name + ' ' + d.venue).toLowerCase().includes(q)) return false;
    if (activeNight && d.nightsKnown && !d.nights.includes(activeNight)) return false;
    const p = priceOf(d);
    if (activeBand !== null) {
      if (p === null) return false;
      const b = BANDS[activeBand];
      if (p < b.lo || p > b.hi) return false;
    } else if (budget < 6000) {
      if (p === null) return false;
      if (p > budget) return false;
    }
    return true;
  });

  visible.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'detail') return (b.catCount - a.catCount) || a.name.localeCompare(b.name);
    const pa = priceOf(a), pb = priceOf(b);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return sort === 'high' ? pb - pa : pa - pb;
  });

  const dated = activeNight ? visible.filter(d => d.nightsKnown) : visible;
  const undated = activeNight ? visible.filter(d => !d.nightsKnown) : [];
  let html = dated.map(cardHTML).join('');
  if (undated.length) {
    html += `<div class="group-head"><h3>${undated.length} more &mdash; nights not published, likely running</h3><span class="ln"></span></div>` + undated.map(cardHTML).join('');
  }
  if (!visible.length) {
    html = `<div class="empty"><span class="mo">✹</span><h3>Nothing matches</h3>
      <p>No pass fits every filter you have on. Widen the budget, pick another night, or start over.</p>
      <button class="btn btn-gold" data-rm-all type="button">Clear all filters</button></div>`;
  }
  $('cards').innerHTML = html;
  wireFallbacks($('cards'));
  reveal();

  const priced = visible.map(priceOf).filter(p => p !== null);
  $('resultCount').innerHTML = `<b>${visible.length}</b> of ${data.length} listings${priced.length ? ` &middot; from <b>${inr(Math.min(...priced))}</b> to <b>${inr(Math.max(...priced))}</b>` : ''}`;
  const officialN = data.filter(d => d.official).length;
  const rows = data.reduce((n, d) => n + d.catalogue.length, 0);
  $('feeSummary').innerHTML = `Official rates for <b>${officialN}</b> of ${data.length} listings &middot; <b>${rows}</b> pass categories &middot; no booking fees included`;
  bumpFit();
  renderBands();
  renderChips();
}

function reveal() {
  const cards = $('cards').querySelectorAll('.card');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cards.forEach(c => c.classList.add('in')); return; }
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const i = Number(en.target.dataset.i || 0);
      setTimeout(() => en.target.classList.add('in'), (i % 10) * 45);
      obs.unobserve(en.target);
    });
  }, { rootMargin: '80px' });
  cards.forEach((c, i) => { c.dataset.i = i; io.observe(c); });
}

/* ---------- budget readouts ---------- */
function bumpFit() {
  const n = $('fitCount');
  if (n.textContent !== String(visible.length)) {
    n.textContent = visible.length;
    n.classList.remove('bump');
    void n.offsetWidth;
    n.classList.add('bump');
  }
  $('fitText').textContent = activeBand !== null
    ? `passes in the ${BANDS[activeBand].label.toLowerCase()} band`
    : (budget >= 6000 ? 'passes in the whole catalogue' : 'passes fit your budget');
}
function paintSlider() {
  const el = $('budget');
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--pct', pct + '%');
  $('budgetLabel').textContent = Number(el.value) >= 6000 ? '₹6,000+' : inr(el.value);
}

/* ---------- stats ---------- */
function stats() {
  const priced = data.map(priceOf).filter(p => p !== null);
  $('stCount').textContent = data.length;
  $('stLow').textContent = inr(Math.min(...priced));
  $('stCats').textContent = data.reduce((n, d) => n + d.catalogue.length, 0) || data.reduce((n, d) => n + d.catCount, 0);
  $('catCoverage').textContent = data.filter(d => d.official).length;
}

/* ---------- modal ---------- */
const dlg = $('eventDialog');
function openEvent(id) {
  const d = data[id];
  if (!d) return;
  lastFocus = document.activeElement;
  activeEvent = d;
  const dates = [...new Set(d.sessions.map(s => s.date))].sort();
  activeDate = dates[0] || null;
  activeSession = d.sessions.find(s => s.date === activeDate) || null;
  $('mPoster').innerHTML = posterHTML(d, true);
  wireFallbacks($('mPoster'));
  $('mPlat').textContent = d.platform;
  $('mPlat').className = 'plat ' + (d.platform === 'District' ? 'd' : 'b');
  $('dialogTitle').textContent = d.name;
  $('mVenue').textContent = d.venue || 'Venue to be announced';
  $('mLink').href = d.url;
  $('mLink').textContent = 'Open on ' + d.platform + ' ↗';
  $('mChecked').textContent = `Checked ${CHECKED}. ${d.nightsKnown ? 'Nights: ' + d.nights.map(x => fmtDate(x, { day: 'numeric' })).join(', ') + ' Oct.' : 'Nights are not published on this listing.'}`;
  $('dateList').innerHTML = dates.map(iso => `<button class="dbtn" data-date="${iso}" aria-pressed="${iso === activeDate}">
      <span class="dd">${fmtDate(iso, { weekday: 'short' })}</span><span class="dn">${fmtDate(iso, { day: 'numeric' })}</span><span class="dm">${fmtDate(iso, { month: 'short' })}</span></button>`).join('');
  $('mIntro').textContent = dates.length
    ? 'Pick a night to see every pass category checked for that session.'
    : (d.catalogue.length
        ? `${d.catalogue.length} pass categories at official rates, cheapest first.`
        : 'Category prices are not published on this listing — the advertised price and official link are below.');
  renderSession();
  if (!dlg.open) dlg.showModal();
  $('closeDialog').focus();
}

/* One category row. The headline stays the official pass rate so the two
   platforms remain comparable; where the platform publishes its own fee, the
   real breakdown follows underneath. Nothing here is ever estimated. */
function catRowHTML(c, i, fallbackStatus) {
  const status = c.availability || fallbackStatus || '';
  const sold = /sold.?out|unavailable/i.test(String(status));
  const per = c.admits ? Math.round(c.price / c.admits) : null;
  const det = Array.isArray(c.details) ? c.details.join(' ') : String(c.details || '');
  const hasReal = typeof c.total === 'number' && typeof c.fee === 'number';
  const line = (label, val) => val === null || val === undefined ? ''
    : `<span><i>${label}</i><b class="tnum">${inr(val)}</b></span>`;
  const realBlock = !hasReal ? '' : `<div class="breakdown">
      ${line('Pass price', c.price)}
      ${line('Convenience fee' + (c.feePct ? ' (' + c.feePct + '%)' : ''), c.fee)}
      ${c.tax ? line('GST on fee' + (c.gstPct ? ' (' + c.gstPct + '%)' : ''), c.tax) : ''}
      <span class="tot"><i>You pay</i><b class="tnum">${inr(c.total)}</b></span>
      ${c.admits ? `<span><i>Per person</i><b class="tnum">${inr(Math.round(c.total / c.admits))}</b></span>` : ''}
    </div>
    <div class="sub" style="margin-top:5px"><span class="est v">platform published</span>${
      c.tax ? '' : ' <span class="est">no GST published</span>'}</div>`;
  return `<div class="cat ${sold ? 'sold' : ''}" style="animation-delay:${Math.min(i, 12) * 45}ms">
    <div><div class="catname">${esc(c.name || 'Pass category')}</div>
      ${status ? `<span class="catstatus">${esc(status)}</span>` : ''}
      ${c.admits ? `<span class="catstatus" style="background:rgba(157,107,255,.18);color:#c4a6ff">admits ${c.admits}</span>` : ''}
      ${c.maxPerOrder ? `<span class="catstatus" style="background:var(--panel-2);color:var(--ink-faint)">max ${c.maxPerOrder} per order</span>` : ''}</div>
    <div class="catprice">
      <div class="big tnum">${typeof c.price === 'number' ? inr(c.price) : 'Not shown'}</div>
      <div class="sub">${c.admits
        ? `for ${c.admits} · ≈<b class="tnum">${inr(per)}</b> each`
        : 'per person, official rate'}</div>
      ${realBlock}
    </div>
    ${det ? `<div class="catdet">${esc(det)}</div>` : ''}
  </div>`;
}

function renderSession() {
  const d = activeEvent;
  const day = d.sessions.filter(s => s.date === activeDate);
  $('sessTitle').textContent = activeDate ? fmtDate(activeDate, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Pass categories';
  /* with no per-night sessions the heading above already says it; drop the row */
  $('sessHead').hidden = !day.length;
  const wrap = $('timeWrap'), sel = $('sessionTime');
  wrap.hidden = day.length < 2;
  sel.innerHTML = day.map((s, i) => `<option value="${i}">${esc(s.time || 'Session ' + (i + 1))}</option>`).join('');
  sel.value = String(Math.max(0, day.indexOf(activeSession)));
  $('sessHint').textContent = activeSession && activeSession.time ? 'Doors ' + activeSession.time : '';

  const cats = (activeSession && activeSession.categories) || [];
  if (cats.length) {
    $('catList').innerHTML = cats.map((c, i) => catRowHTML(c, i, c.status)).join('');
  } else if (d.catalogue.length) {
    $('catList').innerHTML =
      `<p class="msub">Every pass category on this listing, at the rate ${esc(d.platform)} publishes. These apply to the event rather than to one night — confirm your night on the official page.</p>`
      + d.catalogue.map((c, i) => catRowHTML(c, i)).join('');
  } else {
    $('catList').innerHTML = `<div class="unavail">
      <h4>${activeDate ? 'Categories not checked for this night' : 'Category prices not published'}</h4>
      <p>${esc((activeSession && (activeSession.blockedReason || activeSession.status)) || d.r.blockedReason || 'This listing does not publish a category breakdown. Choose your night and tier on the official page.')}</p>
      ${d.base !== null ? `<p style="margin-top:12px;color:var(--ink)">Advertised from <b class="tnum" style="color:var(--gold)">${inr(d.base)}</b>${d.onwards ? ' onwards' : ''}.</p>` : ''}
    </div>`;
  }
  $('sessNote').textContent = 'Headline prices are official pass rates, so the two platforms compare like for like. Where a platform publishes its own convenience fee and GST, the full breakdown and the real amount payable are shown under that category. Where it does not, fees are still charged at checkout on top. Quantity, couple and group rules follow each category’s own description.';
}
function closeEvent() { if (dlg.open) dlg.close(); }

/* ---------- events ---------- */
$('cards').addEventListener('click', e => {
  if (e.target.closest('[data-rm-all]')) { $('resetBtn').click(); return; }
  const f = e.target.closest('[data-fav]');
  if (f) {
    const id = Number(f.dataset.fav);
    favs.has(id) ? favs.delete(id) : favs.add(id);
    saveFavs();
    f.setAttribute('aria-pressed', favs.has(id));
    f.textContent = favs.has(id) ? '♥' : '♡';
    updateTray();
    if (onlyFav) render();
    return;
  }
  const o = e.target.closest('[data-open]');
  if (o) openEvent(Number(o.dataset.open));
});
$('closeDialog').onclick = closeEvent;
dlg.addEventListener('click', e => {
  if (e.target !== dlg) return;
  const b = dlg.getBoundingClientRect();
  if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) closeEvent();
});
dlg.addEventListener('close', () => { if (lastFocus) lastFocus.focus(); });
$('dateList').addEventListener('click', e => {
  const b = e.target.closest('[data-date]');
  if (!b) return;
  activeDate = b.dataset.date;
  activeSession = activeEvent.sessions.find(s => s.date === activeDate) || null;
  $('dateList').querySelectorAll('[data-date]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.date === activeDate)));
  renderSession();
});
$('sessionTime').addEventListener('change', e => {
  activeSession = activeEvent.sessions.filter(s => s.date === activeDate)[Number(e.target.value)];
  renderSession();
});
$('nights').addEventListener('click', e => {
  const b = e.target.closest('[data-night]');
  if (!b) return;
  activeNight = b.dataset.night || null;
  renderNights();
  render();
});
$('bands').addEventListener('click', e => {
  const b = e.target.closest('[data-band]');
  if (!b) return;
  const i = Number(b.dataset.band);
  activeBand = activeBand === i ? null : i;
  render();
});
let searchTimer;
$('search').addEventListener('input', () => { paintSearch(); clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
$('platform').addEventListener('change', render);
$('sort').addEventListener('change', render);
$('budget').addEventListener('input', () => {
  budget = Number($('budget').value);
  activeBand = null;
  paintSlider();
  render();
});
$('resetBtn').onclick = () => {
  activeBand = null; activeNight = null; onlyFav = false; budget = 6000;
  $('budget').value = 6000; $('search').value = ''; $('platform').value = 'all'; $('sort').value = 'low';
  paintSlider(); paintSearch(); renderNights(); render(); updateTray();
  toast('Filters cleared');
};
$('surpriseBtn').onclick = () => {
  const pool = visible.length ? visible : data;
  openEvent(pool[Math.floor(Math.random() * pool.length)].id);
};
$('themeBtn').onclick = () => {
  const day = document.documentElement.dataset.theme === 'day';
  document.documentElement.dataset.theme = day ? 'night' : 'day';
  $('themeBtn').textContent = day ? '☽' : '☀';
  try { localStorage.setItem('gg-theme', day ? 'night' : 'day'); } catch (e) {}
};
if (document.documentElement.dataset.theme === 'day') $('themeBtn').textContent = '☀';
addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheet.classList.contains('open')) { openSheet(false); return; }
  if (e.key === '/' && document.activeElement !== $('search') && !dlg.open) { e.preventDefault(); $('search').focus(); }
});
addEventListener('scroll', () => {
  $('hdr').classList.toggle('lift', scrollY > 12);
  $('toTop').classList.toggle('on', scrollY > 700);
}, { passive: true });
$('toTop').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });

/* ---------- search clear ---------- */
function paintSearch() {
  $('searchWrap').classList.toggle('has', $('search').value.length > 0);
}
$('searchClear').onclick = () => {
  $('search').value = '';
  paintSearch(); render();
  $('search').focus();
};

/* ---------- filter sheet (phones) ---------- */
const sheet = $('controls'), scrim = $('ctlScrim');
function openSheet(on) {
  sheet.classList.toggle('open', on);
  scrim.classList.toggle('on', on);
  $('filterBtn').setAttribute('aria-expanded', String(on));
  document.body.style.overflow = on ? 'hidden' : '';
}
$('filterBtn').onclick = () => openSheet(!sheet.classList.contains('open'));
$('sheetDone').onclick = () => openSheet(false);
scrim.onclick = () => openSheet(false);

/* ---------- active filters ---------- */
function activeFilters() {
  const out = [];
  const q = $('search').value.trim();
  if (q) out.push({ k: 'q', label: '“' + q + '”' });
  if ($('platform').value !== 'all') out.push({ k: 'plat', label: $('platform').value });
  if (activeNight) out.push({ k: 'night', label: fmtDate(activeNight, { day: 'numeric', month: 'short' }) });
  if (activeBand !== null) out.push({ k: 'band', label: BANDS[activeBand].label + ' · ' + BANDS[activeBand].sub });
  else if (budget < 6000) out.push({ k: 'budget', label: 'under ' + inr(budget) });
  if (onlyFav) out.push({ k: 'fav', label: 'shortlist only' });
  return out;
}
function renderChips() {
  const f = activeFilters();
  $('filterBtn').dataset.n = String(f.length);
  $('activeChips').innerHTML = f.length
    ? f.map(x => `<button class="achip" data-rm="${x.k}" type="button" aria-label="Remove filter ${esc(x.label)}">${esc(x.label)}<span class="x" aria-hidden="true">×</span></button>`).join('')
      + (f.length > 1 ? '<button class="achip clear" data-rm="all" type="button">Clear all</button>' : '')
    : '';
}
$('activeChips').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  const k = b.dataset.rm;
  if (k === 'q' || k === 'all') { $('search').value = ''; paintSearch(); }
  if (k === 'plat' || k === 'all') $('platform').value = 'all';
  if (k === 'night' || k === 'all') { activeNight = null; renderNights(); }
  if (k === 'band' || k === 'all') activeBand = null;
  if (k === 'budget' || k === 'all') { budget = 6000; $('budget').value = 6000; paintSlider(); }
  if (k === 'fav' || k === 'all') onlyFav = false;
  render(); updateTray();
});

/* ---------- shortlist tray ---------- */
function updateTray() {
  const t = $('tray');
  const picked = data.filter(d => favs.has(d.id));
  t.classList.toggle('on', picked.length > 0);
  $('trayCount').textContent = picked.length;
  const priced = picked.map(priceOf).filter(p => p !== null);
  $('trayText').innerHTML = picked.length
    ? `shortlisted${priced.length ? ` &middot; cheapest <b>${inr(Math.min(...priced))}</b>` : ''}`
    : 'shortlisted';
  $('trayShow').textContent = onlyFav ? 'Show all events' : 'Show only these';
}
$('trayShow').onclick = () => { onlyFav = !onlyFav; render(); updateTray(); };
$('trayClear').onclick = () => { favs.clear(); saveFavs(); onlyFav = false; render(); updateTray(); toast('Shortlist cleared'); };

/* ---------- CSV ---------- */
$('exportBtn').onclick = () => {
  const head = ['Event', 'Venue', 'Platform', 'Nights', 'Session time', 'Category',
    'Admits', 'Official price INR', 'Per person INR', 'Availability', 'Source URL'];
  const recs = visible.flatMap(d => {
    const nightCol = d.nightsKnown ? d.nights.join(' ') : 'not published';
    if (d.sessions.length) {
      return d.sessions.flatMap(s => {
        const cats = (s.categories && s.categories.length) ? s.categories : [{ name: 'not checked', price: null, status: s.blockedReason || '' }];
        return cats.map(c => [d.name, d.venue, d.platform, s.date, s.time || '', c.name,
          c.admits || 1, c.price ?? '', c.admits ? Math.round(c.price / c.admits) : (c.price ?? ''),
          c.availability || c.status || '', d.url]);
      });
    }
    if (d.catalogue.length) {
      return d.catalogue.map(c => [d.name, d.venue, d.platform, nightCol, '', c.name,
        c.admits || 1, c.price, c.admits ? c.perPerson : c.price, c.availability || '', d.url]);
    }
    return [[d.name, d.venue, d.platform, nightCol, '', 'starting price only', 1,
      d.base ?? '', d.base ?? '', '', d.url]];
  });
  const qq = v => '"' + String(v).replaceAll('"', '""') + '"';
  const csv = '﻿' + [head, ...recs].map(r => r.map(qq).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'ahmedabad-navratri-2026-official-rates.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV downloaded — ' + recs.length + ' rows');
};

/* ---------- marquee ---------- */
(function mq() {
  const names = data.slice(0, 26).map(d => `<span>${esc(d.name)} <em>${d.base !== null ? inr(d.base) : '—'}</em></span>`).join('');
  $('mq').innerHTML = names + names;
})();

/* ---------- go ---------- */
$('budget').value = 6000;
paintSlider();
renderNights();
stats();
render();
updateTray();
paintSearch();
paintStaleness();
