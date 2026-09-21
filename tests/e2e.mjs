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
    const discount = Math.round(gross * pct / 100);
    const ship = cents(i.shippingLine.priceWithCurrency.amount);
    const rate = TAX[i.shippingAddress.provinceCode] ?? 0.06;
    const tax = Math.round((gross - discount) * rate);
    return { draftOrderCalculate: { userErrors: [], calculatedDraftOrder: {
      currencyCode: 'USD', totalLineItemsPriceSet: bag(gross), totalDiscountsSet: bag(discount),
      subtotalPriceSet: bag(gross - discount), totalShippingPriceSet: bag(ship), totalTaxSet: bag(tax),
      totalPriceSet: bag(gross - discount + ship + tax),
      taxLines: [{ title: i.shippingAddress.provinceCode + ' State Tax', rate, priceSet: bag(tax) }] } } };
  }
  if (query.includes('draftOrderCreate')) {
    const total = vars.input.lineItems.reduce((n, l) => n + cents(l.originalUnitPriceWithCurrency.amount) * l.quantity, 0);
    const id = 'gid://shopify/DraftOrder/' + (++S.draftN);
    S.drafts[id] = { id, name: '#D' + S.draftN, input: vars.input, total, order: null };
    return { draftOrderCreate: { userErrors: [], draftOrder: {
      id, name: '#D' + S.draftN, invoiceUrl: 'https://new-brobasket.myshopify.com/invoices/x', status: 'OPEN',
      totalPriceSet: { shopMoney: { amount: (total / 100).toString() } } } } };  // note: unpadded, like Shopify
  }
  if (query.includes('draftOrderInvoiceSend')) {
    S.drafts[vars.id].sent = true;
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
const L = (sku, qty = 1) => ({ sku, variantId: V[sku].id, qty, title: V[sku].title });
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
ok((await call('quote-batch', { body: { recipients: Array(9).fill(recips[0]), pricing } })).status === 400, 'chunks over 8 are refused');
ok((await call('quote-batch', { body: { recipients: recips, pricing: { discountPct: 60, shippingPerRecipient: 0 } } })).status === 400, 'discount above the cap is refused');

const withQuotes = recips.map(r => ({ ...r, quote: q.data.quotes[r.key] }));
const expectTotal = withQuotes.reduce((n, r) => n + r.quote.cents.total, 0);

console.log('\nCreate — invoice batch');
const buyer = { name: 'Pat Buyer', company: 'Acme Corp', email: 'pat@acme.com', poNumber: 'PO-77' };
ok((await call('create-batch', { body: { id: 'B20260921-INV1', buyer: { ...buyer, email: '' }, pricing, recipients: withQuotes } })).status === 400, 'invoice batch without buyer email is refused');
const c1 = await call('create-batch', { body: { id: 'B20260921-INV1', buyer, pricing, recipients: withQuotes } });
ok(c1.status === 200 && c1.data.batch.status === 'awaiting_payment', 'batch created, awaiting payment');
const draft = Object.values(S.drafts)[0];
ok(draft.total === expectTotal, `parent invoice = sum of per-destination quotes ($${amt(expectTotal)})`);
ok(draft.input.taxExempt === true, 'parent is tax-exempt (tax is its own line, no double tax)');
ok(draft.input.lineItems.every(l => l.taxable === false && l.requiresShipping === false && !l.variantId), 'parent lines are custom: no inventory, no shipping step');
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

console.log(`\n${passed} checks passed.\n`);
await server.stop();
