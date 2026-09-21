/* ==========================================================================
   quote-batch  (staff; read-only against Shopify)
   Prices each recipient at their own address. Shipping is either a flat
   amount per recipient, or — when left blank — the live carrier rate.
   ========================================================================== */

import { json, fail, denied, rules } from '../lib/common.mjs';
import { quoteRecipient } from '../lib/pricing.mjs';

const MAX_PER_CALL = 5;

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const { recipients = [], pricing = {} } = body;
  if (!recipients.length || recipients.length > MAX_PER_CALL) {
    return json(400, { error: 'chunk', message: `Send 1 to ${MAX_PER_CALL} recipients per call.` });
  }

  const discountPct = Number(pricing.discountPct) || 0;
  const flat = pricing.shippingPerRecipient === null || pricing.shippingPerRecipient === '' ||
               pricing.shippingPerRecipient === undefined ? null : Number(pricing.shippingPerRecipient);

  if (!(discountPct >= 0 && discountPct <= rules.pricing.maxDiscountPct)) {
    return json(400, { error: 'discount', message: `Discount must be 0–${rules.pricing.maxDiscountPct}%.` });
  }
  if (flat !== null && !(flat >= 0)) {
    return json(400, { error: 'shipping', message: 'Shipping per recipient must be 0 or more, or blank for live rates.' });
  }

  const quotes = {};
  try {
    for (const r of recipients) quotes[r.key] = await quoteRecipient(r, { discountPct, flatShipping: flat });
  } catch (err) {
    return fail(err);
  }
  return json(200, { currencyCode: rules.pricing.currencyCode, quotes });
};
