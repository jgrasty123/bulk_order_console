/* ==========================================================================
   order-status (public, by private link)
   GET ?b=<batch>&t=<token>. Shows the customer their batch: payment,
   each recipient's order, and tracking. Also a safety net for the payment
   webhook — if the invoice is paid and orders haven't started, it starts them.
   ========================================================================== */

import { json, fail, loadBatch } from '../lib/common.mjs';
import { tokenMatches, refreshPayment, refreshTracking, autoReleases, startRelease, customerView } from '../lib/batches.mjs';
import { rateLimited } from '../lib/guard.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'method' });
  const limited = await rateLimited(req, 'status', 600);
  if (limited) return limited;

  const url = new URL(req.url);
  const id = url.searchParams.get('b') || '';
  const token = url.searchParams.get('t') || '';
  const batch = /^B\d{8}-[A-Z0-9]{4,8}$/.test(id) ? await loadBatch(id) : null;

  // Same answer for "no such batch" and "wrong token", so links can't be probed.
  if (!tokenMatches(batch, token)) return json(404, { error: 'not_found', message: 'We couldn’t find that order. Check the link in your email.' });

  try {
    await refreshPayment(batch);
    if (batch.status === 'paid' && autoReleases(batch)) await startRelease(batch.id);
    await refreshTracking(batch).catch(() => false);
  } catch (err) {
    return fail(err);
  }
  return json(200, { batch: customerView(batch) });
};
