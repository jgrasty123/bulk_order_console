/* ==========================================================================
   shopify-webhook
   orders/paid from Shopify. When a bulk parent invoice is paid, mark the
   batch paid and — for customer orders — start creating recipient orders
   straight away. Verified with the app's API secret.
   ========================================================================== */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadBatch } from '../lib/common.mjs';
import { env } from '../lib/shopify.mjs';
import { refreshPayment, autoReleases, startRelease } from '../lib/batches.mjs';

const ok = () => new Response('ok', { status: 200 });

export default async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  const secret = env('SHOPIFY_API_SECRET');
  if (!secret) return new Response('not configured', { status: 503 });

  const raw = Buffer.from(await req.arrayBuffer());
  const given = Buffer.from(req.headers.get('x-shopify-hmac-sha256') || '');
  const expect = Buffer.from(createHmac('sha256', secret).update(raw).digest('base64'));
  if (given.length !== expect.length || !timingSafeEqual(given, expect)) {
    return new Response('unauthorized', { status: 401 });
  }

  let order;
  try { order = JSON.parse(raw.toString('utf8')); } catch { return ok(); }

  const attr = (order.note_attributes || []).find((a) => a.name === 'Bulk Batch');
  const id = attr && attr.value;
  if (!id) return ok();                       // not a bulk parent — ignore

  try {
    const batch = await loadBatch(id);
    if (!batch) return ok();
    await refreshPayment(batch);
    if (batch.status === 'paid' && autoReleases(batch)) await startRelease(batch.id);
  } catch {
    // Shopify retries non-2xx; the status page and staff console also
    // re-check payment, so a miss here is recoverable either way.
    return new Response('retry', { status: 500 });
  }
  return ok();
};
