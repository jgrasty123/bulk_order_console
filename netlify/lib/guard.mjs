/* ==========================================================================
   Protection for the public endpoints: per-IP rate limits and, when a
   Cloudflare Turnstile secret is configured, a bot check on submit.
   ========================================================================== */

import { getStore } from '@netlify/blobs';
import { env } from './shopify.mjs';
import { json } from './common.mjs';

export const clientIp = (req) =>
  req.headers.get('x-nf-client-connection-ip') ||
  (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

export async function rateLimited(req, bucket, maxPerHour) {
  const store = getStore({ name: 'bulk-ratelimit' });
  const hour = Math.floor(Date.now() / 3600000);
  const key = `${bucket}/${clientIp(req).replace(/[^\w.:-]/g, '_')}/${hour}`;
  const n = ((await store.get(key, { type: 'json' })) || 0) + 1;
  await store.setJSON(key, n);
  if (n > maxPerHour) {
    return json(429, { error: 'rate_limited', message: 'Too many requests. Please wait a few minutes and try again.' });
  }
  return null;
}

export async function botCheck(req, token) {
  const secret = env('TURNSTILE_SECRET_KEY');
  if (!secret) return null;                        // not configured → skip
  const form = new URLSearchParams({ secret, response: token || '', remoteip: clientIp(req) });
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = await res.json();
    if (out.success) return null;
  } catch { /* fall through */ }
  return json(403, { error: 'bot_check', message: 'Please complete the security check and try again.' });
}
