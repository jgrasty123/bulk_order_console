/* ==========================================================================
   create-batch  (staff)
   Saves a quoted batch and creates its parent invoice — or, for a test
   batch, marks it ready to release with no invoice.
   ========================================================================== */

import { json, fail, denied, rules, BATCH_ID_RE } from '../lib/common.mjs';
import { buildBatch, createBatchWithInvoice } from '../lib/batches.mjs';
import { EMAIL_RE } from '../../shared/rules.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const { id, test = false, buyer = {}, pricing = {}, recipients = [] } = body;

  if (!BATCH_ID_RE.test(id || '')) return json(400, { error: 'id', message: 'Bad batch id.' });
  if (!recipients.length) return json(400, { error: 'empty', message: 'No recipients.' });
  if (recipients.length > rules.limits.maxRowsPerBatch) return json(400, { error: 'size', message: 'Batch is over the recipient limit.' });
  if (!test && !EMAIL_RE.test(buyer.email || '')) return json(400, { error: 'buyer', message: 'A buyer email is required to send the invoice.' });
  for (const r of recipients) {
    if (!r.quote || !r.quote.cents) return json(400, { error: 'unquoted', message: `Recipient ${r.firstName} ${r.lastName} has no quote.` });
    if (!r.lines || !r.lines.every((l) => l.variantId && Number(l.qty) > 0)) {
      return json(400, { error: 'lines', message: `Recipient ${r.firstName} ${r.lastName} has an unresolved item.` });
    }
  }

  try {
    const batch = buildBatch({
      id, test, source: 'staff', buyer,
      pricing: {
        discountPct: Number(pricing.discountPct) || 0,
        shipping: pricing.shippingPerRecipient === null || pricing.shippingPerRecipient === '' ||
                  pricing.shippingPerRecipient === undefined ? 'live' : Number(pricing.shippingPerRecipient)
      },
      recipients
    });
    await createBatchWithInvoice(batch);
    return json(200, { batch });
  } catch (err) {
    if (err.status) return json(err.status, { error: 'create', message: err.message });
    return fail(err);
  }
};
