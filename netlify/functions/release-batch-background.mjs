/* ==========================================================================
   release-batch-background   (Netlify background function, 15-minute limit)

   Creates one $0 Shopify order per recipient, after the parent invoice is
   paid. Safe to run more than once — Netlify retries failed background
   functions automatically, and a person may press Resume:

     - every child order carries sourceIdentifier = a hash of the batch and
       recipient, and existing ones are looked up before anything is created
     - a heartbeat lock stops two runs overlapping
     - progress is saved after every recipient, so a timeout loses nothing

   Recipients never receive a Shopify email: receipts are switched off, and
   no customer record is attached to child orders.
   ========================================================================== */

import { gql, env } from '../lib/shopify.mjs';
import { denied, claimRelease, loadBatch, saveBatch, rules } from '../lib/common.mjs';

const CREATE_CHILD = `
  mutation CreateChild($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name sourceIdentifier }
      userErrors { field message code }
    }
  }`;

const EXISTING = `
  query ExistingChildren($q: String!, $after: String) {
    orders(first: 250, query: $q, after: $after) {
      edges { node { id name sourceIdentifier } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const HEARTBEAT_STALE_MS = 60 * 1000;
const DEADLINE_MS = 13.5 * 60 * 1000;
const RELEASABLE = new Set(['paid', 'partial', 'releasing']);

const now = () => new Date().toISOString();

async function existingChildren(batchTag) {
  const found = new Map();
  let after = null;
  do {
    const data = await gql(EXISTING, { q: `tag:'${batchTag}'`, after });
    for (const { node } of data.orders.edges) {
      if (node.sourceIdentifier) found.set(node.sourceIdentifier, node);
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return found;
}

function childOrder(batch, r) {
  const d = rules.orderDefaults;
  const zero = { shopMoney: { amount: '0.00', currencyCode: batch.pricing.currencyCode } };
  const parentRef = batch.parent ? batch.parent.orderName || batch.parent.draftName : 'TEST';

  const attrs = [
    { key: 'Bulk Batch', value: batch.id },
    { key: 'Bulk Parent Order', value: parentRef }
  ];
  if (r.giftMessage) attrs.push({ key: d.giftMessageAttributeKey, value: r.giftMessage });
  if (r.deliveryDate) attrs.push({ key: d.deliveryDateAttributeKey, value: r.deliveryDate });
  if (d.requireAdultSignature) attrs.push({ key: d.adultSignatureNoteAttribute, value: 'Yes' });
  if (r.email) attrs.push({ key: 'Recipient Email', value: r.email });
  if (batch.buyer.company || batch.buyer.name) {
    attrs.push({ key: 'Sent By', value: batch.buyer.company || batch.buyer.name });
  }

  const noteParts = [];
  if (r.giftMessage) noteParts.push(`Gift message: ${r.giftMessage}`);
  if (r.deliveryDate) noteParts.push(`Deliver on: ${r.deliveryDate}`);
  if (d.requireAdultSignature) noteParts.push('Adult signature required.');

  const tags = [...d.childOrderTags, `${d.batchTagPrefix}${batch.id}`];
  if (batch.test) tags.push('bulk-test');

  return {
    lineItems: r.lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.qty,
      priceSet: zero,
      taxable: false,
      requiresShipping: true
    })),
    shippingAddress: {
      firstName: r.firstName, lastName: r.lastName, company: r.company || null,
      address1: r.address1, address2: r.address2 || null,
      city: r.city, provinceCode: r.state, zip: r.zip, countryCode: 'US',
      phone: r.phone || null
    },
    // The service the recipient was priced at (e.g. "UPS® Ground"), so ShipStation
    // maps it the same way it maps a web order.
    shippingLines: [{ title: (r.quote && r.quote.shippingTitle) || rules.pricing.shippingTitle, priceSet: zero }],
    financialStatus: 'PAID',
    customAttributes: attrs,
    note: noteParts.join('\n') || null,
    tags,
    sourceName: d.sourceName,
    sourceIdentifier: r.key,
    poNumber: batch.buyer.poNumber || null,
    test: Boolean(batch.test)
  };
}

export default async (req) => {
  if (denied(req)) return;               // background: nothing to return to

  let id;
  try { ({ id } = await req.json()); } catch { return; }

  const isReleasable = (b) =>
    RELEASABLE.has(b.status) &&
    // A run that is still heartbeating owns the batch.
    !(b.status === 'releasing' && b.lockedAt &&
      Date.now() - Date.parse(b.lockedAt) < HEARTBEAT_STALE_MS);

  const batch = await claimRelease(id, isReleasable);
  if (!batch) return;

  const started = Date.now();
  const myRun = batch.runId;
  batch.log.push({ at: now(), msg: 'Release started.' });
  await saveBatch(batch);

  // Before each write, confirm no other run has taken over the batch.
  const stillOurs = async () => {
    const cur = await loadBatch(id);
    return cur && cur.runId === myRun;
  };

  const d = rules.orderDefaults;
  const options = {
    inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
    sendReceipt: false,
    sendFulfillmentReceipt: false
  };

  let existing;
  try {
    existing = await existingChildren(`${d.batchTagPrefix}${batch.id}`);
  } catch (err) {
    batch.status = 'partial';
    batch.log.push({ at: now(), msg: `Could not check for existing orders: ${err.message}` });
    await saveBatch(batch);
    return;
  }

  for (const r of batch.recipients) {
    if (Date.now() - started > DEADLINE_MS) {
      batch.status = 'partial';
      batch.log.push({ at: now(), msg: 'Stopped before the time limit. Press Resume to continue.' });
      await saveBatch(batch);
      return;
    }

    if (r.child && r.child.orderId) continue;

    if (!(await stillOurs())) return;   // another run owns it now; stop quietly

    const already = existing.get(r.key);
    if (already) {
      r.child = { orderId: already.id, orderName: already.name, at: now(), recovered: true };
      batch.lockedAt = now();
      await saveBatch(batch);
      continue;
    }

    try {
      const data = await gql(CREATE_CHILD, { order: childOrder(batch, r), options });
      const out = data.orderCreate;
      if (out.userErrors.length) {
        r.child = { error: out.userErrors.map((e) => e.message).join('; '), at: now() };
      } else {
        r.child = { orderId: out.order.id, orderName: out.order.name, at: now() };
      }
    } catch (err) {
      // Includes AmbiguousWriteError: the order may exist. Resume will find it
      // by sourceIdentifier rather than create a second one.
      r.child = { error: err.message, at: now(), ambiguous: err.name === 'AmbiguousWriteError' || undefined };
    }

    batch.lockedAt = now();
    await saveBatch(batch);
  }

  const failed = batch.recipients.filter((r) => !r.child || !r.child.orderId).length;
  batch.status = failed ? 'partial' : 'released';
  batch.lockedAt = null;
  batch.log.push({
    at: now(),
    msg: failed
      ? `Release finished with ${failed} recipient${failed === 1 ? '' : 's'} not created. Fix and resume.`
      : `All ${batch.recipients.length} orders created.`
  });
  await saveBatch(batch);
};
