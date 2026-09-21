/* ==========================================================================
   create-batch

   Saves the quoted batch and creates the parent draft order: one invoice
   for the whole batch, built from custom line items so it never touches
   inventory. Revenue and payment land here, once. The per-recipient child
   orders are created later, at $0, only after this invoice is paid.

   Test batches skip the invoice entirely and are marked ready to release;
   their child orders are created with Shopify's test flag.
   ========================================================================== */

import { gql, fromCents, toCents, AmbiguousWriteError } from '../lib/shopify.mjs';
import {
  json, fail, denied, rules, saveBatch, reserveBatch, recipientKey, BATCH_ID_RE
} from '../lib/common.mjs';

const CREATE_PARENT = `
  mutation CreateParent($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl status totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function customLine(title, cents, currencyCode) {
  return {
    title,
    quantity: 1,
    originalUnitPriceWithCurrency: { amount: fromCents(cents), currencyCode },
    taxable: false,
    requiresShipping: false
  };
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  const { id, test = false, buyer = {}, pricing = {}, recipients = [] } = body;
  const currencyCode = rules.pricing.currencyCode;

  // --- Shape checks. The console already validated; this is the backstop.
  if (!BATCH_ID_RE.test(id || '')) return json(400, { error: 'id', message: 'Bad batch id.' });
  if (!recipients.length) return json(400, { error: 'empty', message: 'No recipients.' });
  if (recipients.length > rules.limits.maxRowsPerBatch) {
    return json(400, { error: 'size', message: 'Batch is over the recipient limit.' });
  }
  if (!test && !EMAIL_RE.test(buyer.email || '')) {
    return json(400, { error: 'buyer', message: 'A buyer email is required to send the invoice.' });
  }
  for (const r of recipients) {
    if (!r.quote || !r.quote.cents) {
      return json(400, { error: 'unquoted', message: `Recipient ${r.firstName} ${r.lastName} has no quote.` });
    }
    if (!r.lines || !r.lines.every((l) => l.variantId && Number(l.qty) > 0)) {
      return json(400, { error: 'lines', message: `Recipient ${r.firstName} ${r.lastName} has an unresolved item.` });
    }
  }

  // --- Totals, in cents, recomputed here rather than trusted from the page.
  const totals = { gross: 0, discount: 0, merchandise: 0, shipping: 0, tax: 0, total: 0, units: 0 };
  const stored = recipients.map((r) => {
    const q = r.quote.cents;
    totals.gross += q.gross;
    totals.discount += q.discount;
    totals.merchandise += q.merchandise;
    totals.shipping += q.shipping;
    totals.tax += q.tax;
    totals.total += q.total;
    totals.units += r.lines.reduce((n, l) => n + Number(l.qty), 0);

    return {
      key: recipientKey(id, r),
      rows: r.rows || [],
      firstName: r.firstName, lastName: r.lastName, company: r.company || '',
      address1: r.address1, address2: r.address2 || '',
      city: r.city, state: r.state, zip: r.zip,
      phone: r.phone || '', email: r.email || '',
      giftMessage: r.giftMessage || '', deliveryDate: r.deliveryDate || '',
      lines: r.lines.map((l) => ({
        sku: l.sku, variantId: l.variantId, qty: Number(l.qty), title: l.title || ''
      })),
      quote: r.quote,
      child: null
    };
  });

  const keys = new Set(stored.map((r) => r.key));
  if (keys.size !== stored.length) {
    return json(400, {
      error: 'duplicate_recipient',
      message: 'Two recipients resolve to the same person, address and items. Merge them under one group ID or change one.'
    });
  }

  const batch = {
    id,
    test: Boolean(test),
    status: test ? 'paid' : 'draft',
    createdAt: new Date().toISOString(),
    buyer: {
      name: buyer.name || '', company: buyer.company || '',
      email: buyer.email || '', phone: buyer.phone || '', poNumber: buyer.poNumber || ''
    },
    pricing: {
      discountPct: Number(pricing.discountPct) || 0,
      shippingPerRecipient: Number(pricing.shippingPerRecipient) || 0,
      currencyCode
    },
    totals: Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, k === 'units' ? v : fromCents(v)])
    ),
    totalsCents: totals,
    parent: null,
    recipients: stored,
    log: [{ at: new Date().toISOString(), msg: test ? 'Test batch created — no invoice.' : 'Batch created.' }]
  };

  // Claim the id before creating anything in Shopify, so a double-click or
  // a retried request cannot produce two invoices for one batch.
  const claimed = await reserveBatch({ ...batch, status: 'creating' });
  if (!claimed) {
    return json(409, { error: 'exists', message: `Batch ${id} already exists. Open it instead of creating it again.` });
  }

  if (!test) {
    const n = stored.length;
    const lineItems = [
      customLine(
        `Corporate gift batch ${id} — ${n} recipient${n === 1 ? '' : 's'}, ${totals.units} gift${totals.units === 1 ? '' : 's'}`,
        totals.merchandise, currencyCode
      )
    ];
    if (totals.shipping > 0) {
      lineItems.push(customLine(`Shipping — ${n} destination${n === 1 ? '' : 's'}`, totals.shipping, currencyCode));
    }
    if (totals.tax > 0) {
      lineItems.push(customLine('Sales tax — calculated per destination', totals.tax, currencyCode));
    }

    const input = {
      email: batch.buyer.email,
      note:
        `Bulk corporate batch ${id}: ${n} recipients, ${totals.units} gifts.` +
        (batch.pricing.discountPct ? ` ${batch.pricing.discountPct}% batch discount applied per recipient.` : '') +
        ` Child orders are created at $0 after payment and carry tag ${rules.orderDefaults.batchTagPrefix}${id}.`,
      tags: [...rules.orderDefaults.parentOrderTags, `${rules.orderDefaults.batchTagPrefix}${id}`],
      taxExempt: true,  // tax is already a line item, calculated per destination
      customAttributes: [{ key: 'Bulk Batch', value: id }],
      lineItems
    };
    if (batch.buyer.poNumber) input.poNumber = batch.buyer.poNumber;
    if (batch.buyer.phone) input.phone = batch.buyer.phone;

    try {
      const data = await gql(CREATE_PARENT, { input });
      const out = data.draftOrderCreate;
      if (out.userErrors.length) {
        batch.status = 'failed';
        batch.log.push({ at: new Date().toISOString(), msg: `Invoice not created: ${out.userErrors.map((e) => e.message).join('; ')}` });
        await saveBatch(batch);
        return json(422, { error: 'parent', message: out.userErrors.map((e) => e.message).join('; ') });
      }
      const d = out.draftOrder;
      batch.parent = { draftId: d.id, draftName: d.name, invoiceUrl: d.invoiceUrl, orderId: null, orderName: null };
      batch.status = 'awaiting_payment';
      batch.log.push({ at: new Date().toISOString(), msg: `Parent draft ${d.name} created for $${d.totalPriceSet.shopMoney.amount}.` });

      // Shopify formats amounts inconsistently ("12.5" vs "12.50"), so compare cents.
      if (toCents(d.totalPriceSet.shopMoney.amount) !== totals.total) {
        batch.log.push({
          at: new Date().toISOString(),
          msg: `WARNING: parent total $${d.totalPriceSet.shopMoney.amount} does not match quoted $${fromCents(totals.total)}.`
        });
      }
    } catch (err) {
      batch.status = 'failed';
      batch.log.push({
        at: new Date().toISOString(),
        msg: err instanceof AmbiguousWriteError
          ? `${err.message} Check Shopify for a draft order tagged ${rules.orderDefaults.batchTagPrefix}${id} before creating this batch again.`
          : `Invoice not created: ${err.message}`
      });
      await saveBatch(batch);
      return fail(err);
    }
  }

  await saveBatch(batch);
  return json(200, { batch });
};
