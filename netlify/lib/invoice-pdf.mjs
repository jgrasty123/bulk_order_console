/* ==========================================================================
   PDF invoice for a corporate batch — the document an AP team files.

   Built only from the stored batch (the same numbers the Shopify invoice
   order was created from), so the PDF and the Shopify order always agree:

     page 1   seller, bill-to, invoice number (the Shopify order name),
              PO, line items by product, discount, shipping, tax by
              jurisdiction, total, amount paid, balance due
     after    a recipient schedule — who gets what, where, and the
              recipient's own order number once it exists
   ========================================================================== */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { rules } from './common.mjs';
import { productSummary, taxLinesFor } from './batches.mjs';

const PAID = new Set(['paid', 'releasing', 'released', 'partial']);

const W = 612, H = 792, M = 48;                 // US Letter, points
const INK = rgb(0.11, 0.11, 0.12), MUTED = rgb(0.42, 0.42, 0.45);
const RULE = rgb(0.85, 0.85, 0.87), BAND = rgb(0.96, 0.96, 0.97);
const GREEN = rgb(0.09, 0.47, 0.25), RED = rgb(0.7, 0.13, 0.13);

const usd = (cents) => {
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${s}`;
};
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }) : '');

export function invoiceState(batch) {
  if (batch.status === 'cancelled') return 'cancelled';
  return PAID.has(batch.status) ? 'paid' : 'due';
}

export function invoiceFileName(batch) {
  const n = ((batch.parent && batch.parent.orderName) || batch.id).replace(/[^\w-]/g, '');
  return `BroBasket-Invoice-${n}.pdf`;
}

export async function renderInvoicePdf(batch) {
  const cfg = rules.invoice || {};
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const orderName = (batch.parent && batch.parent.orderName) || batch.id;
  pdf.setTitle(`Invoice ${orderName}`);
  pdf.setAuthor(cfg.sellerName || 'Go-To Gifting, LLC');
  pdf.setCreationDate(new Date());

  // The standard fonts only cover WinAnsi; drop anything they can't draw
  // (emoji in a company name, say) rather than fail the whole invoice.
  const safe = (font, s) => [...String(s == null ? '' : s)].map((ch) => {
    try { font.encodeText(ch); return ch; } catch { /* not in WinAnsi */ }
    const base = ch.normalize('NFD')[0];                 // é -> e, if that helps
    return base && /[\x20-\x7e]/.test(base) ? base : '';
  }).join('');
  const width = (s, size, font = regular) => font.widthOfTextAtSize(safe(font, s), size);
  const fit = (s, size, max, font = regular) => {
    let t = safe(font, s);
    if (font.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > max) t = t.slice(0, -1);
    return t + '...';
  };
  const wrap = (s, size, max, font = regular) => {
    const words = safe(font, s).split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= max) cur = next;
      else { if (cur) lines.push(cur); cur = fit(w, size, max, font); }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  let page, y;
  const pages = [];
  const newPage = () => { page = pdf.addPage([W, H]); pages.push(page); y = H - M; };
  const text = (s, x, yy, { size = 9, font = regular, color = INK } = {}) =>
    page.drawText(safe(font, s), { x, y: yy, size, font, color });
  const right = (s, xr, yy, opts = {}) => text(s, xr - width(s, opts.size || 9, opts.font || regular), yy, opts);
  const hr = (yy, from = M, to = W - M) => page.drawLine({ start: { x: from, y: yy }, end: { x: to, y: yy }, thickness: 0.6, color: RULE });

  // ---- Header -------------------------------------------------------------
  newPage();
  text(cfg.brandName || 'The BroBasket', M, y - 16, { size: 20, font: bold });
  let sy = y - 32;
  for (const line of [cfg.sellerName, ...(cfg.addressLines || []), [cfg.phone, cfg.email].filter(Boolean).join('  ·  '), cfg.website].filter(Boolean)) {
    text(line, M, sy, { size: 8.5, color: MUTED }); sy -= 11;
  }

  const state = invoiceState(batch);
  right('INVOICE', W - M, y - 16, { size: 20, font: bold });
  const meta = [
    ['Invoice number', orderName],
    ['Invoice date', day(batch.createdAt)],
    ...(batch.buyer.poNumber ? [['PO number', batch.buyer.poNumber]] : []),
    ['Reference', batch.id],
    ...(state === 'paid' && batch.paidAt ? [['Paid on', day(batch.paidAt)]] : [])
  ];
  let my = y - 34;
  for (const [k, v] of meta) {
    right(String(v), W - M, my, { size: 8.5, font: bold });
    right(k, W - M - 118, my, { size: 8.5, color: MUTED });
    my -= 11;
  }
  const stamp = state === 'paid' ? ['PAID', GREEN] : state === 'cancelled' ? ['CANCELLED', RED] : ['PAYMENT DUE', RED];
  my -= 6;
  right(stamp[0], W - M, my, { size: 11, font: bold, color: stamp[1] });

  y = Math.min(sy, my) - 18;
  hr(y + 8);

  // ---- Bill to ------------------------------------------------------------
  text('BILL TO', M, y - 6, { size: 7.5, font: bold, color: MUTED });
  let by = y - 19;
  for (const [i, line] of [batch.buyer.company, batch.buyer.name, batch.buyer.email, batch.buyer.phone].filter(Boolean).entries()) {
    text(line, M, by, { size: i === 0 ? 10 : 9, font: i === 0 ? bold : regular }); by -= 12;
  }
  text('ORDER', 330, y - 6, { size: 7.5, font: bold, color: MUTED });
  const n = batch.recipients.length;
  const units = batch.totalsCents ? batch.totalsCents.units : batch.recipients.reduce((s, r) => s + r.lines.reduce((t, l) => t + Number(l.qty), 0), 0);
  text(`Corporate gift order: ${n} recipient${n === 1 ? '' : 's'}, ${units} gift${units === 1 ? '' : 's'}`, 330, y - 19, { size: 9 });
  text('Each gift ships separately to its recipient.', 330, y - 31, { size: 9, color: MUTED });
  text('See the recipient schedule.', 330, y - 43, { size: 9, color: MUTED });
  y = Math.min(by, y - 43) - 20;

  // ---- Line items ---------------------------------------------------------
  const C = { desc: M + 6, qty: 380, unit: 470, amt: W - M - 6 };
  const tableHead = (cols) => {
    page.drawRectangle({ x: M, y: y - 16, width: W - 2 * M, height: 18, color: BAND });
    for (const [label, x, align] of cols) {
      if (align === 'r') right(label, x, y - 11, { size: 7.5, font: bold, color: MUTED });
      else text(label, x, y - 11, { size: 7.5, font: bold, color: MUTED });
    }
    y -= 28;
  };
  tableHead([['DESCRIPTION', C.desc], ['QTY', C.qty, 'r'], ['UNIT PRICE', C.unit, 'r'], ['AMOUNT', C.amt, 'r']]);

  const t = batch.totalsCents || {};
  const products = productSummary(batch.recipients);
  if (products) {
    for (const p of products) {
      const unit = Math.round(parseFloat(p.price) * 100);
      text(fit(p.title, 9, C.qty - C.desc - 40), C.desc, y, { size: 9 });
      if (p.sku) text(p.sku, C.desc, y - 10, { size: 7.5, color: MUTED });
      right(String(p.qty), C.qty, y, { size: 9 });
      right(usd(unit), C.unit, y, { size: 9 });
      right(usd(unit * p.qty), C.amt, y, { size: 9 });
      y -= 24;
      if (y < 200) { newPage(); tableHead([['DESCRIPTION (CONTINUED)', C.desc], ['QTY', C.qty, 'r'], ['UNIT PRICE', C.unit, 'r'], ['AMOUNT', C.amt, 'r']]); }
    }
  } else {
    // Older batches without per-product prices: one line, the merchandise total.
    text(`Corporate gifts (${units})`, C.desc, y, { size: 9 });
    right(usd(t.gross || 0), C.amt, y, { size: 9 });
    y -= 24;
  }
  hr(y + 12);

  // ---- Totals -------------------------------------------------------------
  const tl = (label, cents, { strong = false, color = INK } = {}) => {
    right(label, C.unit, y, { size: strong ? 10.5 : 9, font: strong ? bold : regular, color: strong ? INK : MUTED });
    right(usd(cents), C.amt, y, { size: strong ? 10.5 : 9, font: strong ? bold : regular, color });
    y -= strong ? 16 : 13;
  };
  y -= 4;
  tl('Subtotal', t.gross || 0);
  if (t.discount > 0) {
    const name = batch.pricing.discountCode
      ? `Discount (${batch.pricing.discountCode})`
      : `Volume discount${batch.pricing.discountPct ? ` (${batch.pricing.discountPct}%)` : ''}`;
    tl(name, -t.discount);
  }
  tl(`Shipping: ${batch.shippingTitle || 'Shipping'}, ${n} destination${n === 1 ? '' : 's'}`, t.shipping || 0);
  const taxes = taxLinesFor(batch.recipients);
  if (taxes.length) for (const x of taxes) tl(`${x.title}${x.rate ? ` (${+(x.rate * 100).toFixed(3)}%)` : ''}`, x.cents);
  else tl('Tax', t.tax || 0);
  y -= 2; page.drawLine({ start: { x: 330, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.6, color: RULE });
  tl('Total (USD)', t.total || 0, { strong: true });
  if (state === 'paid') {
    tl('Amount paid', -(t.total || 0), { color: GREEN });
    tl('Balance due', 0, { strong: true });
  } else if (state === 'due') {
    tl('Balance due', t.total || 0, { strong: true, color: RED });
  }

  // How to pay, for an open invoice.
  if (state === 'due' && batch.parent && batch.parent.invoiceUrl) {
    y -= 10;
    text('HOW TO PAY', M, y, { size: 7.5, font: bold, color: MUTED });
    y -= 13;
    text('Pay by card online:', M, y, { size: 9 });
    const link = fit(batch.parent.invoiceUrl, 8.5, W - 2 * M - 95);
    text(link, M + 92, y, { size: 8.5, color: rgb(0.1, 0.3, 0.7) });
    y -= 12;
    text(`Paying by check or ACH? Contact ${cfg.email || 'us'} and reference invoice ${orderName}.`, M, y, { size: 8.5, color: MUTED });
    y -= 10;
  }

  // ---- Recipient schedule -------------------------------------------------
  const R = { num: M + 6, who: M + 26, to: 226, gifts: 336, order: 482, amt: W - M - 6 };
  const schedHead = (label) => {
    text(label, M, y, { size: 11, font: bold }); y -= 10;
    tableHead([['#', R.num], ['RECIPIENT', R.who], ['SHIP TO', R.to], ['GIFTS', R.gifts], ['ORDER', R.order], ['AMOUNT', R.amt, 'r']]);
  };
  y -= 22;
  if (y < 160) newPage();
  schedHead('Recipient schedule');
  batch.recipients.forEach((r, i) => {
    const giftLines = r.lines.flatMap((l) => wrap(`${l.qty} x ${l.title || l.sku}`, 8, R.order - R.gifts - 8));
    const whoLines = [`${r.firstName} ${r.lastName}`, r.company].filter(Boolean).map((s) => fit(s, 8.5, R.to - R.who - 8));
    const toLines = [`${r.city}, ${r.state} ${r.zip}`].map((s) => fit(s, 8.5, R.gifts - R.to - 8));
    const rows = Math.max(giftLines.length, whoLines.length, toLines.length);
    const h = rows * 10 + 9;
    if (y - h < M + 14) { newPage(); schedHead('Recipient schedule (continued)'); }
    text(String(i + 1), R.num, y, { size: 8.5, color: MUTED });
    whoLines.forEach((s, k) => text(s, R.who, y - k * 10, { size: 8.5, font: k === 0 ? bold : regular, color: k === 0 ? INK : MUTED }));
    toLines.forEach((s, k) => text(s, R.to, y - k * 10, { size: 8.5 }));
    giftLines.forEach((s, k) => text(s, R.gifts, y - k * 10, { size: 8 }));
    const orderNo = (r.child && r.child.orderName) || (state === 'paid' ? 'Pending' : '-');
    text(orderNo, R.order, y, { size: 8.5, color: r.child && r.child.orderName ? INK : MUTED });
    right(usd(r.quote && r.quote.cents ? r.quote.cents.total : 0), R.amt, y, { size: 8.5 });
    const sep = y - rows * 10 + 3;               // below the last line's descenders
    hr(sep);
    y = sep - 13;
  });
  y -= 2;
  right('Each amount includes that recipient’s gifts, shipping and tax, after any discount.', W - M, y, { size: 7.5, color: MUTED });

  // ---- Footer on every page ----------------------------------------------
  pages.forEach((pg, i) => {
    page = pg;
    hr(M - 4);
    text(fit(cfg.footer || 'Thank you for your business.', 7.5, W - 2 * M - 80), M, M - 16, { size: 7.5, color: MUTED });
    right(`Invoice ${orderName}  ·  Page ${i + 1} of ${pages.length}`, W - M, M - 16, { size: 7.5, color: MUTED });
  });

  return pdf.save();
}
