/* ==========================================================================
   Catalog, per-recipient quoting with live carrier rates, and quote signing.

   Every quote the public page receives is signed. At submit the server
   checks the signature, so a customer can't edit a price, a discount or a
   shipping charge in their browser and have it accepted.
   ========================================================================== */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { gql, env, money, fromCents } from './shopify.mjs';
import { rules } from './common.mjs';
import { displayTitle } from '../../shared/giftmatch.mjs';

/* --- Catalog --------------------------------------------------------------- */

const CATALOG = `
  query Catalog($q: String!, $after: String) {
    productVariants(first: 250, query: $q, after: $after) {
      edges { node {
        id sku title price availableForSale
        product { id title status handle featuredMedia { preview { image { url } } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const CATALOG_TTL_MS = 15 * 60 * 1000;

export async function loadCatalog({ fresh = false } = {}) {
  const store = getStore({ name: 'bulk-cache', consistency: 'strong' });
  if (!fresh) {
    const hit = await store.get('catalog', { type: 'json' });
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.items;
  }
  const items = [];
  let after = null;
  do {
    const data = await gql(CATALOG, { q: rules.catalog.variantQuery, after });
    for (const { node } of data.productVariants.edges) {
      if (!node.sku || node.product.status !== 'ACTIVE') continue;
      items.push({
        sku: node.sku,
        variantId: node.id,
        title: displayTitle(node.product.title) + (node.title && node.title !== 'Default Title' ? ` — ${node.title}` : ''),
        price: node.price,
        available: node.availableForSale,
        image: (node.product.featuredMedia && node.product.featuredMedia.preview &&
                node.product.featuredMedia.preview.image && node.product.featuredMedia.preview.image.url) || null
      });
    }
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);
  items.sort((a, b) => a.title.localeCompare(b.title));
  await store.setJSON('catalog', { at: Date.now(), items });
  return items;
}

/* --- Quoting ---------------------------------------------------------------- */

const CALC = `
  mutation Quote($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        availableShippingRates { handle title price { amount } }
        totalLineItemsPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        taxLines { title rate priceSet { shopMoney { amount } } }
      }
      userErrors { field message }
    }
  }`;

function pickRate(rates) {
  if (!rates || !rates.length) return null;
  for (const want of rules.pricing.preferredRates || []) {
    const hit = rates.find((r) => r.title.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  return [...rates].sort((a, b) => parseFloat(a.price.amount) - parseFloat(b.price.amount))[0];
}

/**
 * Price one recipient at their own address.
 *   flatShipping: number (dollars) → that flat rate; null → live carrier rate.
 * draftOrderCalculate saves nothing, so both calls are safe to retry.
 */
export async function quoteRecipient(r, { discountPct = 0, flatShipping = null }) {
  const currencyCode = rules.pricing.currencyCode;
  const input = {
    lineItems: r.lines.map((l) => ({ variantId: l.variantId, quantity: Number(l.qty) })),
    shippingAddress: {
      firstName: r.firstName, lastName: r.lastName, company: r.company || null,
      address1: r.address1, address2: r.address2 || null,
      city: r.city, provinceCode: r.state, zip: r.zip, countryCode: 'US', phone: r.phone || null
    }
  };
  if (discountPct > 0) {
    input.appliedDiscount = { title: 'Corporate volume discount', value: discountPct, valueType: 'PERCENTAGE' };
  }

  let shippingTitle = rules.pricing.shippingTitle;

  if (flatShipping != null) {
    input.shippingLine = { title: shippingTitle, priceWithCurrency: { amount: Number(flatShipping).toFixed(2), currencyCode } };
  } else {
    const first = (await gql(CALC, { input }, { safeToRetry: true })).draftOrderCalculate;
    if (first.userErrors.length) return { error: first.userErrors.map((e) => e.message).join('; ') };
    const rate = pickRate(first.calculatedDraftOrder.availableShippingRates);
    if (!rate) return { error: 'No shipping service is available to this address.' };
    shippingTitle = rate.title;
    // Price again with the rate applied, so tax on shipping (where a state
    // charges it) is included exactly as checkout would.
    input.shippingLine = { shippingRateHandle: rate.handle };
  }

  const out = (await gql(CALC, { input }, { safeToRetry: true })).draftOrderCalculate;
  if (out.userErrors.length) return { error: out.userErrors.map((e) => e.message).join('; ') };

  const c = out.calculatedDraftOrder;
  const gross = money(c.totalLineItemsPriceSet);
  const discount = money(c.totalDiscountsSet);
  const shipping = money(c.totalShippingPriceSet);
  const tax = money(c.totalTaxSet);
  const total = money(c.totalPriceSet);
  const merchandise = total - shipping - tax;

  return {
    shippingTitle,
    discountPct,
    cents: { gross, discount, merchandise, shipping, tax, total },
    display: {
      gross: fromCents(gross), discount: fromCents(discount), merchandise: fromCents(merchandise),
      shipping: fromCents(shipping), tax: fromCents(tax), total: fromCents(total)
    },
    taxLines: c.taxLines.map((t) => ({ title: t.title, rate: t.rate, cents: money(t.priceSet) }))
  };
}

/* --- Signing ------------------------------------------------------------------ */

const QUOTE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

function signingKey() {
  const explicit = env('QUOTE_SIGNING_KEY');
  if (explicit) return explicit;
  const token = env('SHOPIFY_ADMIN_TOKEN');
  if (!token) throw new Error('No signing key available.');
  return createHash('sha256').update('bulk-quote-signing:' + token).digest('hex');
}

// What a quote is bound to: where it goes, what's in it, and what it costs.
function quoteBasis(r, q) {
  return JSON.stringify([
    r.firstName, r.lastName, r.address1, r.address2 || '', r.city, r.state, r.zip,
    [...r.lines].map((l) => `${l.sku}x${Number(l.qty)}`).sort(),
    q.discountPct, q.shippingTitle,
    q.cents.gross, q.cents.discount, q.cents.merchandise, q.cents.shipping, q.cents.tax, q.cents.total,
    q.signedAt
  ].map((v) => (typeof v === 'string' ? v.toLowerCase().trim() : v)));
}

export function signQuote(r, q) {
  q.signedAt = Date.now();
  q.sig = createHmac('sha256', signingKey()).update(quoteBasis(r, q)).digest('hex');
  return q;
}

export function verifyQuote(r, q) {
  if (!q || !q.sig || !q.signedAt || !q.cents) return 'missing';
  if (Date.now() - q.signedAt > QUOTE_MAX_AGE_MS) return 'expired';
  const expect = createHmac('sha256', signingKey()).update(quoteBasis(r, q)).digest('hex');
  const a = Buffer.from(expect), b = Buffer.from(String(q.sig));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'tampered';
  return null;
}
