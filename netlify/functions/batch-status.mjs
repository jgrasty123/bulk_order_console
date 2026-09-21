/* ==========================================================================
   batch-status
   GET ?id=B...   → the batch, with payment state refreshed from Shopify
   GET            → recent batches

   A batch moves to "paid" only when Shopify says the parent order is paid.
   That covers both the buyer paying the invoice online and someone marking
   the draft as paid in Shopify admin after a check or wire clears.
   ========================================================================== */

import { gql } from '../lib/shopify.mjs';
import { json, fail, denied, loadBatch, saveBatch, listBatches } from '../lib/common.mjs';

const PARENT = `
  query ParentStatus($id: ID!) {
    draftOrder(id: $id) {
      id name status invoiceUrl
      order { id name displayFinancialStatus }
    }
  }`;

const STALE_LOCK_MS = 2 * 60 * 1000;   // release heartbeats after every recipient

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  const id = new URL(req.url).searchParams.get('id');

  if (!id) {
    try { return json(200, { batches: await listBatches() }); }
    catch (err) { return fail(err); }
  }

  const batch = await loadBatch(id);
  if (!batch) return json(404, { error: 'not_found', message: `No batch ${id}.` });

  // A release that died without cleaning up (timeout, crash) should not
  // block a resume forever.
  if (batch.status === 'releasing' && batch.lockedAt &&
      Date.now() - Date.parse(batch.lockedAt) > STALE_LOCK_MS) {
    batch.status = 'partial';
    batch.log.push({ at: new Date().toISOString(), msg: 'Release stopped without finishing. Safe to resume.' });
    await saveBatch(batch);
  }

  if (batch.status === 'awaiting_payment' && batch.parent) {
    try {
      const data = await gql(PARENT, { id: batch.parent.draftId });
      const d = data.draftOrder;
      if (!d) {
        batch.status = 'cancelled';
        batch.log.push({ at: new Date().toISOString(), msg: 'Parent draft order no longer exists in Shopify.' });
        await saveBatch(batch);
      } else if (d.order) {
        batch.parent.orderId = d.order.id;
        batch.parent.orderName = d.order.name;
        batch.parent.financialStatus = d.order.displayFinancialStatus;
        if (d.order.displayFinancialStatus === 'PAID') {
          batch.status = 'paid';
          batch.log.push({ at: new Date().toISOString(), msg: `Parent order ${d.order.name} is paid. Ready to release.` });
        }
        await saveBatch(batch);
      }
    } catch (err) {
      return fail(err);
    }
  }

  return json(200, { batch });
};
