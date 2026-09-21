/* ==========================================================================
   order-quote (public)
   Checks and prices a few recipients at a time. Everything the browser sent
   is re-checked here: the gifts must be in the catalog, the rules must pass,
   and the discount comes from the server's own rule, not the page.
   ========================================================================== */

import { json, fail, rules } from '../lib/common.mjs';
import { loadCatalog, quoteRecipient, signQuote } from '../lib/pricing.mjs';
import { rateLimited } from '../lib/guard.mjs';
import { checkRecipient, discountFor, normaliseState, clean } from '../../shared/rules.mjs';

const MAX_PER_CALL = 5;

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const limited = await rateLimited(req, 'quote', 400);
  if (limited) return limited;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const { recipients = [], batchSize } = body;

  if (!recipients.length || recipients.length > MAX_PER_CALL) {
    return json(400, { error: 'chunk', message: `Send 1 to ${MAX_PER_CALL} recipients per call.` });
  }
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < recipients.length || size > rules.limits.maxRowsPerBatch) {
    return json(400, { error: 'size', message: `Orders can have up to ${rules.limits.maxRowsPerBatch} recipients.` });
  }
  const discountPct = discountFor(size, rules);

  let catalog;
  try { catalog = new Map((await loadCatalog()).map((i) => [i.sku, i])); }
  catch (err) { return fail(err); }

  const quotes = {};
  try {
    for (const raw of recipients) {
      const r = {
        key: String(raw.key || ''),
        firstName: clean(raw.firstName), lastName: clean(raw.lastName), company: clean(raw.company),
        address1: clean(raw.address1), address2: clean(raw.address2), city: clean(raw.city),
        state: normaliseState(raw.state), zip: clean(raw.zip), phone: clean(raw.phone),
        lines: (raw.lines || []).map((l) => ({ sku: clean(l.sku), qty: Number(l.qty) }))
      };
      const issues = checkRecipient(r, rules).filter((i) => i.sev === 'stop');
      if (issues.length) { quotes[r.key] = { error: issues.map((i) => i.msg).join(' ') }; continue; }

      const missing = r.lines.find((l) => !catalog.has(l.sku));
      if (missing) { quotes[r.key] = { error: `“${missing.sku}” isn’t available for corporate orders.` }; continue; }
      r.lines = r.lines.map((l) => ({ ...l, variantId: catalog.get(l.sku).variantId, title: catalog.get(l.sku).title }));

      const q = await quoteRecipient(r, { discountPct, flatShipping: null });
      quotes[r.key] = q.error ? q : signQuote(r, q);
    }
  } catch (err) {
    return fail(err);
  }
  return json(200, { discountPct, quotes });
};
