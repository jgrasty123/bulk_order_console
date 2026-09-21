/* Gift-name matching against real BroBasket product names (fixture taken
   from the live catalog). Guards the rule that matters most: when a name is
   ambiguous we ask; we never silently guess a basket. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, matchGift } from '../shared/giftmatch.mjs';

const items = JSON.parse(readFileSync(new URL('./fixtures-catalog.json', import.meta.url)));
const idx = buildIndex(items);
const title = (sku) => idx.find((i) => i.sku === sku).title;
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const m = (t) => matchGift(t, idx);

console.log('\nGift matching (real product names)');
ok(title(m('world of whiskey').sku) === 'A World of Whiskey Gift Basket', 'partial name matches');
ok(title(m('BSKT-065'.toLowerCase()).sku || m('Coffee Lovers Gift').sku).startsWith('Coffee Lovers'), 'SKU (any case) or exact name matches');
ok(title(m('hennessy').sku).startsWith('Hennessy'), 'a brand with one product matches on its own');
ok(title(m('Laphroaig 10 year whisky').sku).startsWith('Laphroaig'), '"10 year whisky" matches "10Yr ... Whiskey"');
ok(title(m('jack daniels gentleman jack').sku).startsWith("Jack Daniel's"), 'apostrophes and small typos tolerated');
const wb = m('whiskey basket');
ok(wb.confidence === 'unsure' && !wb.sku && wb.candidates.length >= 3, 'ambiguous "whiskey basket" asks, never guesses');
const cl = m('Coffee Lovers');
ok(!cl.sku && cl.candidates.slice(0, 2).every((s) => /coffee lovers/i.test(title(s))), 'several "Coffee Lovers" products → ask, best ones first');
ok(/n\/a/i.test(title(m('non alcoholic beer').candidates[0])), '"non alcoholic beer" suggests the N/A products first');
ok(m('').confidence === 'none' && m('zzqx').sku === '', 'nonsense never matches');
console.log(`\n${n} matching checks passed.\n`);
