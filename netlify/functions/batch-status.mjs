/* ==========================================================================
   batch-status (staff)
   GET ?id=B...  → the batch, with payment and tracking refreshed
   GET           → recent batches
   ========================================================================== */

import { json, fail, denied, loadBatch, saveBatch, listBatches } from '../lib/common.mjs';
import { refreshPayment, refreshTracking, autoReleases, startRelease } from '../lib/batches.mjs';

const STALE_LOCK_MS = 2 * 60 * 1000;

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    try { return json(200, { batches: await listBatches() }); } catch (err) { return fail(err); }
  }

  const batch = await loadBatch(id);
  if (!batch) return json(404, { error: 'not_found', message: `No batch ${id}.` });

  if (batch.status === 'releasing' && batch.lockedAt && Date.now() - Date.parse(batch.lockedAt) > STALE_LOCK_MS) {
    batch.status = 'partial';
    batch.log.push({ at: new Date().toISOString(), msg: 'Release stopped without finishing. Safe to resume.' });
    await saveBatch(batch);
  }

  try {
    await refreshPayment(batch);
    if (batch.status === 'paid' && autoReleases(batch)) await startRelease(batch.id);
    await refreshTracking(batch).catch(() => false);
  } catch (err) {
    return fail(err);
  }
  return json(200, { batch });
};
