'use strict';
/* Folds a bulk-reader export into the price data.
   Pure: takes the current data plus harvest payloads, returns new data + a report. */

const ENT = { amp: '&', '#38': '&', quot: '"', '#34': '"', '#39': "'", apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’' };
const decode = s => String(s)
  .replace(/&(?:amp;)?([a-z]+|#\d+);/gi, (m, g) => (ENT[g.toLowerCase()] !== undefined ? ENT[g.toLowerCase()] : m))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
/* How many people does this pass admit?
   Deliberately NOT matching "N entry" — "PHASE 2 ENTRY ONLY" is one person. */
function partySize(name) {
  const n = String(name).toLowerCase();
  let m = n.match(/group\s*of\s*(\d{1,3})/) || n.match(/(\d{1,3})\s*(?:people|person|pax|persons|members)\b/);
  if (m && +m[1] > 1 && +m[1] <= 100) return +m[1];
  m = n.match(/group\s*of\s*([a-z]+)/);
  if (m && WORDS[m[1]]) return WORDS[m[1]];
  if (/\bcouple\b|\bduo\b|\btwo\s*person/.test(n)) return 2;
  if (/\bfamily\b/.test(n)) return 4;
  return 1;
}
const avail = v => {
  const s = String(v || '').toLowerCase();
  /* matches "SoldOut", "sold_out" and "sold out" alike */
  if (/sold[\s_-]?out/.test(s)) return 'Sold out';
  if (/sale[\s_-]?ended|expired/.test(s)) return 'Sale ended';
  if (/coming[\s_-]?soon/.test(s)) return 'Coming soon';
  if (/instock|available/.test(s)) return 'Available';
  if (/preorder|presale/.test(s)) return 'Pre-sale';
  if (/limited/.test(s)) return 'Limited';
  return null;
};

function mergeHarvest(current, payloads, knownUrls) {
  const data = JSON.parse(JSON.stringify(current));
  const known = new Set(knownUrls);
  const rep = { pages: 0, matched: 0, listings: 0, cats: 0, group: 0, soldOut: 0, unmatched: [], empty: [] };

  for (const payload of payloads) {
    const pages = (payload && payload.pages) || {};
    for (const [key, p] of Object.entries(pages)) {
      rep.pages++;
      if (!p || p.error) continue;
      const url = p.url || key;
      if (!known.has(url)) { rep.unmatched.push(url); continue; }
      rep.matched++;

      const seen = new Map();
      for (const t of (p.tiers || [])) {
        if (!t || !t.name || typeof t.price !== 'number' || t.price <= 0 || t.price > 1e6) continue;
        const name = decode(t.name);
        if (!name || name.length > 90) continue;
        const k = name.toLowerCase() + '|' + t.price;
        if (seen.has(k)) continue;
        const qty = partySize(name);
        const row = { name, price: t.price };
        const a = avail(t.availability);
        if (a) row.availability = a;
        if (qty > 1) { row.admits = qty; row.perPerson = Math.round(t.price / qty); }
        if (typeof t.fee === 'number') row.fee = t.fee;
        if (typeof t.tax === 'number') row.tax = t.tax;
        if (typeof t.total === 'number') row.total = t.total;
        /* published rates and copy, kept so the page can show real arithmetic */
        if (typeof t.feePct === 'number') row.feePct = t.feePct;
        if (typeof t.gstPct === 'number') row.gstPct = t.gstPct;
        if (typeof t.maxPerOrder === 'number') row.maxPerOrder = t.maxPerOrder;
        if (typeof t.details === 'string' && t.details.trim()) {
          /* descriptions arrive with markup; the page escapes text, so strip it here */
          const plain = decode(t.details.replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, ' '))
            .replace(/\s*·\s*(·\s*)+/g, ' · ').replace(/^[\s·•]+|[\s·•]+$/g, '').trim();
          if (plain) row.details = plain.slice(0, 400);
        }
        seen.set(k, row);
      }
      const cats = [...seen.values()].sort((a, b) => (a.perPerson || a.price) - (b.perPerson || b.price));
      if (!cats.length) { rep.empty.push(url); continue; }

      const entry = data[url] || (data[url] = { url });
      entry.catalogue = cats;
      entry.catalogueSource = 'platform structured data';
      entry.catalogueCheckedAt = (typeof p.at === 'string' ? p.at.slice(0, 10) : '') || new Date().toISOString().slice(0, 10);
      rep.listings++;
      rep.cats += cats.length;
      rep.group += cats.filter(c => c.admits).length;
      rep.soldOut += cats.filter(c => c.availability === 'Sold out').length;
    }
  }
  return { data, report: rep };
}

module.exports = { mergeHarvest, partySize, decode, avail };
