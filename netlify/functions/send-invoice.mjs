/* send-invoice (staff) — email the parent invoice through Shopify. */

import { json, fail, denied, loadBatch, saveBatch } from '../lib/common.mjs';
import { sendInvoice } from '../lib/batches.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let id;
  try { ({ id } = await req.json()); } catch { return json(400, { error: 'bad_json' }); }
  const batch = await loadBatch(id);
  if (!batch) return json(404, { error: 'not_found' });
  if (!batch.parent || batch.status !== 'awaiting_payment') {
    return json(409, { error: 'state', message: `Batch is ${batch.status}; there is no open invoice to send.` });
  }
  try {
    await sendInvoice(batch);
    await saveBatch(batch);
    return json(200, { batch });
  } catch (err) {
    return fail(err);
  }
};
