/* order-catalog (public) — the gifts a corporate customer can choose from. */

import { json, fail } from '../lib/common.mjs';
import { loadCatalog } from '../lib/pricing.mjs';
import { rateLimited } from '../lib/guard.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'method' });
  const limited = await rateLimited(req, 'catalog', 120);
  if (limited) return limited;
  try {
    const items = await loadCatalog();
    return new Response(JSON.stringify({
      items: items.map(({ sku, title, price, available, image, kind }) => ({ sku, title, price, available, image, kind }))
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
  } catch (err) {
    return fail(err);
  }
};
