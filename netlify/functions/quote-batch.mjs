/* ==========================================================================
   quote-batch  (read-only against Shopify — nothing is saved)

   Prices each recipient at their own destination with draftOrderCalculate,
   so tax is whatever Shopify would charge for that address. The console
   calls this in small chunks and shows progress; a whole 300-recipient
   batch would not fit inside a single function's time limit.
   ========================================================================== */

import { gql, money, fromCents } from '../lib/shopify.mjs';
import { json, fail, denied, rules } from '../lib/common.mjs';

const MAX_PER_CALL = 8;

const CALC = `
  mutation QuoteRecipient($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        currencyCode
        totalLineItemsPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        taxLines { title rate priceSet { shopMoney { amount } } }
      }
      userErrors { field message }
    }
  }`;

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const no = denied(req);
  if (no) return no;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  const { recipients = [], pricing = {} } = body;
  if (!recipients.length || recipients.length > MAX_PER_CALL) {
    return json(400, { error: 'chunk', message: `Send 1 to ${MAX_PER_CALL} recipients per call.` });
  }

  const currencyCode = rules.pricing.currencyCode;
  const discountPct = Number(pricing.discountPct) || 0;
  const shipping = Number(pricing.shippingPerRecipient);

  if (!(discountPct >= 0 && discountPct <= rules.pricing.maxDiscountPct)) {
    return json(400, { error: 'discount', message: `Discount must be 0–${rules.pricing.maxDiscountPct}%.` });
  }
  if (!(shipping >= 0)) {
    return json(400, { error: 'shipping', message: 'Shipping per recipient must be 0 or more.' });
  }

  const quotes = {};

  try {
    for (const r of recipients) {
      const input = {
        lineItems: r.lines.map((l) => ({ variantId: l.variantId, quantity: Number(l.qty) })),
        shippingAddress: {
          firstName: r.firstName, lastName: r.lastName, company: r.company || null,
          address1: r.address1, address2: r.address2 || null,
          city: r.city, provinceCode: r.state, zip: r.zip, countryCode: 'US',
          phone: r.phone || null
        },
        shippingLine: {
          title: rules.pricing.shippingTitle,
          priceWithCurrency: { amount: shipping.toFixed(2), currencyCode }
        },
        taxExempt: false
      };
      if (discountPct > 0) {
        input.appliedDiscount = {
          title: 'Corporate batch discount',
          value: discountPct,
          valueType: 'PERCENTAGE'
        };
      }

      // draftOrderCalculate saves nothing, so it is safe to retry.
      const data = await gql(CALC, { input }, { safeToRetry: true });
      const out = data.draftOrderCalculate;

      if (out.userErrors.length) {
        quotes[r.key] = { error: out.userErrors.map((e) => e.message).join('; ') };
        continue;
      }

      const c = out.calculatedDraftOrder;
      const gross = money(c.totalLineItemsPriceSet);
      const discount = money(c.totalDiscountsSet);
      const ship = money(c.totalShippingPriceSet);
      const tax = money(c.totalTaxSet);
      const total = money(c.totalPriceSet);

      quotes[r.key] = {
        // Everything in integer cents; formatted copies for display.
        cents: { gross, discount, merchandise: total - ship - tax, shipping: ship, tax, total },
        display: {
          gross: fromCents(gross), discount: fromCents(discount),
          merchandise: fromCents(total - ship - tax), shipping: fromCents(ship),
          tax: fromCents(tax), total: fromCents(total)
        },
        taxLines: c.taxLines.map((t) => ({
          title: t.title, rate: t.rate, cents: money(t.priceSet)
        }))
      };
    }
  } catch (err) {
    return fail(err);
  }

  return json(200, { currencyCode, quotes });
};
