/* ==========================================================================
   validate-batch  (read-only)
   Resolves SKUs to live variants and applies destination screening.

   Screening defaults to the store's own shipping zones, so a bulk batch is
   held to exactly the same destinations checkout allows. Bulk orders never
   pass through checkout, so this is where that rule has to be enforced.
   ========================================================================== */

import { gql, env } from '../lib/shopify.mjs';
import { json, fail, denied, rules } from '../lib/common.mjs';

const CHUNK = 40;

const VARIANTS = `
  query ResolveSkus($q: String!) {
    productVariants(first: 250, query: $q) {
      edges { node {
        id sku title displayName price inventoryQuantity
        inventoryItem { tracked }
        product { id title status }
      } }
    }
  }`;

const ZONES = `
  query ShippingZones {
    deliveryProfiles(first: 20) {
      edges { node {
        name default
        profileLocationGroups {
          locationGroupZones(first: 100) {
            edges { node { zone { name countries { code { countryCode } provinces { code } } } } }
          }
        }
      } }
    }
  }`;

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function resolveSkus(skus) {
  const found = {};
  for (const group of chunk(skus, CHUNK)) {
    const q = group.map((s) => `sku:'${String(s).replace(/'/g, "\\'")}'`).join(' OR ');
    const data = await gql(VARIANTS, { q });
    for (const { node } of data.productVariants.edges) {
      if (!node.sku || !group.includes(node.sku)) continue;
      // If a SKU is duplicated across variants, prefer the active product.
      const prev = found[node.sku];
      if (prev && prev.active && node.product.status !== 'ACTIVE') continue;
      found[node.sku] = {
        found: true,
        variantId: node.id,
        productId: node.product.id,
        title: node.product.title,
        variantTitle: node.title === 'Default Title' ? '' : node.title,
        price: node.price,
        active: node.product.status === 'ACTIVE',
        tracked: Boolean(node.inventoryItem && node.inventoryItem.tracked),
        available: node.inventoryQuantity == null ? 0 : node.inventoryQuantity,
        duplicate: Boolean(prev)
      };
    }
  }
  skus.forEach((s) => { if (!found[s]) found[s] = { found: false }; });
  return found;
}

async function screen(states) {
  const cfg = rules.screening;

  if (cfg.mode === 'allowlist') {
    const allowed = new Set(cfg.shippableStates.map((s) => s.toUpperCase()));
    return {
      mode: 'allowlist',
      source: 'config/shipping-rules.json',
      allowed: [...allowed].sort(),
      blocked: states.filter((s) => !allowed.has(s))
    };
  }

  if (cfg.mode === 'shopify-zones') {
    const data = await gql(ZONES);
    const profiles = data.deliveryProfiles.edges.map((e) => e.node);
    const want = cfg.deliveryProfile || 'default';
    const profile = want === 'default'
      ? profiles.find((p) => p.default)
      : profiles.find((p) => p.name === want);

    if (!profile) {
      return {
        mode: 'error',
        message: `Shipping profile "${want}" was not found. Available: ${profiles.map((p) => p.name).join(', ')}`,
        blocked: []
      };
    }

    const allowed = new Set();
    for (const group of profile.profileLocationGroups) {
      for (const { node } of group.locationGroupZones.edges) {
        for (const c of node.zone.countries) {
          if (c.code.countryCode !== (cfg.countryCode || 'US')) continue;
          c.provinces.forEach((p) => allowed.add(p.code));
        }
      }
    }

    return {
      mode: 'shopify-zones',
      source: `Shipping profile "${profile.name}"`,
      allowed: [...allowed].sort(),
      blocked: states.filter((s) => !allowed.has(s))
    };
  }

  return { mode: 'off', blocked: [] };
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let skus = [], states = [];
  try {
    ({ skus = [], states = [] } = await req.json());
  } catch {
    return json(400, { error: 'bad_json' });
  }

  try {
    const [skuMap, screening] = await Promise.all([resolveSkus(skus), screen(states)]);
    return json(200, {
      shop: (env('SHOPIFY_SHOP') || '').replace('.myshopify.com', ''),
      currencyCode: rules.pricing.currencyCode,
      skus: skuMap,
      screening
    });
  } catch (err) {
    return fail(err);
  }
};
