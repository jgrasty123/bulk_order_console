/* End-to-end checks for the order pipeline: real bundled functions, a local
   Netlify Blobs server, and a mocked Shopify Admin API. Run with `npm test`. */

import { BlobsServer } from '@netlify/blobs/server';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// ---------- environment ----------
const port = 18765;
const server = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), 'blobs-')), token: 'tok', port });
await server.start();
const edge = `http://localhost:${port}`;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
  siteID: 'site', token: 'tok', edgeURL: edge, uncachedEdgeURL: edge
})).toString('base64');
process.env.CONSOLE_KEY = 'secret-key';
process.env.SHOPIFY_SHOP = 'new-brobasket.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_test';
process.env.SHOPIFY_API_SECRET = 'shpss_test_secret';
process.env.URL = 'https://console.test';

// ---------- mock Shopify ----------
const V = {
  'BSKT-053': { id: 'gid://shopify/ProductVariant/53', price: '249.95', qty: 50, title: 'A Gin and Tonic Dream Gift Basket', status: 'ACTIVE' },
  'BSKT-016': { id: 'gid://shopify/ProductVariant/16', price: '319.95', qty: 3,  title: 'A World of Whiskey Gift Basket', status: 'ACTIVE' },
  'BSKT-032': { id: 'gid://shopify/ProductVariant/32', price: '169.95', qty: 40, title: 'BBQ Bash Gift Basket', status: 'ACTIVE' }
};
const byId = Object.fromEntries(Object.entries(V).map(([sku, v]) => [v.id, { sku, ...v }]));
const ZONE_STATES = ['CA', 'TX', 'MI', 'MT', 'NY'];
const TAX = { CA: 0.0875, TX: 0.0825 };
const S = { drafts: {}, orders: [], createCalls: 0, failSkuOnce: null, dropResponseOnce: false, draftN: 1000, orderN: 5000 };

const cents = a => Math.round(parseFloat(a) * 100);
const amt = c => (c / 100).toFixed(2);
const bag = c => ({ shopMoney: { amount: amt(c), currencyCode: 'USD' } });
const throttle = { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 }, requestedQueryCost: 10 };

function handle(query, vars) {
  if (query.includes('ResolveSkus')) {
    const skus = [...vars.q.matchAll(/sku:'([^']+)'/g)].map(m => m[1]);
    return { productVariants: { edges: skus.filter(s => V[s]).map(s => ({ node: {
      id: V[s].id, sku: s, title: 'Default Title', displayName: V[s].title, price: V[s].price,
      inventoryQuantity: V[s].qty, inventoryItem: { tracked: true },
      product: { id: 'gid://shopify/Product/' + s, title: V[s].title, status: V[s].status } } })) } };
  }
  if (query.includes('query Catalog')) {
    return { productVariants: { edges: Object.entries(V).map(([sku, v]) => ({ node: {
      id: v.id, sku, title: 'Default Title', price: v.price, availableForSale: true,
      product: { id: 'gid://shopify/Product/' + sku, title: v.title, status: v.status, handle: sku.toLowerCase(),
        featuredMedia: { preview: { image: { url: 'https://cdn.test/' + sku + '.jpg' } } } } } })),
      pageInfo: { hasNextPage: false, endCursor: null } } };
  }
  if (query.includes('ShippingZones')) {
    return { deliveryProfiles: { edges: [{ node: { name: 'General Profile', default: true, profileLocationGroups: [{
      locationGroupZones: { edges: [{ node: { zone: { name: 'Domestic', countries: [{ code: { countryCode: 'US' },
        provinces: ZONE_STATES.map(code => ({ code })) }] } } }] } }] } }] } };
  }
  if (query.includes('draftOrderCalculate')) {
    const i = vars.input;
    if (/BADADDR/.test(i.shippingAddress.address1)) {
      return { draftOrderCalculate: { calculatedDraftOrder: null, userErrors: [{ field: ['shippingAddress'], message: 'Address is not valid' }] } };
    }
    const gross = i.lineItems.reduce((n, l) => n + cents(byId[l.variantId].price) * l.quantity, 0);
    const pct = i.appliedDiscount ? i.appliedDiscount.value : 0;
    let discount = Math.round(gross * pct / 100);
    // Store discount codes, matched case-insensitively as Shopify does:
    // SAVE15 = 15% off, FIFTY = $50 off, anything else silently ignored.
    for (const raw of i.discountCodes || []) {
      const c = String(raw).toUpperCase();
      if (c === 'SAVE15') discount += Math.round(gross * 0.15);
      else if (c === 'FIFTY') discount += 5000;
    }
    const units = i.lineItems.reduce((n, l) => n + l.quantity, 0);
    const RATES = [
      { handle: 'h-ground-' + i.shippingAddress.provinceCode + '-' + units, title: 'UPS® Ground', price: { amount: amt(1500 + 400 * units) } },
      { handle: 'h-nda-' + i.shippingAddress.provinceCode + '-' + units, title: 'UPS Next Day Air®', price: { amount: amt(5900 + 900 * units) } }
    ];
    S.calcCalls = (S.calcCalls || 0) + 1;
    let ship = 0;
    if (i.shippingLine && i.shippingLine.priceWithCurrency) ship = cents(i.shippingLine.priceWithCurrency.amount);
    else if (i.shippingLine && i.shippingLine.shippingRateHandle) {
      const hit = RATES.find(r => r.handle === i.shippingLine.shippingRateHandle);
      if (!hit) return { draftOrderCalculate: { calculatedDraftOrder: null, userErrors: [{ field: ['shippingLine'], message: 'Shipping rate expired' }] } };
      ship = cents(hit.price.amount);
    }
    const rate = TAX[i.shippingAddress.provinceCode] ?? 0.06;
    const tax = Math.round((gross - discount) * rate);
    return { draftOrderCalculate: { userErrors: [], calculatedDraftOrder: {
      currencyCode: 'USD', availableShippingRates: RATES, totalLineItemsPriceSet: bag(gross), totalDiscountsSet: bag(discount),
      subtotalPriceSet: bag(gross - discount), totalShippingPriceSet: bag(ship), totalTaxSet: bag(tax),
      totalPriceSet: bag(gross - discount + ship + tax),
      taxLines: [{ title: i.shippingAddress.provinceCode + ' State Tax', rate, priceSet: bag(tax) }] } } };
  }
  if (query.includes('draftOrderCreate')) {
    const gross = vars.input.lineItems.reduce((n, l) => n + cents(l.originalUnitPriceWithCurrency.amount) * l.quantity, 0);
    const d = vars.input.appliedDiscount;
    const total = gross - (d ? (d.valueType === 'FIXED_AMOUNT' ? cents(String(d.value)) : Math.round(gross * d.value / 100)) : 0);
    const id = 'gid://shopify/DraftOrder/' + (++S.draftN);
    S.drafts[id] = { id, name: '#D' + S.draftN, input: vars.input, total, order: null };
    return { draftOrderCreate: { userErrors: [], draftOrder: {
      id, name: '#D' + S.draftN, invoiceUrl: 'https://new-brobasket.myshopify.com/invoices/x', status: 'OPEN',
      totalPriceSet: { shopMoney: { amount: (total / 100).toString() } } } } };  // note: unpadded, like Shopify
  }
  if (query.includes('draftOrderInvoiceSend')) {
    S.drafts[vars.id].sent = true;
    S.drafts[vars.id].email = vars.email || null;
    return { draftOrderInvoiceSend: { userErrors: [], draftOrder: { id: vars.id, invoiceSentAt: new Date().toISOString() } } };
  }
  if (query.includes('ParentStatus')) {
    const d = S.drafts[vars.id];
    return { draftOrder: d ? { id: d.id, name: d.name, status: d.order ? 'COMPLETED' : 'OPEN', invoiceUrl: 'x', order: d.order } : null };
  }
  if (query.includes('ExistingChildren')) {
    const tag = vars.q.match(/tag:'([^']+)'/)[1];
    return { orders: { edges: S.orders.filter(o => o.tags.includes(tag)).map(o => ({ node: o })), pageInfo: { hasNextPage: false, endCursor: null } } };
  }
  if (query.includes('orderCreate')) {
    S.createCalls++;
    const o = vars.order;
    const sku = byId[o.lineItems[0].variantId].sku;
    if (S.failSkuOnce === sku) { S.failSkuOnce = null; return { orderCreate: { order: null, userErrors: [{ field: ['lineItems'], message: 'Not enough inventory', code: 'INVENTORY' }] } }; }
    const rec = { id: 'gid://shopify/Order/' + (++S.orderN), name: '#' + S.orderN, sourceIdentifier: o.sourceIdentifier, tags: o.tags, input: o, options: vars.options };
    S.orders.push(rec);
    if (S.dropResponseOnce) { S.dropResponseOnce = false; throw new Error('socket hang up'); }
    return { orderCreate: { userErrors: [], order: { id: rec.id, name: rec.name, sourceIdentifier: rec.sourceIdentifier } } };
  }
  throw new Error('Unmocked operation: ' + query.slice(0, 80));
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://console.test/.netlify/functions/')) {
    // Netlify answers a background call with 202 at once and runs it later.
    const name = String(url).split('/').pop();
    const h = (await import(`./.build/${name}.js`)).default;
    S.bgRuns = (S.bgRuns || []);
    S.bgRuns.push(h(new Request(String(url), init)));
    return new Response(null, { status: 202 });
  }
  if (String(url).includes('myshopify.com/admin/api')) {
    assert.equal(init.headers['X-Shopify-Access-Token'], 'shpat_test');
    const { query, variables } = JSON.parse(init.body);
    try {
      const data = handle(query, variables || {});
      return new Response(JSON.stringify({ data, extensions: { cost: throttle } }), { status: 200 });
    } catch (e) {
      if (e.message === 'socket hang up') throw new TypeError('fetch failed');
      throw e;
    }
  }
  return realFetch(url, init);
};

// ---------- function loader ----------
const fn = async name => (await import(`./.build/${name}.js`)).default;
const call = async (name, { method = 'POST', body, qs = '', key = 'secret-key' } = {}) => {
  const f = await fn(name);
  const req = new Request('https://console.test/.netlify/functions/' + name + qs, {
    method, headers: { 'Content-Type': 'application/json', 'x-console-key': key },
    body: body ? JSON.stringify(body) : undefined });
  const res = await f(req);
  if (!res) return { status: 202, data: null };
  return { status: res.status, data: await res.json() };
};

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };

// ---------- tests ----------
console.log('\nAccess gate');
ok((await call('validate-batch', { body: { skus: [], states: [] }, key: 'wrong' })).status === 401, 'wrong key is rejected');
{ const k = process.env.CONSOLE_KEY; delete process.env.CONSOLE_KEY;
  ok((await call('validate-batch', { body: { skus: [], states: [] } })).status === 503, 'no CONSOLE_KEY on deploy = everything locked');
  process.env.CONSOLE_KEY = k; }

console.log('\nValidate');
const v = await call('validate-batch', { body: { skus: ['BSKT-053', 'BSKT-016', 'NOPE-1'], states: ['CA', 'UT', 'TX'] } });
ok(v.status === 200, 'validate responds');
ok(v.data.skus['BSKT-053'].variantId === V['BSKT-053'].id, 'SKU resolves to variant id');
ok(v.data.skus['NOPE-1'].found === false, 'unknown SKU is reported as not found');
ok(v.data.screening.mode === 'shopify-zones' && v.data.screening.blocked.join() === 'UT', 'UT blocked by shipping zones, CA/TX allowed');

// Recipients as the console builds them
const mk = (first, city, state, zip, lines, extra = {}) => ({
  key: first, rows: [2], firstName: first, lastName: 'Test', company: 'Acme', address1: '1 Main St', address2: '',
  city, state, zip, phone: '8055550100', email: first.toLowerCase() + '@example.com',
  giftMessage: 'Great year, ' + first, deliveryDate: '', lines, ...extra });
const L = (sku, qty = 1) => ({ sku, variantId: V[sku].id, qty, title: V[sku].title, price: V[sku].price });
const recips = [
  mk('Ava', 'Los Angeles', 'CA', '90001', [L('BSKT-053')]),
  mk('Ben', 'Austin', 'TX', '73301', [L('BSKT-016'), L('BSKT-032', 2)]),
  mk('Cal', 'Detroit', 'MI', '48201', [L('BSKT-032')]),
  mk('Dee', 'Helena', 'MT', '59601', [L('BSKT-053')])
];

console.log('\nQuote');
const pricing = { discountPct: 10, shippingPerRecipient: 24 };
const q = await call('quote-batch', { body: { recipients: recips, pricing } });
ok(q.status === 200, 'quote responds');
const qa = q.data.quotes.Ava.cents;
ok(qa.gross === 24995 && qa.discount === 2500 && qa.merchandise === 22495, 'Ava: $249.95 less 10% = $224.95 merchandise');
ok(qa.tax === Math.round(22495 * 0.0875) && qa.shipping === 2400, 'Ava: CA tax on discounted price, $24 shipping');
ok(qa.total === qa.merchandise + qa.shipping + qa.tax, 'Ava: total reconciles to the cent');
const qb = q.data.quotes.Ben.cents;
ok(qb.gross === 31995 + 2 * 16995, 'Ben: two SKUs, qty 2, summed correctly');
const bad = await call('quote-batch', { body: { recipients: [mk('Zed', 'X', 'CA', '90001', [L('BSKT-053')], { address1: 'BADADDR' })], pricing } });
ok(bad.data.quotes.Zed.error === 'Address is not valid', 'Shopify address rejection surfaces per recipient');
ok((await call('quote-batch', { body: { recipients: Array(6).fill(recips[0]), pricing } })).status === 400, 'chunks over 5 are refused');
ok((await call('quote-batch', { body: { recipients: recips, pricing: { discountPct: 60, shippingPerRecipient: 0 } } })).status === 400, 'discount above the cap is refused');

const withQuotes = recips.map(r => ({ ...r, quote: q.data.quotes[r.key] }));
const expectTotal = withQuotes.reduce((n, r) => n + r.quote.cents.total, 0);
const expectTotalDiscount = withQuotes.reduce((n, r) => n + r.quote.cents.discount, 0);

console.log('\nCreate — invoice batch');
const buyer = { name: 'Pat Buyer', company: 'Acme Corp', email: 'pat@acme.com', poNumber: 'PO-77' };
ok((await call('create-batch', { body: { id: 'B20260921-INV1', buyer: { ...buyer, email: '' }, pricing, recipients: withQuotes } })).status === 400, 'invoice batch without buyer email is refused');
const c1 = await call('create-batch', { body: { id: 'B20260921-INV1', buyer, pricing, recipients: withQuotes } });
ok(c1.status === 200 && c1.data.batch.status === 'awaiting_payment', 'batch created, awaiting payment');
const draft = Object.values(S.drafts)[0];
ok(draft.total === expectTotal, `parent invoice = sum of per-destination quotes ($${amt(expectTotal)})`);
ok(draft.input.taxExempt === true, 'parent is tax-exempt (tax is its own line, no double tax)');
ok(draft.input.lineItems.every(l => l.taxable === false && l.requiresShipping === false && !l.variantId), 'parent lines are custom: no inventory, no shipping step');
const named = draft.input.lineItems.filter(l => !/^(Shipping|Sales tax)/.test(l.title));
ok(named.length === 3, 'invoice is itemised: one line per product, not one lump');
const gin = named.find(l => l.title.includes('Gin and Tonic'));      // Ava + Dee
const bbq = named.find(l => l.title.includes('BBQ'));                 // Ben ×2 + Cal
ok(gin.quantity === 2 && gin.originalUnitPriceWithCurrency.amount === '249.95', 'a product two people get is one line, quantity 2, at its real unit price');
ok(bbq.quantity === 3, 'quantities add up across recipients (2 + 1 = 3)');
ok(draft.input.lineItems.some(l => /^Shipping/.test(l.title)) && draft.input.lineItems.some(l => /^Sales tax/.test(l.title)), 'shipping and tax are their own labelled lines');
ok(draft.input.appliedDiscount.valueType === 'FIXED_AMOUNT' && cents(String(draft.input.appliedDiscount.value)) === expectTotalDiscount, 'volume discount applied as the exact amount quoted');
ok(draft.input.tags.includes('bulk-parent') && draft.input.tags.includes('batch-B20260921-INV1'), 'parent tagged bulk-parent + batch');
ok(draft.input.poNumber === 'PO-77', 'PO number carried to the invoice');
ok(!c1.data.batch.log.some(l => /WARNING/.test(l.msg)), 'unpadded Shopify amount ("x.5") does not trigger a false mismatch');

const dup = await call('create-batch', { body: { id: 'B20260921-INV1', buyer, pricing, recipients: withQuotes } });
ok(dup.status === 409 && Object.keys(S.drafts).length === 1, 'second create of same batch is refused; still one invoice');

console.log('\nConcurrent double-click on create');
const [x, y] = await Promise.all([
  call('create-batch', { body: { id: 'B20260921-DBL1', buyer, pricing, recipients: withQuotes } }),
  call('create-batch', { body: { id: 'B20260921-DBL1', buyer, pricing, recipients: withQuotes } })
]);
ok([x.status, y.status].sort().join() === '200,409', 'simultaneous creates: exactly one wins');
ok(Object.values(S.drafts).filter(d => d.input.tags.includes('batch-B20260921-DBL1')).length === 1, 'simultaneous creates: exactly one invoice in Shopify');

console.log('\nInvoice + payment');
ok((await call('release-batch-background', { body: { id: 'B20260921-INV1' } })) && S.createCalls === 0, 'release before payment creates nothing');
const si = await call('send-invoice', { body: { id: 'B20260921-INV1' } });
ok(si.status === 200 && draft.sent, 'invoice emailed through Shopify');
let st = await call('batch-status', { method: 'GET', qs: '?id=B20260921-INV1' });
ok(st.data.batch.status === 'awaiting_payment', 'unpaid invoice stays awaiting_payment');
draft.order = { id: 'gid://shopify/Order/4999', name: '#4999', displayFinancialStatus: 'PAID' };
st = await call('batch-status', { method: 'GET', qs: '?id=B20260921-INV1' });
ok(st.data.batch.status === 'paid' && st.data.batch.parent.orderName === '#4999', 'paid parent flips batch to paid');

console.log('\nRelease — with one inventory failure and one dropped response');
S.failSkuOnce = 'BSKT-032';        // Cal fails once
S.dropResponseOnce = true;         // Ava's order is created but the response is lost
await call('release-batch-background', { body: { id: 'B20260921-INV1' } });
st = await call('batch-status', { method: 'GET', qs: '?id=B20260921-INV1' });
let b = st.data.batch;
ok(b.status === 'partial', 'failures leave batch partial, not released');
ok(b.recipients.find(r => r.firstName === 'Cal').child.error === 'Not enough inventory', 'Shopify error recorded against the right recipient');
const orderFor = n => S.orders.filter(o => o.input.shippingAddress.firstName === n);
ok(orderFor('Ava').length === 1, 'Ava: order exists in Shopify despite the lost response');

console.log('\nResume');
await call('release-batch-background', { body: { id: 'B20260921-INV1' } });
b = (await call('batch-status', { method: 'GET', qs: '?id=B20260921-INV1' })).data.batch;
ok(b.status === 'released', 'resume completes the batch');
ok(['Ava', 'Ben', 'Cal', 'Dee'].every(n => orderFor(n).length === 1), 'every recipient has exactly one order — no duplicates');
ok(b.recipients.find(r => r.firstName === 'Ava').child.recovered === true, 'Ava recovered by sourceIdentifier, not re-created');

console.log('\nChild order contents');
const ben = orderFor('Ben')[0];
ok(ben.input.lineItems.every(l => l.priceSet.shopMoney.amount === '0.00'), 'child lines are $0');
ok(ben.input.lineItems.length === 2 && ben.input.lineItems.find(l => l.variantId === V['BSKT-032'].id).quantity === 2, 'child carries real variants and quantities');
ok(ben.input.financialStatus === 'PAID' && !ben.input.email && !ben.input.customer, 'marked paid; no email or customer attached');
ok(ben.options.sendReceipt === false && ben.options.sendFulfillmentReceipt === false, 'recipient receives no Shopify emails');
ok(ben.options.inventoryBehaviour === 'DECREMENT_OBEYING_POLICY', 'inventory decremented on the child');
ok(ben.input.tags.includes('bulk-child') && ben.input.tags.includes('batch-B20260921-INV1'), 'child tagged bulk-child + batch');
const attr = k => (ben.input.customAttributes.find(a => a.key === k) || {}).value;
ok(attr('Bulk Parent Order') === '#4999' && attr('Gift Message') === 'Great year, Ben' && attr('Adult Signature Required') === 'Yes', 'parent ref, gift message, adult signature on the child');
ok(ben.input.shippingAddress.provinceCode === 'TX' && ben.input.test === false, 'real destination; not a test order');

console.log('\nRelease again after completion');
const before = S.createCalls;
await call('release-batch-background', { body: { id: 'B20260921-INV1' } });
ok(S.createCalls === before, 'releasing a finished batch creates nothing');

console.log('\nTest batch + concurrent release');
const t1 = await call('create-batch', { body: { id: 'B20260921-TST1', test: true, buyer: {}, pricing, recipients: withQuotes } });
ok(t1.data.batch.status === 'paid' && t1.data.batch.parent === null, 'test batch: no invoice, ready to release');
const n0 = S.orders.length;
await Promise.all([
  call('release-batch-background', { body: { id: 'B20260921-TST1' } }),
  call('release-batch-background', { body: { id: 'B20260921-TST1' } })
]);
const testOrders = S.orders.slice(n0);
ok(testOrders.length === 4, `two simultaneous releases → 4 orders, not 8 (got ${testOrders.length})`);
ok(testOrders.every(o => o.input.test === true && o.input.tags.includes('bulk-test')), 'test batch orders are Shopify test orders tagged bulk-test');

console.log('\nBatch list');
const list = await call('batch-status', { method: 'GET' });
ok(list.data.batches.length === 3 && list.data.batches.some(x => x.id === 'B20260921-INV1'), 'saved batches listed');


// ======================================================================
console.log('\nStaff quote with live rates (shipping left blank)');
const live = await call('quote-batch', { body: { recipients: [recips[0]], pricing: { discountPct: 0, shippingPerRecipient: '' } } });
ok(live.data.quotes.Ava.shippingTitle === 'UPS® Ground' && live.data.quotes.Ava.cents.shipping === 1900, 'blank shipping = live UPS Ground rate for that address');

console.log('\nPublic: catalog');
const pub = async (name, { method = 'POST', body, qs = '', headers = {} } = {}) => {
  const f = await fn(name);
  const res = await f(new Request('https://console.test/.netlify/functions/' + name + qs, {
    method, headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': '203.0.113.9', ...headers },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }));
  return { status: res.status, data: await res.json().catch(() => null) };
};
const cat = await pub('order-catalog', { method: 'GET' });
ok(cat.status === 200 && cat.data.items.length === Object.keys(V).length, 'catalog lists the corporate products, no key needed');
ok(!('variantId' in cat.data.items[0]), 'catalog does not expose internal variant ids');

const person = (i, state = 'CA', zip = '90001') => ({
  key: 'k' + i, firstName: 'Pat' + i, lastName: 'Lee', company: 'Acme', address1: `${100 + i} Main St`, address2: '',
  city: 'Town', state, zip, phone: '8055550100', email: '', giftMessage: `Thanks Pat${i}`, lines: [{ sku: 'BSKT-053', qty: 1 }] });

console.log('\nPublic: quote');
const small = [{ ...person(1), deliveryDate: '2099-12-18' }, person(2, 'TX', '73301')];
let pq = await pub('order-quote', { body: { recipients: small, batchSize: 2 } });
ok(pq.status === 200 && pq.data.discountPct === 0, 'under 20 recipients: no discount');
ok(pq.data.quotes.k1.shippingTitle === 'UPS® Ground' && pq.data.quotes.k1.sig, 'live Ground rate, quote signed');
ok(pq.data.quotes.k1.cents.shipping === 1900, 'rate taken from Shopify, applied in a second pricing pass');
const po = await pub('order-quote', { body: { recipients: [{ ...person(3), address1: 'PO Box 12' }], batchSize: 2 } });
ok(/PO box/.test(po.data.quotes.k3.error), 'server re-runs the rules: PO box rejected even if the page is bypassed');
const fake = await pub('order-quote', { body: { recipients: [{ ...person(4), lines: [{ sku: 'SECRET-ITEM', qty: 1 }] }], batchSize: 2 } });
ok(/isn’t available/.test(fake.data.quotes.k4.error), 'only catalog products can be quoted');
const big = await pub('order-quote', { body: { recipients: [person(5)], batchSize: 25 } });
ok(big.data.discountPct === 10 && big.data.quotes.k5.cents.discount === Math.round(24995 * 0.10), '20+ recipients: 10% off');

console.log('\nPublic: discount codes');
const withCode = async (code, size = 2) => (await pub('order-quote', { body: { recipients: [person(7)], batchSize: size, discountCode: code } })).data;
const good = await withCode('save15');
ok(good.code.valid && good.code.percent === 15 && good.discountPct === 15, 'percentage code recognised and applied (15%)');
ok(good.quotes.k7.cents.discount === Math.round(24995 * 0.15), 'code discount priced per recipient, so tax follows the discounted price');
ok(good.quotes.k7.sig && good.quotes.k7.discountCode === 'SAVE15', 'coded quote is signed and carries the code');
const fixed = await withCode('FIFTY');
ok(!fixed.code.valid && /fixed amount/.test(fixed.code.message) && fixed.discountPct === 0, 'fixed-amount code refused with a clear message, not silently applied');
const nope = await withCode('MADE-UP-CODE');
ok(!nope.code.valid && /isn’t valid/.test(nope.code.message), 'invalid code reported rather than ignored');
const beats = await withCode('SAVE15', 25);
ok(beats.discountPct === 15 && beats.discountSource === 'code', 'code beats the 10% volume discount — the better one wins, never both');
const loses = await withCode('SAVE15', 25);
ok(loses.volumePct === 10 && loses.discountPct === 15, 'volume discount still reported alongside');


console.log('\nPublic: submit');
const withQ = small.map(r => ({ ...r, quote: pq.data.quotes[r.key] }));
const buyerP = { name: 'Jo Buyer', company: 'Acme', email: 'jo@acme.test', dob: '1980-05-01' };
ok((await pub('order-submit', { body: { buyer: { ...buyerP, dob: '2010-01-01' }, recipients: withQ } })).status === 400, 'under-21 buyer refused');
const tampered = JSON.parse(JSON.stringify(withQ)); tampered[0].quote.cents.total = 100; tampered[0].quote.cents.merchandise = 100;
const tp = await pub('order-submit', { body: { buyer: buyerP, recipients: tampered } });
ok(tp.status === 400 && tp.data.error === 'bad_quote', 'edited price is rejected');
const moved = JSON.parse(JSON.stringify(withQ)); moved[1].state = 'CA'; moved[1].zip = '90001';
ok((await pub('order-submit', { body: { buyer: buyerP, recipients: moved } })).data.error === 'bad_quote', 'changing an address after pricing is rejected');
const cheat = [person(5)].map(r => ({ ...r, quote: big.data.quotes.k5 })).concat([{ ...person(6), quote: big.data.quotes.k5 }]);
ok((await pub('order-submit', { body: { buyer: buyerP, recipients: cheat } })).data.error === 'bad_quote', 'a 20+ discount cannot be used on a smaller order');
console.log('\nCode cannot be faked in the browser');
const faked = JSON.parse(JSON.stringify([{ ...person(1), quote: pq.data.quotes.k1 }, { ...person(2, 'TX', '73301'), quote: pq.data.quotes.k2 }]));
faked[0].quote.discountCode = 'SAVE15'; faked[0].quote.discountPct = 15;
ok((await pub('order-submit', { body: { buyer: buyerP, recipients: faked } })).data.error === 'bad_quote', 'a code pasted into a quote by hand is rejected');

const draftsBefore = Object.keys(S.drafts).length;
const sub = await pub('order-submit', { body: { buyer: buyerP, recipients: withQ, deliveryDate: '2099-12-01' } });
ok(sub.status === 200 && sub.data.invoiceUrl && sub.data.statusUrl, 'valid order: invoice created, checkout link returned');
const pd = Object.values(S.drafts)[draftsBefore];
ok(pd.input.tags.includes('bulk-source-customer') && pd.input.email === 'jo@acme.test', 'parent tagged as a customer order, billed to the buyer');
ok(pd.sent && pd.email && pd.email.customMessage.includes(sub.data.statusUrl), 'invoice email carries the status link');

console.log('\nPublic: status page');
const su = new URL(sub.data.statusUrl);
const sb = su.searchParams.get("b"), stok = su.searchParams.get("t");
ok((await pub('order-status', { method: 'GET', qs: `?b=${sb}&t=wrong` })).status === 404, 'wrong token: not found');
let ps = await pub('order-status', { method: 'GET', qs: `?b=${sb}&t=${stok}` });
ok(ps.status === 200 && ps.data.batch.status === 'awaiting_payment' && ps.data.batch.invoiceUrl, 'right token: shows unpaid with pay link');
ok(!JSON.stringify(ps.data).includes('sig') && !JSON.stringify(ps.data).includes('gid://'), 'customer view leaks no signatures or Shopify ids');

console.log('\nWebhook → automatic release');
pd.order = { id: 'gid://shopify/Order/7001', name: '#7001', displayFinancialStatus: 'PAID' };
const payload = JSON.stringify({ id: 7001, note_attributes: [{ name: 'Bulk Batch', value: sb }] });
const { createHmac } = await import('node:crypto');
const forged = await pub('shopify-webhook', { body: payload, headers: { 'x-shopify-hmac-sha256': 'bm9wZQ==' } });
ok(forged.status === 401, 'forged webhook rejected');
const ordersBefore = S.orders.length;
const hmac = createHmac('sha256', 'shpss_test_secret').update(payload).digest('base64');
const wh = await pub('shopify-webhook', { body: payload, headers: { 'x-shopify-hmac-sha256': hmac } });
ok(wh.status === 200, 'signed webhook accepted');
await Promise.all(S.bgRuns || []);
const made = S.orders.slice(ordersBefore);
ok(made.length === 2, 'payment alone created both recipient orders — nobody pressed Release');
ok(made.every(o => o.input.shippingLines[0].title === 'UPS® Ground'), 'recipient orders carry the real service name for ShipStation');
ok(made.every(o => o.input.tags.includes(`batch-${sb}`) && o.input.customAttributes.some(a => a.key === 'Gift Message')), 'tagged to the batch with gift message');
const dateOf = (first) => (made.find(o => o.input.shippingAddress.firstName === first).input.customAttributes.find(a => a.key === 'Delivery Date') || {}).value;
ok(dateOf('Pat1') === '2099-12-18' && dateOf('Pat2') === '2099-12-01', 'each recipient keeps their own delivery date; the rest get the default');

await pub('shopify-webhook', { body: payload, headers: { 'x-shopify-hmac-sha256': hmac } });
await Promise.all(S.bgRuns || []);
ok(S.orders.length === ordersBefore + 2, 'duplicate webhook delivery creates nothing new');
ps = await pub('order-status', { method: 'GET', qs: `?b=${sb}&t=${stok}` });
ok(ps.data.batch.status === 'released' && ps.data.batch.recipients.every(r => r.order), 'status page shows each recipient’s order');

console.log('\nRate limit');
let last;
for (let i = 0; i < 13; i++) last = await pub('order-submit', { body: { buyer: {}, recipients: [] } });
ok(last.status === 429, 'submit is rate-limited per IP');

console.log(`\n${passed} checks passed.\n`);
await server.stop();
