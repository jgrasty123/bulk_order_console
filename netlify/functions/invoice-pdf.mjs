/* ==========================================================================
   invoice-pdf — the batch's invoice as a PDF, for the buyer's AP team.

   Customer:  GET /invoice.pdf?b=<batch>&t=<token>   (the private status token)
   Staff:     GET ?id=<batch> with the console key header

   Payment is re-checked first, so a just-paid invoice downloads as PAID.
   ========================================================================== */

import { json, fail, denied, loadBatch, BATCH_ID_RE } from '../lib/common.mjs';
import { tokenMatches, refreshPayment } from '../lib/batches.mjs';
import { renderInvoicePdf, invoiceFileName } from '../lib/invoice-pdf.mjs';
import { rateLimited } from '../lib/guard.mjs';

const NOT_FOUND = { error: 'not_found', message: 'We couldn’t find that invoice. Check the link in your email.' };

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'method' });
  const url = new URL(req.url);

  let batch;
  const staffId = url.searchParams.get('id');
  if (staffId) {
    const no = denied(req);
    if (no) return no;
    batch = BATCH_ID_RE.test(staffId) ? await loadBatch(staffId) : null;
    if (!batch) return json(404, NOT_FOUND);
  } else {
    const limited = await rateLimited(req, 'invoice', 120);
    if (limited) return limited;
    const id = url.searchParams.get('b') || '';
    batch = BATCH_ID_RE.test(id) ? await loadBatch(id) : null;
    // Same answer for "no such batch" and "wrong token", so links can't be probed.
    if (!tokenMatches(batch, url.searchParams.get('t') || '')) return json(404, NOT_FOUND);
  }
  if (!batch.parent || batch.test) {
    return json(409, { error: 'no_invoice', message: 'This order has no invoice yet.' });
  }

  try {
    await refreshPayment(batch).catch(() => false);   // stale status beats no PDF
    const bytes = await renderInvoicePdf(batch);
    const inline = url.searchParams.get('view') === '1';
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${invoiceFileName(batch)}"`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow'
      }
    });
  } catch (err) {
    return fail(err);
  }
};
