'use strict';
/* Validates the District parser and the merge path against live-captured data. */
const fs = require('fs');
const path = require('path');
const { parseEvent, priceOut, rates } = require('./lib/district');
const { mergeHarvest, avail } = require('./lib/merge');

const fail = [];
const ck = (c, m) => { if (!c) fail.push(m); else console.log('  ok  ' + m); };

const harvest = JSON.parse(fs.readFileSync(path.join(__dirname, 'district-live.json'), 'utf8'));
const pages = Object.values(harvest.pages);
const tiers = pages.flatMap(p => p.tiers);

console.log('-- live capture --');
ck(pages.length === 24, '24 District events captured, got ' + pages.length);
ck(tiers.length > 400, 'over 400 ticket rows, got ' + tiers.length);

console.log('\n-- published rates --');
const rated = tiers.filter(t => t.feePct != null);
const feeRates = [...new Set(rated.map(t => t.feePct))].sort((a, b) => a - b);
console.log('      fee rates: ' + feeRates.join('%, ') + '%');
ck(feeRates.length > 1, 'fee rate genuinely varies by event (a flat estimate would be wrong)');
ck(feeRates.every(r => r > 0 && r <= 25), 'every fee rate is plausible');
const gstRates = [...new Set(tiers.map(t => t.gstPct).filter(x => x != null))];
ck(gstRates.length === 1 && gstRates[0] === 18, 'GST is a consistent 18%, got ' + JSON.stringify(gstRates));

console.log('\n-- the arithmetic reconciles --');
let worst = 0, checked = 0;
for (const t of tiers) {
  if (t.total == null || t.fee == null) continue;
  checked++;
  worst = Math.max(worst, Math.abs((t.price + t.fee + (t.tax || 0)) - t.total));
}
ck(checked > 350, 'computed totals for ' + checked + ' tickets');
ck(worst < 0.02, 'price + fee + tax equals total for every ticket (worst drift ' + worst.toFixed(4) + ')');

/* spot-check one by hand against the platform's own published rates */
const spot = tiers.find(t => t.feePct === 10 && t.gstPct === 18);
if (!spot) fail.push('no 10% + 18% ticket to spot-check');
else {
  const expect = Math.round((spot.price * 1.118) * 100) / 100;
  console.log('      ' + spot.name.slice(0, 30) + ': ' + spot.price + ' @10%+18% => ' + spot.total + ' (expected ' + expect + ')');
  ck(Math.abs(spot.total - expect) < 0.02, 'a 10%+18% ticket matches price x 1.118');
}

console.log('\n-- tickets missing a published fee --');
const unrated = tiers.filter(t => t.feePct == null);
console.log('      ' + unrated.length + ' of ' + tiers.length + ' tickets publish no fee rate');
ck(unrated.every(t => t.total == null), 'tickets with no published fee get NO invented total');

console.log('\n-- availability survives the merge --');
ck(avail('Sold out') === 'Sold out', '"Sold out" maps correctly (was dropped before the fix)');
ck(avail('sold_out') === 'Sold out', '"sold_out" maps correctly');
ck(avail('SoldOut') === 'Sold out', '"SoldOut" maps correctly');
ck(avail('Available') === 'Available', '"Available" maps correctly');

console.log('\n-- merge --');
const r = f => fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').trim().split('\n');
const known = [
  ...r('bms.txt').map(l => 'https://in.bookmyshow.com/activities/' + l.split('|')[3]),
  ...r('district.txt').map(l => 'https://www.district.in/events/' + l.split('|')[3]),
];
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'snapshot.json'), 'utf8'));
const { data, report } = mergeHarvest(base, [harvest], known);
console.log('      ' + JSON.stringify(report).slice(0, 170));
ck(report.matched === 24, 'all 24 District pages matched a listing, got ' + report.matched);
ck(report.listings >= 23, 'at least 23 listings enriched, got ' + report.listings);
ck(!report.unmatched.length, 'no unmatched URLs');

const merged = Object.values(data).filter(e => (e.catalogue || []).some(c => c.total != null));
ck(merged.length >= 23, 'real totals landed on ' + merged.length + ' listings');
const sample = merged[0].catalogue.find(c => c.total != null);
console.log('      sample row: ' + JSON.stringify(sample));
ck(sample.fee != null && sample.total != null && sample.feePct != null, 'merged row keeps fee, total and the published rate');
const soldKept = Object.values(data).flatMap(e => e.catalogue || []).filter(c => c.availability === 'Sold out');
ck(soldKept.length > 0, 'sold-out tickets survive the merge (' + soldKept.length + ' rows)');

/* group passes still resolve per head */
const grp = Object.values(data).flatMap(e => e.catalogue || []).find(c => c.admits >= 10);
if (grp) {
  console.log('      group: ' + grp.name + ' = ' + grp.price + ' for ' + grp.admits + ' => ' + grp.perPerson + '/head');
  ck(grp.perPerson === Math.round(grp.price / grp.admits), 'group per-head maths intact');
}

console.log(fail.length ? '\nFAILURES:\n- ' + fail.join('\n- ') : '\nDISTRICT CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
