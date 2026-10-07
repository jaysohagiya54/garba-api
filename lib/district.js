'use strict';
/* District prices, straight from the platform's own public event API.
 *
 * Unlike BookMyShow, this endpoint answers plain server-side requests, so the
 * Render service can refresh District on its own. The API publishes the
 * convenience fee and GST rates per ticket, so these totals are the platform's
 * own arithmetic rather than an estimate.
 */
const ENDPOINT = 'https://www.district.in/gw/consumer/events/v1/event/getBySlug/';
const HEADERS = {
  accept: '*/*',
  'content-type': 'application/json',
  platform: 'district_web, district_web',
  'x-app-type': 'ed_web',
  'x-device-platform': 'district_web',
  'x-device-platform-type': 'desktopWeb',
  'x-device-os-type': 'windows',
  'x-event-state-config': 'true',
  /* The API only checks that this header is present, not what it holds — any
     string returns 200. It is a placeholder, not anyone's session token. */
  'x-guest-token': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
};

const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*[\d.]+\s*$/.test(v)) return Number(v);
  return null;
};

/* Rates arrive as fractions (0.1 = 10%). GST is a list of components
   (CGST 9% + SGST 9%) and applies to the convenience fee. */
function rates(item) {
  const feePct = num(item.convenience_fee_percentage);
  const gstParts = Array.isArray(item.gst) ? item.gst : [];
  const gstPct = gstParts.reduce((n, g) => n + (num(g && g.percent) || 0), 0);
  const extraTax = (Array.isArray(item.taxes) ? item.taxes : [])
    .reduce((n, t) => n + (num(t && t.percent) || 0), 0);
  return {
    feePct: feePct === null ? null : feePct,
    gstPct: gstPct || null,
    taxPct: extraTax || null,
    gstNames: gstParts.map(g => g && g.name).filter(Boolean),
  };
}

function priceOut(price, r, deliveryCharges) {
  if (price === null) return null;
  const fee = r.feePct === null ? null : price * r.feePct;
  const gst = fee !== null && r.gstPct ? fee * r.gstPct : null;
  const tax = r.taxPct ? price * r.taxPct : null;
  const delivery = num(deliveryCharges) || 0;
  if (fee === null) return null;
  const total = price + fee + (gst || 0) + (tax || 0) + delivery;
  return {
    fee: Math.round(fee * 100) / 100,
    tax: Math.round(((gst || 0) + (tax || 0)) * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

const STATE = {
  sold_out: 'Sold out', soldout: 'Sold out', unavailable: 'Sold out',
  available: 'Available', active: 'Available',
  coming_soon: 'Coming soon', sale_ended: 'Sale ended', expired: 'Sale ended',
};

/* Pull every ticket item out of one event payload. */
function parseEvent(payload) {
  const d = (payload && payload.data) || {};
  const shows = (d.venue && Array.isArray(d.venue.shows)) ? d.venue.shows : [];
  const rows = [];
  const dates = [];
  for (const show of shows) {
    if (show && show.date_string) dates.push(String(show.date_string));
    for (const group of (Array.isArray(show.items_for_sale) ? show.items_for_sale : [])) {
      for (const item of (Array.isArray(group.items) ? group.items : [])) {
        if (!item || item.is_hidden) continue;
        const name = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : '';
        const price = num(item.price);
        if (!name || price === null || price <= 0) continue;
        const r = rates(item);
        const out = priceOut(price, r, item.delivery_charges);
        const row = { name, price };
        const st = STATE[String(item.item_state || '').toLowerCase()];
        if (st) row.availability = st;
        if (out) { row.fee = out.fee; row.tax = out.tax; row.total = out.total; }
        if (r.feePct !== null) row.feePct = Math.round(r.feePct * 10000) / 100;
        if (r.gstPct) row.gstPct = Math.round(r.gstPct * 10000) / 100;
        if (typeof item.description === 'string' && item.description.trim()) {
          row.details = item.description.replace(/\s+/g, ' ').trim().slice(0, 400);
        }
        const maxQ = num(item.max_purchase_amount);
        if (maxQ && maxQ > 1) row.maxPerOrder = maxQ;
        rows.push(row);
      }
    }
  }
  return { name: d.name ? String(d.name).trim() : null, slug: d.slug || null, rows, dates };
}

async function fetchEvent(slug, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(ENDPOINT + encodeURIComponent(slug), { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!body || body.result !== 'ok') throw new Error('unexpected result: ' + (body && body.result));
    return parseEvent(body);
  } finally {
    clearTimeout(t);
  }
}

/* Walk every District listing, politely. Returns a harvest in the same shape
   the browser readers push, so it goes through the ordinary merge path. */
async function harvestDistrict(listings, opts) {
  const o = opts || {};
  const gap = o.gapMs == null ? 1200 : o.gapMs;
  const log = o.log || (() => {});
  const pages = {};
  const report = { attempted: 0, ok: 0, failed: 0, rows: 0, feeRates: {}, errors: [] };

  for (const l of listings) {
    report.attempted++;
    try {
      const ev = await fetchEvent(l.slug, o.timeoutMs);
      pages[l.url] = {
        url: l.url, platform: 'District', name: ev.name || l.name,
        tiers: ev.rows.map(r => Object.assign({ path: '$.district' }, r)),
        dates: ev.dates, at: new Date().toISOString(),
      };
      report.ok++;
      report.rows += ev.rows.length;
      for (const r of ev.rows) {
        if (r.feePct != null) report.feeRates[r.feePct] = (report.feeRates[r.feePct] || 0) + 1;
      }
      log('ok ' + l.slug + ' (' + ev.rows.length + ' tickets)');
    } catch (e) {
      report.failed++;
      report.errors.push(l.slug + ': ' + e.message);
      log('FAIL ' + l.slug + ' ' + e.message);
    }
    if (gap) await new Promise(r => setTimeout(r, gap));
  }
  return { harvest: { pages }, report };
}

module.exports = { harvestDistrict, fetchEvent, parseEvent, priceOut, rates, ENDPOINT };
