/* ==========================================================================
   send-invoice
   Emails the parent draft order's invoice through Shopify, to the buyer
   email on the draft. Kept separate from create-batch so the invoice can be
   reviewed in Shopify admin before it goes out.
   ========================================================================== */

import { gql } from '../lib/shopify.mjs';
import { json, fail, denied, loadBatch, saveBatch } from '../lib/common.mjs';

const SEND = `
  mutation SendInvoice($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id invoiceSentAt }
      userErrors { field message }
    }
  }`;

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
    const data = await gql(SEND, { id: batch.parent.draftId });
    const out = data.draftOrderInvoiceSend;
    if (out.userErrors.length) {
      return json(422, { error: 'send', message: out.userErrors.map((e) => e.message).join('; ') });
    }
    batch.parent.invoiceSentAt = out.draftOrder.invoiceSentAt;
    batch.log.push({ at: new Date().toISOString(), msg: `Invoice emailed to ${batch.buyer.email}.` });
    await saveBatch(batch);
    return json(200, { batch });
  } catch (err) {
    return fail(err);
  }
};
