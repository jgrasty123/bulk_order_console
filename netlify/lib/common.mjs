/* ==========================================================================
   Shared function plumbing: access gate, responses, batch storage.
   ========================================================================== */

import { getStore } from '@netlify/blobs';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import rules from '../../config/shipping-rules.json';
import { env, ConfigError } from './shopify.mjs';

export { rules };

/* --- Responses ---------------------------------------------------------- */

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

export function fail(err) {
  if (err instanceof ConfigError) {
    return json(503, { error: 'not_configured', message: err.message });
  }
  return json(502, { error: 'upstream', message: err.message });
}

/* --- Access gate ---------------------------------------------------------
   Every function that touches Shopify requires the console key. Fails
   closed: if CONSOLE_KEY is not set on the deploy, nothing runs. The site
   URL is public, and once an Admin token is present these endpoints can
   create real orders.
   ------------------------------------------------------------------------ */

export function denied(req) {
  const expected = env('CONSOLE_KEY');
  if (!expected) {
    return json(503, {
      error: 'no_console_key',
      message: 'CONSOLE_KEY is not set on this deploy, so all actions are locked.'
    });
  }
  const given = req.headers.get('x-console-key') || '';
  const a = Buffer.from(createHash('sha256').update(given).digest('hex'));
  const b = Buffer.from(createHash('sha256').update(expected).digest('hex'));
  if (!timingSafeEqual(a, b)) {
    return json(401, { error: 'unauthorized', message: 'Console key is missing or wrong.' });
  }
  return null;
}

/* --- Batch storage ------------------------------------------------------ */

const store = () => getStore({ name: 'bulk-batches', consistency: 'strong' });

export const loadBatch = (id) => store().get(`batch/${id}`, { type: 'json' });

export async function saveBatch(batch) {
  batch.updatedAt = new Date().toISOString();
  await store().setJSON(`batch/${batch.id}`, batch);
  return batch;
}

/* --- Claims --------------------------------------------------------------
   Two things must never happen twice: creating a batch's invoice, and
   starting its release. Conditional writes help, but they are not enough on
   their own — a conditional write with a missing etag silently becomes an
   unconditional one. So every claim is write-then-verify: stamp a unique
   run id, wait for the write to settle, read it back, and proceed only if
   our stamp is still the one there. Two racing callers cannot both see
   their own id.
   ------------------------------------------------------------------------ */

const SETTLE_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runId = () => randomUUID();

export async function reserveBatch(batch) {
  const claim = runId();
  batch.claim = claim;
  batch.updatedAt = new Date().toISOString();
  const res = await store().setJSON(`batch/${batch.id}`, batch, { onlyIfNew: true });
  if (!res.modified) return false;
  await sleep(SETTLE_MS);
  const current = await loadBatch(batch.id);
  return Boolean(current && current.claim === claim);
}

// Returns the claimed batch, or null if it is not ours to run.
export async function claimRelease(id, isReleasable) {
  const found = await store().getWithMetadata(`batch/${id}`, { type: 'json' });
  if (!found || !found.data) return null;
  const batch = found.data;
  if (!isReleasable(batch)) return null;

  const claim = runId();
  batch.status = 'releasing';
  batch.runId = claim;
  batch.lockedAt = new Date().toISOString();
  batch.updatedAt = batch.lockedAt;

  const opts = found.etag ? { onlyIfMatch: found.etag } : {};
  const res = await store().setJSON(`batch/${id}`, batch, opts);
  if (!res.modified) return null;

  await sleep(SETTLE_MS);
  const current = await loadBatch(id);
  if (!current || current.runId !== claim) return null;
  return current;
}

export async function listBatches(limit = 25) {
  const { blobs } = await store().list({ prefix: 'batch/' });
  const all = await Promise.all(
    blobs.map((b) => store().get(b.key, { type: 'json' }))
  );
  return all
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit)
    .map((b) => ({
      id: b.id,
      status: b.status,
      test: b.test,
      buyer: b.buyer && (b.buyer.company || b.buyer.name),
      recipients: b.recipients.length,
      total: b.totals && b.totals.total,
      createdAt: b.createdAt
    }));
}

export const BATCH_ID_RE = /^B\d{8}-[A-Z0-9]{4,8}$/;

/* --- Recipient identity --------------------------------------------------
   The idempotency key for a child order. Stable across retries because it
   is derived from the batch and the recipient's own data, never from time.
   ------------------------------------------------------------------------ */

export function recipientKey(batchId, r) {
  const basis = [
    batchId,
    r.firstName, r.lastName, r.address1, r.address2, r.city, r.state, r.zip,
    ...r.lines.map((l) => `${l.variantId}x${l.qty}`).sort()
  ].join('|').toLowerCase();
  return `${batchId}:${createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}
