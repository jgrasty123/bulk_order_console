/* ==========================================================================
   validate-batch
   Resolves every SKU in the sheet to a real Shopify variant, reports stock,
   and applies destination-state screening.

   This runs before any order is created. It is read-only.
   ========================================================================== */

const rules = require('../../config/shipping-rules.json');

const SHOP        = process.env.SHOPIFY_SHOP;          // e.g. bro-basket.myshopify.com
const TOKEN       = process.env.SHOPIFY_ADMIN_TOKEN;   // offline Admin API token
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

const CHUNK = 40;   // SKUs per query — keeps the search string well under limits

const VARIANT_QUERY = `
  query ResolveSkus($q: String!) {
    productVariants(first: 250, query: $q) {
      edges {
        node {
          id
          sku
          title
          displayName
          price
          inventoryQuantity
          inventoryItem { tracked }
          product { id title status }
        }
      }
    }
  }`;

async function shopifyGraphql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    throw new Error(`Shopify responded ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();
  if (body.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size));

function screen(states) {
  const { mode, shippableStates } = rules.screening;
  if (mode !== 'allowlist' || !shippableStates.length) {
    return { mode: 'off', blocked: [] };
  }
  const allowed = new Set(shippableStates.map(s => s.toUpperCase()));
  return {
    mode: 'allowlist',
    blocked: states.filter(s => !allowed.has(String(s).toUpperCase()))
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Use POST.' };
  }

  if (!SHOP || !TOKEN) {
    return {
      statusCode: 503,
      body: JSON.stringify({
        error: 'not_configured',
        message: 'SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN are not set on this deploy.'
      })
    };
  }

  let skus = [], states = [];
  try {
    ({ skus = [], states = [] } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) };
  }

  const found = {};

  try {
    for (const group of chunk(skus, CHUNK)) {
      const q = group.map(s => `sku:'${String(s).replace(/'/g, "\\'")}'`).join(' OR ');
      const data = await shopifyGraphql(VARIANT_QUERY, { q });

      data.productVariants.edges.forEach(({ node }) => {
        if (!node.sku) return;
        found[node.sku] = {
          found: true,
          variantId: node.id,
          productId: node.product.id,
          title: node.product.title,
          variantTitle: node.title,
          price: node.price,
          active: node.product.status === 'ACTIVE',
          tracked: Boolean(node.inventoryItem && node.inventoryItem.tracked),
          available: node.inventoryQuantity == null ? 0 : node.inventoryQuantity
        };
      });
    }
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'shopify_unreachable', message: err.message })
    };
  }

  // Anything the store did not return simply does not exist under that SKU.
  skus.forEach(s => { if (!found[s]) found[s] = { found: false }; });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      shop: SHOP.replace('.myshopify.com', ''),
      apiVersion: API_VERSION,
      skus: found,
      screening: screen(states)
    })
  };
};
