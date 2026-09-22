/* ==========================================================================
   Batch lifecycle shared by the staff console and the customer page:
   build → parent invoice → payment → release → tracking.
   ========================================================================== */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { gql, env, fromCents, toCents, AmbiguousWriteError } from './shopify.mjs';
import { rules, saveBatch, reserveBatch, recipientKey } from './common.mjs';

const now = () => new Date().toISOString();

export function newBatchId() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const tail = [...randomBytes(5)].map((b) => alphabet[b % 32]).join('');
  return `B${stamp}-${tail}`;
}

export const newStatusToken = () => randomBytes(24).toString('base64url');

export function tokenMatches(batch, token) {
  if (!batch || !batch.statusToken || !token) return false;
  const a = Buffer.from(batch.statusToken), b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* Turn priced recipients into a stored batch record (not yet saved). */
export function buildBatch({ id, test = false, source = 'staff', buyer = {}, pricing = {}, recipients }) {
  const totals = { gross: 0, discount: 0, merchandise: 0, shipping: 0, tax: 0, total: 0, units: 0 };
  const stored = recipients.map((r) => {
    const q = r.quote.cents;
    for (const k of ['gross', 'discount', 'merchandise', 'shipping', 'tax', 'total']) totals[k] += q[k];
    totals.units += r.lines.reduce((n, l) => n + Number(l.qty), 0);
    return {
      key: recipientKey(id, r),
      rows: r.rows || [],
      firstName: r.firstName, lastName: r.lastName, company: r.company || '',
      address1: r.address1, address2: r.address2 || '', city: r.city, state: r.state, zip: r.zip,
      phone: r.phone || '', email: r.email || '',
      giftMessage: r.giftMessage || '', deliveryDate: r.deliveryDate || '',
      lines: r.lines.map((l) => ({ sku: l.sku, variantId: l.variantId, qty: Number(l.qty), title: l.title || '', price: l.price || null })),
      quote: r.quote,
      child: null
    };
  });

  const keys = new Set(stored.map((r) => r.key));
  if (keys.size !== stored.length) {
    const err = new Error('Two recipients are the same person, address and gifts. Combine them into one.');
    err.status = 400;
    throw err;
  }

  return {
    id, test: Boolean(test), source,
    status: test ? 'paid' : 'draft',
    createdAt: now(),
    statusToken: newStatusToken(),
    buyer: {
      name: buyer.name || '', company: buyer.company || '', email: buyer.email || '',
      phone: buyer.phone || '', poNumber: buyer.poNumber || '', dob: buyer.dob || ''
    },
    pricing: { ...pricing, currencyCode: rules.pricing.currencyCode },
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, k === 'units' ? v : fromCents(v)])),
    totalsCents: totals,
    parent: null,
    recipients: stored,
    log: [{ at: now(), msg: test ? 'Test batch created — no invoice.' : `Batch created (${source}).` }]
  };
}

/* Every product in the batch, with how many of each. This is what the
   invoice itemises, so the buyer and the admin see what was ordered. */
export function productSummary(recipients) {
  const by = new Map();
  for (const r of recipients) {
    for (const l of r.lines) {
      if (!by.has(l.sku)) by.set(l.sku, { sku: l.sku, title: l.title || l.sku, price: l.price, qty: 0 });
      by.get(l.sku).qty += Number(l.qty);
    }
  }
  const list = [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
  // Only itemise if every product has a price and the maths reconciles.
  return list.every((p) => p.price != null) ? list : null;
}

/* --- Parent invoice ------------------------------------------------------ */

const CREATE_PARENT = `
  mutation CreateParent($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl status totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }`;

const SEND = `
  mutation SendInvoice($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id invoiceSentAt }
      userErrors { field message }
    }
  }`;

const customLine = (title, cents) => ({
  title, quantity: 1,
  originalUnitPriceWithCurrency: { amount: fromCents(cents), currencyCode: rules.pricing.currencyCode },
  taxable: false, requiresShipping: false
});

/* Reserve the id, create the parent draft order, save. Returns the batch;
   throws with .status set when the caller should report an error. */
export async function createBatchWithInvoice(batch) {
  const claimed = await reserveBatch({ ...batch, status: 'creating' });
  if (!claimed) {
    const err = new Error(`Batch ${batch.id} already exists.`);
    err.status = 409;
    throw err;
  }
  if (batch.test) { await saveBatch(batch); return batch; }

  const t = batch.totalsCents;
  const n = batch.recipients.length;
  const tagPrefix = rules.orderDefaults.batchTagPrefix;

  // Itemise the invoice by product — the buyer sees what they bought and the
  // admin order reads like an order. These are custom lines, not variants, so
  // paying the invoice does not touch stock: inventory moves on the recipient
  // orders, which carry the real variants.
  const products = productSummary(batch.recipients);
  const lineItems = [];
  let discount = t.discount;

  if (products && products.reduce((sum, p) => sum + toCents(p.price) * p.qty, 0) === t.gross) {
    products.forEach((p) => lineItems.push({
      title: p.title,
      quantity: p.qty,
      originalUnitPriceWithCurrency: { amount: p.price, currencyCode: rules.pricing.currencyCode },
      taxable: false,
      requiresShipping: false
    }));
  } else {
    // Prices or totals don't reconcile — fall back to one line rather than
    // show the buyer an itemisation that doesn't add up.
    lineItems.push(customLine(
      `Corporate gift batch ${batch.id} — ${n} recipient${n === 1 ? '' : 's'}, ${t.units} gift${t.units === 1 ? '' : 's'}`,
      t.merchandise
    ));
    discount = 0;
  }

  if (t.shipping > 0) lineItems.push(customLine(`Shipping — ${n} destination${n === 1 ? '' : 's'} (UPS)`, t.shipping));
  if (t.tax > 0) lineItems.push(customLine('Sales tax — calculated per destination', t.tax));

  const input = {
    email: batch.buyer.email,
    note:
      `Bulk corporate batch ${batch.id} (${batch.source}): ${n} recipients, ${t.units} gifts.` +
      (batch.pricing.discountPct ? ` ${batch.pricing.discountPct}% volume discount applied per recipient.` : '') +
      ` Child orders are created at $0 after payment and carry tag ${tagPrefix}${batch.id}.` +
      (batch.buyer.dob ? ` Buyer DOB given: ${batch.buyer.dob}.` : ''),
    tags: [...rules.orderDefaults.parentOrderTags, `${tagPrefix}${batch.id}`, `bulk-source-${batch.source}`],
    taxExempt: true,
    customAttributes: [
      { key: 'Bulk Batch', value: batch.id },
      { key: 'Recipients', value: String(n) }
    ],
    lineItems
  };
  if (discount > 0) {
    input.appliedDiscount = {
      title: `Corporate volume discount${batch.pricing.discountPct ? ` (${batch.pricing.discountPct}%)` : ''}`,
      description: 'Applied per recipient',
      value: Number(fromCents(discount)),
      valueType: 'FIXED_AMOUNT'
    };
  }
  if (batch.buyer.poNumber) input.poNumber = batch.buyer.poNumber;
  if (batch.buyer.phone) input.phone = batch.buyer.phone;

  try {
    const out = (await gql(CREATE_PARENT, { input })).draftOrderCreate;
    if (out.userErrors.length) {
      const msg = out.userErrors.map((e) => e.message).join('; ');
      batch.status = 'failed';
      batch.log.push({ at: now(), msg: `Invoice not created: ${msg}` });
      await saveBatch(batch);
      const err = new Error(msg); err.status = 422; throw err;
    }
    const d = out.draftOrder;
    batch.parent = { draftId: d.id, draftName: d.name, invoiceUrl: d.invoiceUrl, orderId: null, orderName: null };
    batch.status = 'awaiting_payment';
    batch.log.push({ at: now(), msg: `Parent draft ${d.name} created for $${d.totalPriceSet.shopMoney.amount}.` });
    if (toCents(d.totalPriceSet.shopMoney.amount) !== t.total) {
      batch.log.push({ at: now(), msg: `WARNING: parent total $${d.totalPriceSet.shopMoney.amount} does not match quoted $${fromCents(t.total)}.` });
    }
  } catch (err) {
    if (err.status) throw err;
    batch.status = 'failed';
    batch.log.push({
      at: now(),
      msg: err instanceof AmbiguousWriteError
        ? `${err.message} Check Shopify for a draft order tagged ${tagPrefix}${batch.id} before trying again.`
        : `Invoice not created: ${err.message}`
    });
    await saveBatch(batch);
    throw err;
  }

  await saveBatch(batch);
  return batch;
}

export async function sendInvoice(batch, customMessage) {
  const vars = { id: batch.parent.draftId };
  if (customMessage) vars.email = { to: batch.buyer.email, customMessage };
  const out = (await gql(SEND, vars)).draftOrderInvoiceSend;
  if (out.userErrors.length) throw new Error(out.userErrors.map((e) => e.message).join('; '));
  batch.parent.invoiceSentAt = out.draftOrder.invoiceSentAt;
  batch.log.push({ at: now(), msg: `Invoice emailed to ${batch.buyer.email}.` });
  return batch;
}

/* --- Payment ------------------------------------------------------------- */

const PARENT = `
  query ParentStatus($id: ID!) {
    draftOrder(id: $id) { id name status invoiceUrl order { id name displayFinancialStatus } }
  }`;

/* Ask Shopify whether the parent is paid. Saves and returns true if the
   batch changed. */
export async function refreshPayment(batch) {
  if (batch.status !== 'awaiting_payment' || !batch.parent) return false;
  const d = (await gql(PARENT, { id: batch.parent.draftId })).draftOrder;
  if (!d) {
    batch.status = 'cancelled';
    batch.log.push({ at: now(), msg: 'Parent draft order no longer exists in Shopify.' });
    await saveBatch(batch);
    return true;
  }
  if (!d.order) return false;
  batch.parent.orderId = d.order.id;
  batch.parent.orderName = d.order.name;
  batch.parent.financialStatus = d.order.displayFinancialStatus;
  if (d.order.displayFinancialStatus === 'PAID') {
    batch.status = 'paid';
    batch.paidAt = now();
    batch.log.push({ at: now(), msg: `Parent order ${d.order.name} is paid.` });
  }
  await saveBatch(batch);
  return true;
}

export const autoReleases = (batch) =>
  Boolean(rules.orderDefaults.autoRelease && rules.orderDefaults.autoRelease[batch.source]);

/* Kick off the background release. Safe to call repeatedly — the release
   function claims the batch atomically and skips if another run owns it. */
export async function startRelease(batchId) {
  const base = env('URL') || env('DEPLOY_PRIME_URL');
  const key = env('CONSOLE_KEY');
  if (!base || !key) return false;
  try {
    const res = await fetch(`${base}/.netlify/functions/release-batch-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-console-key': key },
      body: JSON.stringify({ id: batchId })
    });
    return res.status === 202 || res.ok;
  } catch {
    return false;
  }
}

/* --- Tracking ------------------------------------------------------------- */

const CHILDREN = `
  query Children($q: String!, $after: String) {
    orders(first: 250, query: $q, after: $after) {
      edges { node {
        name sourceIdentifier displayFulfillmentStatus cancelledAt
        fulfillments(first: 5) { status trackingInfo(first: 3) { company number url } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const TRACKING_TTL_MS = 10 * 60 * 1000;

export async function refreshTracking(batch) {
  if (!['released', 'partial'].includes(batch.status)) return false;
  if (batch.trackingAt && Date.now() - Date.parse(batch.trackingAt) < TRACKING_TTL_MS) return false;
  const byKey = new Map();
  let after = null;
  do {
    const data = await gql(CHILDREN, { q: `tag:'${rules.orderDefaults.batchTagPrefix}${batch.id}'`, after });
    for (const { node } of data.orders.edges) if (node.sourceIdentifier) byKey.set(node.sourceIdentifier, node);
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);

  for (const r of batch.recipients) {
    const o = byKey.get(r.key);
    if (!o || !r.child) continue;
    r.child.fulfillment = o.cancelledAt ? 'CANCELLED' : o.displayFulfillmentStatus;
    r.child.tracking = o.fulfillments.flatMap((f) => f.trackingInfo)
      .filter((t) => t.number).map((t) => ({ company: t.company, number: t.number, url: t.url }));
  }
  batch.trackingAt = now();
  await saveBatch(batch);
  return true;
}

/* What a customer may see about their own batch. No internal ids, no
   staff log, no quotes' signatures. */
export function customerView(batch) {
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    invoiceUrl: batch.status === 'awaiting_payment' && batch.parent ? batch.parent.invoiceUrl : null,
    orderName: batch.parent && batch.parent.orderName,
    buyer: { name: batch.buyer.name, company: batch.buyer.company, email: batch.buyer.email },
    totals: batch.totals,
    discountPct: batch.pricing.discountPct || 0,
    recipients: batch.recipients.map((r) => ({
      name: `${r.firstName} ${r.lastName}`, company: r.company,
      city: r.city, state: r.state,
      gifts: r.lines.map((l) => ({ title: l.title || l.sku, qty: l.qty })),
      shipping: r.quote.shippingTitle || '',
      total: r.quote.display.total,
      order: r.child && r.child.orderName ? r.child.orderName : null,
      fulfillment: r.child ? r.child.fulfillment || (r.child.orderId ? 'UNFULFILLED' : null) : null,
      tracking: (r.child && r.child.tracking) || []
    }))
  };
}
