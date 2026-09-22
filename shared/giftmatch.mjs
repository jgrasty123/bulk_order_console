/* ==========================================================================
   Gift matching — turns whatever a customer typed in their spreadsheet
   ("whiskey basket", "World of Whiskey", "BSKT-016") into a product.

   Confident matches are applied automatically (and shown for a quick
   check); anything ambiguous is asked once per distinct name, with the
   likeliest products first. Nothing is ever guessed silently.
   ========================================================================== */

const STOP = new Set([
  'gift', 'gifts', 'basket', 'baskets', 'set', 'box', 'crate', 'package', 'pack', 'gb',
  'for', 'him', 'her', 'men', 'man', 'guys', 'dad', 'the', 'a', 'an', 'and', 'of', 'with', 'to', 'in',
  'brobasket', 'bro', 'one'
]);
const SYNONYMS = { whisky: 'whiskey', whiskies: 'whiskey', yr: 'year', yrs: 'year', years: 'year', nonalcoholic: 'na' };

/* Title as customers should see it: drop the "| The BroBasket" store suffix. */
export const displayTitle = (t) => String(t || '').replace(/\s*\|\s*the brobasket\s*$/i, '').replace(/\s{2,}/g, ' ').trim();

export function tokens(s) {
  return displayTitle(s).toLowerCase()
    .replace(/n\/a\b/g, 'na')
    .replace(/\bnon[\s-]*alcoholic\b|\balcohol[\s-]*free\b|\bzero[\s-]*proof\b/g, 'na')
    .replace(/(\d)([a-z])/g, '$1 $2')          // "10yr" → "10 yr
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => SYNONYMS[w] || w)
    .filter((w) => !STOP.has(w));
}

function near(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && (b.startsWith(a) || a.startsWith(b))) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  // one edit apart ("od" / "old" is too short; "fashoned" / "fashioned" is not)
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function buildIndex(items) {
  return items.map((it) => ({ sku: it.sku, title: displayTitle(it.title), toks: tokens(it.title), available: it.available !== false }));
}

function score(q, t) {
  if (!q.length || !t.length) return 0;
  const hit = q.filter((w) => t.some((x) => near(w, x))).length;
  const covered = t.filter((x) => q.some((w) => near(w, x))).length;
  return 0.7 * (hit / q.length) + 0.3 * (covered / t.length);
}

/* Gifts ranked for a search box: what someone types as they look for a
   product, rather than what a spreadsheet says. Plain substring matches
   rank hardest, because typing "whis" means "show me whiskey things". */
export function rankGifts(query, index, limit = 30) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return index.slice(0, limit);
  const toks = tokens(q);
  return index
    .map((i) => {
      const title = i.title.toLowerCase();
      let s = score(toks, i.toks);
      if (title.startsWith(q)) s += 1;
      else if (title.includes(q)) s += 0.7;
      else if (title.split(/\s+/).some((w) => w.startsWith(q))) s += 0.5;
      if (i.sku.toLowerCase().includes(q)) s += 0.8;
      return { ...i, s };
    })
    .filter((i) => i.s > 0.2)
    .sort((a, b) => b.s - a.s || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * → { sku, confidence: 'exact' | 'likely' | 'unsure' | 'none', candidates: [sku…] }
 */
export function matchGift(text, index) {
  const raw = String(text || '').trim();
  if (!raw) return { sku: '', confidence: 'none', candidates: [] };

  const bySku = index.find((i) => i.sku.toLowerCase() === raw.toLowerCase());
  if (bySku) return { sku: bySku.sku, confidence: 'exact', candidates: [bySku.sku] };

  const q = tokens(raw);
  const qKey = q.join(' ');
  const same = index.filter((i) => i.toks.join(' ') === qKey);
  if (same.length === 1 && qKey) return { sku: same[0].sku, confidence: 'exact', candidates: [same[0].sku] };

  const ranked = index
    .map((i) => ({ sku: i.sku, s: score(q, i.toks) + (i.available ? 0 : -0.05) }))
    .filter((r) => r.s > 0.25)
    .sort((a, b) => b.s - a.s);
  const candidates = ranked.slice(0, 6).map((r) => r.sku);
  if (!ranked.length) return { sku: '', confidence: 'none', candidates: [] };

  const [best, second] = ranked;
  const margin = second ? best.s - second.s : 1;
  if (best.s >= 0.8 && margin >= 0.1) return { sku: best.sku, confidence: 'likely', candidates };
  // Only one product contains every word they typed (e.g. a brand name).
  const full = index.filter((i) => q.every((w) => i.toks.some((x) => near(w, x))));
  if (full.length === 1) return { sku: full[0].sku, confidence: 'likely', candidates };
  return { sku: '', confidence: 'unsure', candidates };
}
