/* ==========================================================================
   order-submit (public)
   Turns a priced list into a batch and a Shopify invoice, then hands the
   customer the checkout link. Nothing ships until that invoice is paid.

   Re-checks, in order: bot check, buyer details (21+), every recipient's
   rules, every quote's signature and age, and that the discount matches the
   real recipient count.
   ========================================================================== */

import { json, fail, rules } from '../lib/common.mjs';
import { loadCatalog, verifyQuote } from '../lib/pricing.mjs';
import { rateLimited, botCheck } from '../lib/guard.mjs';
import { buildBatch, createBatchWithInvoice, newBatchId, sendInvoice } from '../lib/batches.mjs';
import { saveBatch } from '../lib/common.mjs';
import { env } from '../lib/shopify.mjs';
import { checkRecipient, discountFor, normaliseState, clean, isAdult, EMAIL_RE } from '../../shared/rules.mjs';

const bad = (message, error = 'invalid') => json(400, { error, message });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const limited = await rateLimited(req, 'submit', 12);
  if (limited) return limited;

  let body;
  try { body = await req.json(); } catch { return bad('Could not read the order.', 'bad_json'); }
  const { buyer = {}, recipients = [], deliveryDate = '', turnstileToken } = body;

  const blocked = await botCheck(req, turnstileToken);
  if (blocked) return blocked;

  // Buyer
  const b = {
    name: clean(buyer.name), company: clean(buyer.company), email: clean(buyer.email).toLowerCase(),
    phone: clean(buyer.phone), poNumber: clean(buyer.poNumber), dob: clean(buyer.dob)
  };
  if (!b.name) return bad('Please enter your name.');
  if (!EMAIL_RE.test(b.email)) return bad('Please enter a valid email — your invoice and order updates go there.');
  if (!isAdult(b.dob)) return bad('The person placing the order must be 21 or older.');

  // Recipients
  if (recipients.length < rules.limits.minRecipientsPerBatch) {
    return bad(`Corporate orders need at least ${rules.limits.minRecipientsPerBatch} recipients.`);
  }
  if (recipients.length > rules.limits.maxRowsPerBatch) {
    return bad(`Orders can have up to ${rules.limits.maxRowsPerBatch} recipients.`);
  }
  if (deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return bad('Delivery date is not valid.');

  const expectedDiscount = discountFor(recipients.length, rules);
  let catalog;
  try { catalog = new Map((await loadCatalog()).map((i) => [i.sku, i])); }
  catch (err) { return fail(err); }

  const clean_ = [];
  for (const raw of recipients) {
    const r = {
      firstName: clean(raw.firstName), lastName: clean(raw.lastName), company: clean(raw.company),
      address1: clean(raw.address1), address2: clean(raw.address2), city: clean(raw.city),
      state: normaliseState(raw.state), zip: clean(raw.zip), phone: clean(raw.phone), email: clean(raw.email),
      giftMessage: clean(raw.giftMessage), deliveryDate: deliveryDate || '',
      lines: (raw.lines || []).map((l) => ({ sku: clean(l.sku), qty: Number(l.qty) })),
      quote: raw.quote
    };
    const who = `${r.firstName} ${r.lastName}`.trim() || 'A recipient';
    const issues = checkRecipient(r, rules).filter((i) => i.sev === 'stop');
    if (issues.length) return bad(`${who}: ${issues[0].msg}`);
    for (const l of r.lines) {
      const item = catalog.get(l.sku);
      if (!item) return bad(`${who}: “${l.sku}” isn’t available for corporate orders.`);
      l.variantId = item.variantId;
      l.title = item.title;
    }
    const problem = verifyQuote(r, r.quote);
    if (problem === 'expired') return bad('Your prices are more than 3 hours old. Please re-check your order to refresh them.', 'stale_quote');
    if (problem) return bad(`${who}: the price for this recipient doesn’t match. Please re-check your order.`, 'bad_quote');
    if (r.quote.discountPct !== expectedDiscount) {
      return bad('The number of recipients changed since pricing. Please re-check your order.', 'bad_quote');
    }
    clean_.push(r);
  }

  try {
    const batch = buildBatch({
      id: newBatchId(), source: 'customer', buyer: b,
      pricing: { discountPct: expectedDiscount, shipping: 'live' },
      recipients: clean_
    });
    await createBatchWithInvoice(batch);

    const site = env('URL') || new URL(req.url).origin;
    const statusUrl = `${site}/status.html?b=${encodeURIComponent(batch.id)}&t=${encodeURIComponent(batch.statusToken)}`;
    batch.statusUrl = statusUrl;

    // The invoice email doubles as the customer's record: pay link from
    // Shopify, plus the link to follow every recipient's delivery.
    try {
      await sendInvoice(batch,
        `Thank you for your corporate order (${batch.id}) — ${batch.recipients.length} recipients. ` +
        `Once it's paid, each gift is shipped separately. Follow every delivery here: ${statusUrl}`);
    } catch (e) {
      batch.log.push({ at: new Date().toISOString(), msg: `Invoice email not sent: ${e.message}` });
    }
    await saveBatch(batch);

    return json(200, { id: batch.id, invoiceUrl: batch.parent.invoiceUrl, statusUrl, total: batch.totals.total });
  } catch (err) {
    if (err.status) return json(err.status, { error: 'create', message: err.message });
    return fail(err);
  }
};
