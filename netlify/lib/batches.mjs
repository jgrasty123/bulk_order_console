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
  const service = recipients.find((r) => r.quote && r.quote.shippingTitle);
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
    shippingTitle: (service && service.quote.shippingTitle) || rules.pricing.shippingTitle,
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
      if (!by.has(l.sku)) by.set(l.sku, { sku: l.sku, title: l.title || l.sku, price: l.price, variantId: l.variantId, qty: 0 });
      by.get(l.sku).qty += Number(l.qty);
    }
  }
  const list = [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
  // Only itemise if every product has a price and the maths reconciles.
  return list.every((p) => p.price != null && p.variantId) ? list : null;
}

/* --- Parent invoice -------------------------------------------------------
   The invoice is a real Shopify order, not a draft. Draft orders can't hold
   tax lines or a shipping line without one shipping address, and a bulk
   order has many — which is why these used to be fake product lines. As a
   real order it carries:

     line items   the actual product variants, at their real prices
     discount     a real discount, named for the code, at the exact amount
                  the recipients were quoted (so it can't drift a cent)
     shipping     a real shipping line
     tax          real tax lines, per jurisdiction, summed from what Shopify
                  calculated for each destination

   It holds no stock: inventory is bypassed here and moves when the recipient
   orders are created after payment, so an unpaid invoice never reserves
   anything. It carries no shipping address, so nothing tries to ship it.
   --------------------------------------------------------------------------- */

const CREATE_PARENT = `
  mutation CreateParent($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id name
        totalPriceSet { shopMoney { amount } }
        paymentCollectionDetails { additionalPaymentCollectionUrl }
      }
      userErrors { field message code }
    }
  }`;

const SEND = `
  mutation SendOrderInvoice($id: ID!, $email: EmailInput) {
    orderInvoiceSend(id: $id, email: $email) {
      order { id name }
      userErrors { field message }
    }
  }`;

const bag = (cents) => ({ shopMoney: { amount: fromCents(cents), currencyCode: rules.pricing.currencyCode } });

/* Every jurisdiction that taxed any recipient, with the totals Shopify
   worked out for each destination. */
export function taxLinesFor(recipients) {
  const by = new Map();
  for (const r of recipients) {
    for (const t of (r.quote && r.quote.taxLines) || []) {
      const key = `${t.title}|${t.rate}`;
      if (!by.has(key)) by.set(key, { title: t.title, rate: t.rate, cents: 0 });
      by.get(key).cents += t.cents;
    }
  }
  return [...by.values()].filter((t) => t.cents > 0).sort((a, b) => b.cents - a.cents);
}

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

  const products = productSummary(batch.recipients);
  if (!products || products.reduce((sum, p) => sum + toCents(p.price) * p.qty, 0) !== t.gross) {
    batch.status = 'failed';
    batch.log.push({ at: now(), msg: 'Invoice not created: product prices do not reconcile to the quoted total.' });
    await saveBatch(batch);
    const err = new Error('We could not price this order. Please try again.');
    err.status = 422;
    throw err;
  }

  const taxes = taxLinesFor(batch.recipients);
  const taxTotal = taxes.reduce((sum, x) => sum + x.cents, 0);

  const order = {
    email: batch.buyer.email,
    financialStatus: 'PENDING',                 // unpaid until they pay the invoice
    sourceName: rules.orderDefaults.sourceName,
    currency: rules.pricing.currencyCode,
    lineItems: products.map((p) => ({
      variantId: p.variantId,
      quantity: p.qty,
      priceSet: { shopMoney: { amount: p.price, currencyCode: rules.pricing.currencyCode } },
      taxable: true,
      requiresShipping: true
    })),
    shippingLines: [{
      title: `${batch.shippingTitle || 'Shipping'} — ${n} destination${n === 1 ? '' : 's'}`,
      priceSet: bag(t.shipping)
    }],
    taxLines: taxes.map((x) => ({ title: x.title, rate: x.rate, priceSet: bag(x.cents) })),
    note:
      `Bulk corporate batch ${batch.id} (${batch.source}): ${n} recipients, ${t.units} gifts.` +
      ` Each recipient's own order is created after payment, tagged ${tagPrefix}${batch.id}.` +
      ` This order holds the payment and tax; it is not shipped.` +
      (batch.buyer.dob ? ` Buyer DOB given: ${batch.buyer.dob}.` : ''),
    tags: [...rules.orderDefaults.parentOrderTags, `${tagPrefix}${batch.id}`, `bulk-source-${batch.source}`,
      ...(batch.pricing.discountCode ? [`code-${batch.pricing.discountCode}`] : [])],
    customAttributes: [
      { key: 'Bulk Batch', value: batch.id },
      { key: 'Recipients', value: String(n) },
      ...(batch.pricing.discountCode ? [{ key: 'Discount Code', value: batch.pricing.discountCode }] : [])
    ]
  };
  if (batch.buyer.poNumber) order.poNumber = batch.buyer.poNumber;
  if (batch.buyer.phone) order.phone = batch.buyer.phone;

  // A real discount, at exactly the amount quoted across the recipients.
  if (t.discount > 0) {
    order.discountCode = {
      itemFixedDiscountCode: {
        code: batch.pricing.discountCode ||
              `CORPORATE-VOLUME-${batch.pricing.discountPct || ''}`.replace(/-$/, ''),
        amountSet: bag(t.discount)
      }
    };
  }

  const options = {
    inventoryBehaviour: 'BYPASS',    // stock moves on the recipient orders, after payment
    sendReceipt: false,              // the invoice email goes separately
    sendFulfillmentReceipt: false
  };

  try {
    const out = (await gql(CREATE_PARENT, { order, options })).orderCreate;
    if (out.userErrors.length) {
      const msg = out.userErrors.map((e) => e.message).join('; ');
      batch.status = 'failed';
      batch.log.push({ at: now(), msg: `Invoice not created: ${msg}` });
      await saveBatch(batch);
      const err = new Error(msg); err.status = 422; throw err;
    }
    const o = out.order;
    batch.parent = {
      orderId: o.id,
      orderName: o.name,
      invoiceUrl: (o.paymentCollectionDetails && o.paymentCollectionDetails.additionalPaymentCollectionUrl) || null,
      financialStatus: 'PENDING'
    };
    batch.status = 'awaiting_payment';
    batch.log.push({ at: now(), msg: `Invoice ${o.name} created for $${o.totalPriceSet.shopMoney.amount} (${taxes.length} tax line${taxes.length === 1 ? '' : 's'}).` });
    if (toCents(o.totalPriceSet.shopMoney.amount) !== t.total) {
      batch.log.push({ at: now(), msg: `WARNING: invoice total $${o.totalPriceSet.shopMoney.amount} does not match quoted $${fromCents(t.total)}.` });
    }
    if (taxTotal !== t.tax) {
      batch.log.push({ at: now(), msg: `WARNING: tax lines total $${fromCents(taxTotal)} but recipients were quoted $${fromCents(t.tax)}.` });
    }
  } catch (err) {
    if (err.status) throw err;
    batch.status = 'failed';
    batch.log.push({
      at: now(),
      msg: err instanceof AmbiguousWriteError
        ? `${err.message} Check Shopify for an order tagged ${tagPrefix}${batch.id} before trying again.`
        : `Invoice not created: ${err.message}`
    });
    await saveBatch(batch);
    throw err;
  }

  await saveBatch(batch);
  return batch;
}

export async function sendInvoice(batch, customMessage) {
  const vars = { id: batch.parent.orderId };
  if (customMessage) vars.email = { to: batch.buyer.email, customMessage };
  const out = (await gql(SEND, vars)).orderInvoiceSend;
  if (out.userErrors.length) throw new Error(out.userErrors.map((e) => e.message).join('; '));
  batch.parent.invoiceSentAt = now();
  batch.log.push({ at: now(), msg: `Invoice emailed to ${batch.buyer.email}.` });
  return batch;
}

/* --- Payment ------------------------------------------------------------- */

const PARENT = `
  query ParentStatus($id: ID!) {
    order(id: $id) {
      id name displayFinancialStatus cancelledAt
      paymentCollectionDetails { additionalPaymentCollectionUrl }
    }
  }`;

/* Ask Shopify whether the invoice is paid. Saves and returns true if the
   batch changed. */
export async function refreshPayment(batch) {
  if (batch.status !== 'awaiting_payment' || !batch.parent) return false;
  const o = (await gql(PARENT, { id: batch.parent.orderId })).order;
  if (!o) {
    batch.status = 'cancelled';
    batch.log.push({ at: now(), msg: 'Invoice order no longer exists in Shopify.' });
    await saveBatch(batch);
    return true;
  }
  if (o.cancelledAt) {
    batch.status = 'cancelled';
    batch.log.push({ at: now(), msg: `Invoice ${o.name} was cancelled in Shopify.` });
    await saveBatch(batch);
    return true;
  }
  batch.parent.financialStatus = o.displayFinancialStatus;
  batch.parent.invoiceUrl = (o.paymentCollectionDetails && o.paymentCollectionDetails.additionalPaymentCollectionUrl) || batch.parent.invoiceUrl;
  if (['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus)) {
    batch.status = 'paid';
    batch.paidAt = now();
    batch.log.push({ at: now(), msg: `Invoice ${o.name} is paid.` });
    await saveBatch(batch);
    return true;
  }
  await saveBatch(batch);
  return false;
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
