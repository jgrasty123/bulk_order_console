/* send-receipt (staff) — email the "payment received" receipt for a paid
   batch, with the paid PDF invoice link. Sent automatically once when the
   payment lands; this is for resending, or for batches paid before the
   automatic receipt existed. Optional `to` sends a copy elsewhere (a test
   to yourself, or straight to the buyer's AP inbox). */

import { json, fail, denied, loadBatch, updateMarker, loadMarker } from '../lib/common.mjs';
import { sendPaymentReceipt } from '../lib/batches.mjs';
import { EMAIL_RE } from '../../shared/rules.mjs';

const PAID = new Set(['paid', 'releasing', 'released', 'partial']);

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let id, to;
  try { ({ id, to } = await req.json()); } catch { return json(400, { error: 'bad_json' }); }
  if (to && !EMAIL_RE.test(to)) return json(400, { error: 'bad_email', message: 'That email address doesn’t look right.' });
  const batch = await loadBatch(id);
  if (!batch) return json(404, { error: 'not_found' });
  if (!batch.parent || !PAID.has(batch.status)) {
    return json(409, { error: 'state', message: `Batch is ${batch.status}; a receipt goes out only once the invoice is paid.` });
  }
  try {
    const sent = await sendPaymentReceipt(batch, { to });
    if (!to || to === batch.buyer.email) await updateMarker(`receipt/${batch.id}`, { ...sent, error: null });
    return json(200, { sent, receipt: await loadMarker(`receipt/${batch.id}`) });
  } catch (err) {
    return fail(err);
  }
};
