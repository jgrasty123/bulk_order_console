# Bulk Order Console

Internal tool for Go-To Gifting LLC. Turns a corporate recipient spreadsheet
into one invoice for the buyer and, once it is paid, one Shopify order per
recipient. Replaces the Zest concierge workflow.

Live: https://coporate-order-portal.netlify.app/ · Store: `new-brobasket.myshopify.com`

---

## Flow

```
01 Upload sheet ─▶ 02 Check rows ─▶ 03 Quote ─▶ 04 Invoice + payment ─▶ 05 Release orders
   CSV              structural +      Shopify prices     parent draft order      one $0 order per
                    Shopify checks    each destination   emailed to buyer        recipient, after paid
```

Nothing reaches Shopify as a write until step 04, and no recipient order
exists until the parent invoice is paid.

---

## The sheet

One row per gift, not one row per person. Rows sharing a `recipient_id`
become one order with several items; the same SKU twice in a group is summed.

| Column | Required | Notes |
|---|---|---|
| `recipient_id` | no | Blank = this row is its own order |
| `first_name`, `last_name` | yes | |
| `company` | no | |
| `address1`, `address2` | `address1` | No PO boxes, no APO/FPO/DPO |
| `city`, `state`, `zip` | yes | State accepts `Montana` or `MT` |
| `phone` | no | Warned if missing — carriers want it on signature deliveries |
| `email` | no | Stored on the order; recipients are never emailed by Shopify |
| `sku` | yes | Must resolve to a Shopify variant |
| `qty` | yes | Whole number |
| `gift_message` | no | One per order; first non-empty in a group wins |
| `delivery_date` | no | `YYYY-MM-DD`, not in the past, one per order |

`templates/bulk-order-template.csv` is the canonical example.
`templates/test-broken-sample.csv` exercises most of the error codes.

---

## Order model

**The buyer pays one Shopify draft-order invoice. Child orders go in at $0.**

```
   parent draft order                       child orders (one per recipient)
 ┌─────────────────────────────────┐      ┌─────────────────────────────────────┐
 │ custom lines, no inventory:     │      │ real variants, real destination     │
 │   Corporate gift batch B…       │      │ $0 lines, financial status PAID     │
 │   Shipping — N destinations     │ ───▶ │ tags: bulk-child, batch-B…          │
 │   Sales tax — per destination   │ paid │ attrs: gift message, delivery date, │
 │ taxExempt (tax is its own line) │      │        adult signature, parent #    │
 │ tags: bulk-parent, batch-B…     │      │ no customer, no Shopify emails      │
 └─────────────────────────────────┘      └─────────────────────────────────────┘
        carries revenue + payment               carries fulfilment + inventory
```

Tax is calculated by Shopify at each recipient's address (`draftOrderCalculate`)
and summed onto the parent. Shopify's own tax reports will therefore show it as
one lump on the parent — **use the tax breakdown CSV for bookkeeping**; it has
every destination's tax, rate and jurisdiction.

Paid by check or wire: mark the parent draft paid in Shopify admin, then press
**Check payment** in the console.

---

## Safety properties (all covered by tests)

- **No duplicate orders.** Every child order carries `sourceIdentifier` = a hash
  of batch + recipient. Release looks them up first, so a retry or Resume finds
  existing orders instead of creating new ones.
- **Ambiguous writes are never auto-retried.** If a connection drops or Shopify
  returns 5xx on a write, the order may exist. The client records a failure
  rather than retrying; Resume settles it by `sourceIdentifier`. (Retrying here
  would ship a second gift.) Throttle rejections are retried — Shopify refuses
  those before executing.
- **One invoice per batch, one release at a time.** Claims are write-then-verify
  in Netlify Blobs, so a double-click or two overlapping runs cannot both win.
- **Release survives timeouts.** Progress is saved after every recipient; the
  background function stops cleanly before its 15-minute limit and Resume
  continues from there. Netlify's automatic retries are harmless.
- **Access key on everything.** Every function refuses without `CONSOLE_KEY`,
  and refuses entirely if it is not set on the deploy.

---

## Destination screening

Bulk orders never pass through checkout, so checkout's destination rules do
not run for them. The console applies them itself:

`config/shipping-rules.json` → `screening.mode`:

- `shopify-zones` (default) — reads the store's shipping zones live from the
  named delivery profile (`"default"` = the General profile) and blocks any
  state not in them. Same destinations as checkout.
- `allowlist` — uses `shippableStates` instead.
- `off` — no screening; the console shows a warning.

Adult signature is set on every child order.

---

## Validation codes

Blocking issues lock the next step. Warnings do not.

| Code | Sev | Meaning |
|---|---|---|
| E10–E13 | stop | Name, street, or city missing |
| E14 | stop | Not a US state |
| E15 | stop | ZIP not 5 or 5+4 |
| E16 | stop | SKU missing |
| E17 | stop | Quantity not a whole number in range |
| E18 | stop | Delivery date unreadable or past |
| E19 | stop | PO box |
| E20 | stop | State not in the store's shipping zones |
| E21 | stop | No Shopify variant has this SKU |
| E22 | stop | Batch over the row limit |
| E23 | stop | One `recipient_id` on conflicting addresses |
| E24 | stop | APO / FPO / DPO |
| E25 | stop | Group has conflicting gift messages (only if `giftMessageConflict: "block"`) |
| E26 | stop | Group has conflicting delivery dates |
| E30 | stop | Gift message over the character limit |
| Q01 | stop | Shopify could not price this recipient (usually the address) |
| W01 | warn | Same person, address and SKU as an earlier row |
| W02 | warn | Email malformed |
| W03 | warn | Batch needs more than is on hand |
| W04 | warn | Product is draft or archived |
| W06 | warn | No usable phone number |
| W07 | warn | Group has different gift messages — first is used |

---

## Setup

Netlify → Site configuration → Environment variables (see `.env.example`):

| Variable | Value |
|---|---|
| `CONSOLE_KEY` | Long random passphrase. **Set this first.** |
| `SHOPIFY_SHOP` | `new-brobasket.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | Offline Admin token (`shpat_…`) |
| `SHOPIFY_API_VERSION` | `2026-07` |

Token scopes: `read_products`, `read_inventory`, `read_shipping`,
`read_draft_orders`, `write_draft_orders`, `read_orders`, `write_orders`.

Shopify closed admin-created custom apps on 1 January 2026. Reuse a pre-2026
custom app's static token if the store has one; otherwise a Dev Dashboard app's
tokens expire roughly daily and need a refresh routine (not built).

**First run:** tick **Test batch**. No invoice is created and child orders are
Shopify test orders tagged `bulk-test`. Check one in admin, ShipStation, and on a
packing slip before running a real batch.

---

## Layout

```
index.html, assets/          console (vanilla JS, PapaParse)
config/shipping-rules.json   screening, limits, pricing, order attribute keys
netlify/lib/                 Shopify client, auth gate, Blobs storage
netlify/functions/
  validate-batch.mjs         SKUs → variants, stock, destination screening
  quote-batch.mjs            per-destination price, shipping, tax (≤8 per call)
  create-batch.mjs           save batch, create parent invoice (or test batch)
  send-invoice.mjs           email the invoice via Shopify
  batch-status.mjs           load / refresh payment state / list batches
  release-batch-background.mjs  create child orders (15-min background)
```

---

## Open

1. Match `giftMessageAttributeKey` / `deliveryDateAttributeKey` to what the
   BroBasket storefront writes, so ShipStation and packing slips read bulk
   orders the same way as web orders.
2. Confirm the delivery profile used for screening is the one alcohol ships under.
3. Token refresh routine, if the store has no pre-2026 custom app.
4. Customer-facing front door (Phase 2).
