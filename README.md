# Bulk Order Console

Internal tool for Go-To Gifting LLC. Takes a recipient spreadsheet for a
corporate gift order and turns it into separate Shopify orders — one per
recipient, each with its own destination address.

Replaces the Zest concierge workflow.

---

## Where this is

**Built:** scaffold, CSV ingest, validation engine, editable review grid,
issue ledger, Shopify SKU/stock lookup, destination-screening hook.

**Not built yet:** order creation. The Create orders button is deliberately
inert. See *Order model* below for what it will do.

---

## The sheet

One row per gift, not one row per person. Rows that share a `recipient_id`
collapse into a single order with several line items — which is the thing
Zest could not do without a separate recipient list per product.

| Column | Required | Notes |
|---|---|---|
| `recipient_id` | no | Blank means this row is its own order |
| `first_name`, `last_name` | yes | |
| `company` | no | |
| `address1`, `address2` | `address1` | No PO boxes, no APO/FPO |
| `city`, `state`, `zip` | yes | State accepts `Montana` or `MT` |
| `phone` | no | Warned if missing — carriers want it on signature deliveries |
| `email` | no | Used for shipment notifications |
| `sku` | yes | Must resolve to a live Shopify variant |
| `qty` | yes | Whole number |
| `gift_message` | no | Per recipient, not per line |
| `delivery_date` | no | `YYYY-MM-DD`, cannot be in the past |

`templates/bulk-order-template.csv` is the canonical example.

---

## Order model

Settled: **the customer pays one Shopify draft-order invoice for the batch
total. Child orders go in at $0.**

```
        parent draft order                 child orders (one per recipient)
   ┌──────────────────────────┐        ┌────────────────────────────────────┐
   │ custom line item:        │        │ real variants, real destination    │
   │ "Bulk batch B20261211-… "│        │ $0 line prices                     │
   │ priced at the batch total│        │ tags: bulk-child, batch-…          │
   │ tags: bulk-parent        │  ────▶ │ note attrs: gift message, delivery │
   │ → invoice → customer pays│        │              date, adult signature │
   └──────────────────────────┘        └────────────────────────────────────┘
        carries the revenue                  carries the fulfillment
```

Why: revenue and payment land once (parent), inventory decrements once
(children), and ShipStation pulls children by tag exactly like any other
order. The parent's line item is a custom line, so it does not touch stock.

**The consequence to plan around:** Shopify's tax reports will show tax as a
lump on the parent rather than attributed per destination state. The tool
therefore has to emit a per-destination tax CSV with every batch, for
bookkeeping. Not built yet.

---

## Validation codes

Blocking issues lock the create step. Warnings do not.

| Code | Sev | Meaning |
|---|---|---|
| E10–E13 | stop | Name, street, or city missing |
| E14 | stop | State is not a US state |
| E15 | stop | ZIP is not 5 or 5+4 |
| E16 | stop | SKU missing |
| E17 | stop | Quantity not a whole number in range |
| E18 | stop | Delivery date unreadable or past |
| E19 | stop | PO box — carriers will not deliver alcohol |
| E20 | stop | Destination state not on the shippable list |
| E21 | stop | No Shopify product has this SKU |
| E22 | stop | Batch over the row limit |
| E23 | stop | One `recipient_id` used on conflicting addresses |
| E24 | stop | APO / FPO / DPO destination |
| E30 | stop | Gift message over the character limit |
| W01 | warn | Same person and SKU as an earlier row — likely a duplicated paste |
| W02 | warn | Email is malformed |
| W03 | warn | Stock on hand is below the quantity asked for |
| W06 | warn | No usable phone number |

---

## Compliance — read before going live

`[REVIEW]` Orders created through the Admin API **never pass through Shopify
checkout**. The age gate and destination-state screening that the storefronts
rely on do not run for a bulk batch. That enforcement has to happen here, in
validation, or it does not happen at all.

`config/shipping-rules.json` ships with `screening.mode` set to `off` and an
empty state list, and the console shows a standing warning while that is true.
The list needs attorney sign-off before this touches a real batch. Same open
item as the brand portals.

Adult signature is set on every child order by default
(`orderDefaults.requireAdultSignature`).

---

## Running it

```
npm i -g netlify-cli      # once
netlify dev               # serves the site and the functions together
```

Environment variables: see `.env.example`. Nothing works against Shopify
without `SHOPIFY_SHOP` and `SHOPIFY_ADMIN_TOKEN`; the structural half of
validation still runs without them and the ledger says so.

**Token note.** Shopify closed admin-created custom apps on 1 January 2026.
If `bro-basket.myshopify.com` already has a pre-2026 custom app, reuse its
static `shpat_` token. If not, the app has to be created in the Dev Dashboard
and its tokens expire roughly daily, which means building a refresh routine.
Check which situation applies before anything else — it changes the auth work
materially. `orderCreate` and the draft-order mutations additionally require
an **offline** token; an online/per-user token will be rejected.

---

## Next

1. Confirm the token situation above.
2. Per-recipient draft orders → sum → parent invoice.
3. Background function for the create loop (15 min ceiling; a plain function
   times out at 10s and 300 orders will not fit).
4. Idempotency: hash each row into an order metafield, check before creating,
   so a retry after a partial failure cannot double-charge or double-ship.
5. Per-destination tax export.
6. Then the customer-facing front door.
