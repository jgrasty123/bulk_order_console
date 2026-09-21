/* ==========================================================================
   Shopify Admin GraphQL client

   Paces itself against Shopify's leaky-bucket throttle instead of hammering
   until it gets rejected. A 300-recipient release makes ~300 sequential
   writes; without pacing, the back half of the batch fails on THROTTLED.
   ========================================================================== */

export const env = (k) =>
  (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get(k)) ??
  process.env[k];

export class ConfigError extends Error { name = 'ConfigError'; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep a cushion in the bucket so a burst from another app on the store
// does not push us into a THROTTLED response mid-batch.
const FLOOR = 150;

async function pace(throttle, requested) {
  if (!throttle) return;
  const { currentlyAvailable, restoreRate } = throttle;
  const need = Math.max(FLOOR, (requested || 10) * 2);
  if (currentlyAvailable < need && restoreRate > 0) {
    await sleep(Math.ceil(((need - currentlyAvailable) / restoreRate) * 1000));
  }
}

/* Retries. A read can always be retried. A write can only be retried when
   Shopify has told us it did NOT run it — an HTTP 429 or a THROTTLED error,
   both of which are rejected before execution. A dropped connection or a
   5xx on a write is ambiguous: the order may already exist. Retrying that
   is how one recipient ends up with two baskets, so those throw instead,
   and the release loop's sourceIdentifier lookup settles what happened. */

export class AmbiguousWriteError extends Error { name = 'AmbiguousWriteError'; }

export async function gql(query, variables = {}, { retries = 5, safeToRetry } = {}) {
  const isWrite = /^\s*mutation\b/.test(query);
  const retryAmbiguous = safeToRetry ?? !isWrite;

  const shop = env('SHOPIFY_SHOP');
  const token = env('SHOPIFY_ADMIN_TOKEN');
  const version = env('SHOPIFY_API_VERSION') || '2026-07';

  if (!shop || !token) {
    throw new ConfigError('SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN are not set on this deploy.');
  }

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (netErr) {
      if (!retryAmbiguous) {
        throw new AmbiguousWriteError(
          `Connection lost before Shopify answered (${netErr.message}). The write may or may not have gone through.`
        );
      }
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw netErr;
    }

    if (res.status === 429) {
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error(`Shopify kept rate-limiting after ${retries} retries.`);
    }

    if (res.status >= 500) {
      if (!retryAmbiguous) {
        throw new AmbiguousWriteError(
          `Shopify returned ${res.status} to a write. It may or may not have gone through.`
        );
      }
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error(`Shopify responded ${res.status} after ${retries} retries.`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ConfigError(
        `Shopify rejected the Admin token (${res.status}). Check the token and its scopes.`
      );
    }

    if (!res.ok) {
      throw new Error(`Shopify responded ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    const body = await res.json();
    const cost = body.extensions && body.extensions.cost;

    const throttled = (body.errors || []).some(
      (e) => e.extensions && e.extensions.code === 'THROTTLED'
    );
    if (throttled && attempt < retries) {
      await pace(cost && cost.throttleStatus, cost && cost.requestedQueryCost);
      await sleep(500 * (attempt + 1));
      continue;
    }

    if (body.errors) {
      const msg = body.errors.map((e) => e.message).join('; ');
      if (/access denied|scope/i.test(msg)) throw new ConfigError(msg);
      throw new Error(`Shopify GraphQL: ${msg}`);
    }

    await pace(cost && cost.throttleStatus, cost && cost.requestedQueryCost);
    return body.data;
  }
}

/* --- Money --------------------------------------------------------------
   All arithmetic in integer cents. Shopify returns decimal strings; float
   addition across 300 recipients drifts by a cent or two, which is exactly
   the kind of discrepancy that makes an invoice look wrong to a client.
   ------------------------------------------------------------------------ */

export const toCents = (amount) => Math.round(parseFloat(amount || '0') * 100);
export const fromCents = (c) => (c / 100).toFixed(2);
export const money = (obj) => (obj && obj.shopMoney ? toCents(obj.shopMoney.amount) : 0);
