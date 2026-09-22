/* ==========================================================================
   Bulk Order Console — Go-To Gifting LLC

   01 upload → 02 validate → 03 quote → 04 invoice + payment → 05 release

   Validation is all-or-nothing: nothing reaches Shopify until every
   blocking issue is fixed. Money is quoted per destination by Shopify, the
   buyer pays one invoice, and only then are the per-recipient orders made.
   ========================================================================== */

'use strict';

/* --- Column contract ----------------------------------------------------- */

const COLUMNS = [
  { key: 'recipient_id',  label: 'Group',        required: false },
  { key: 'first_name',    label: 'First',        required: true  },
  { key: 'last_name',     label: 'Last',         required: true  },
  { key: 'company',       label: 'Company',      required: false },
  { key: 'address1',      label: 'Address 1',    required: true  },
  { key: 'address2',      label: 'Address 2',    required: false },
  { key: 'city',          label: 'City',         required: true  },
  { key: 'state',         label: 'State',        required: true  },
  { key: 'zip',           label: 'ZIP',          required: true  },
  { key: 'phone',         label: 'Phone',        required: false },
  { key: 'email',         label: 'Email',        required: false },
  { key: 'sku',           label: 'SKU',          required: true  },
  { key: 'qty',           label: 'Qty',          required: true, numeric: true },
  { key: 'gift_message',  label: 'Gift message', required: false },
  { key: 'delivery_date', label: 'Deliver on',   required: false }
];
const REQUIRED_HEADERS = COLUMNS.filter(c => c.required).map(c => c.key);

/* --- Reference data ------------------------------------------------------ */

const STATES = {
  ALABAMA:'AL', ALASKA:'AK', ARIZONA:'AZ', ARKANSAS:'AR', CALIFORNIA:'CA',
  COLORADO:'CO', CONNECTICUT:'CT', DELAWARE:'DE', 'DISTRICT OF COLUMBIA':'DC',
  FLORIDA:'FL', GEORGIA:'GA', HAWAII:'HI', IDAHO:'ID', ILLINOIS:'IL',
  INDIANA:'IN', IOWA:'IA', KANSAS:'KS', KENTUCKY:'KY', LOUISIANA:'LA',
  MAINE:'ME', MARYLAND:'MD', MASSACHUSETTS:'MA', MICHIGAN:'MI', MINNESOTA:'MN',
  MISSISSIPPI:'MS', MISSOURI:'MO', MONTANA:'MT', NEBRASKA:'NE', NEVADA:'NV',
  'NEW HAMPSHIRE':'NH', 'NEW JERSEY':'NJ', 'NEW MEXICO':'NM', 'NEW YORK':'NY',
  'NORTH CAROLINA':'NC', 'NORTH DAKOTA':'ND', OHIO:'OH', OKLAHOMA:'OK',
  OREGON:'OR', PENNSYLVANIA:'PA', 'RHODE ISLAND':'RI', 'SOUTH CAROLINA':'SC',
  'SOUTH DAKOTA':'SD', TENNESSEE:'TN', TEXAS:'TX', UTAH:'UT', VERMONT:'VT',
  VIRGINIA:'VA', WASHINGTON:'WA', 'WEST VIRGINIA':'WV', WISCONSIN:'WI',
  WYOMING:'WY'
};
const STATE_CODES = new Set(Object.values(STATES));

const PO_BOX   = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box)\b/i;
const MILITARY = /\b(apo|fpo|dpo)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* --- Rules --------------------------------------------------------------- */

const RULES = [
  { code:'E10', sev:'stop', field:'first_name', test: r => !r.first_name, msg: 'First name is empty.' },
  { code:'E11', sev:'stop', field:'last_name',  test: r => !r.last_name,  msg: 'Last name is empty.' },
  { code:'E12', sev:'stop', field:'address1',   test: r => !r.address1,   msg: 'Street address is empty.' },
  { code:'E13', sev:'stop', field:'city',       test: r => !r.city,       msg: 'City is empty.' },
  { code:'E14', sev:'stop', field:'state',      test: r => !STATE_CODES.has(r.state), msg: 'State is not a US state code.' },
  { code:'E15', sev:'stop', field:'zip',        test: r => !/^\d{5}(-\d{4})?$/.test(r.zip), msg: 'ZIP must be 5 digits, or 5+4 with a hyphen.' },
  { code:'E16', sev:'stop', field:'sku',        test: r => !r.sku, msg: 'SKU is empty.' },
  { code:'E17', sev:'stop', field:'qty',
    test: r => !Number.isInteger(+r.qty) || +r.qty < 1 || +r.qty > CONFIG.limits.maxQtyPerLine,
    msg: () => `Quantity must be a whole number from 1 to ${CONFIG.limits.maxQtyPerLine}.` },
  { code:'E18', sev:'stop', field:'delivery_date',
    test: r => r.delivery_date !== '' && !isUsableDate(r.delivery_date),
    msg: 'Delivery date is unreadable or already past. Use YYYY-MM-DD.' },
  { code:'E19', sev:'stop', field:'address1',
    test: r => CONFIG.carrier.blockPoBoxes && PO_BOX.test(r.address1 + ' ' + r.address2),
    msg: 'Carriers will not deliver alcohol to a PO box. Needs a street address.' },
  { code:'E24', sev:'stop', field:'address1',
    test: r => CONFIG.carrier.blockMilitaryAddresses && MILITARY.test(r.address1 + ' ' + r.address2 + ' ' + r.city),
    msg: 'Alcohol cannot ship to APO, FPO, or DPO addresses.' },
  { code:'E30', sev:'stop', field:'gift_message',
    test: r => r.gift_message.length > CONFIG.limits.maxGiftMessageChars,
    msg: () => `Gift message is over ${CONFIG.limits.maxGiftMessageChars} characters.` },
  { code:'W02', sev:'warn', field:'email', test: r => r.email !== '' && !EMAIL_RE.test(r.email),
    msg: 'Email does not look valid.' },
  { code:'W06', sev:'warn', field:'phone', test: r => digits(r.phone).length < 10,
    msg: 'No usable phone number. Carriers ask for one on adult-signature deliveries.' }
];

/* --- State --------------------------------------------------------------- */

let CONFIG = null;
let rows = [];
let skuMap = {};
let screening = null;
let serverStatus = 'idle';     // idle | ok | unavailable
let filter = 'all';
let quotes = {};               // clientKey → quote
let quoteFresh = false;
let currentBatch = null;
let pollTimer = null;

/* --- Helpers ------------------------------------------------------------- */

const $ = id => document.getElementById(id);
const digits = s => (s || '').replace(/\D/g, '');
const clean  = s => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const usd = cents => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const show = (id, on = true) => { $(id).hidden = !on; };

function isUsableDate(v) {
  const d = new Date(v + (/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'T12:00:00' : ''));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d >= today;
}

function normaliseState(v) {
  const s = clean(v).toUpperCase();
  return STATE_CODES.has(s) ? s : (STATES[s] || s);
}

function newBatchId() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const tail = [...bytes].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  return `B${stamp}-${tail}`;
}

function setStep(n) {
  [1, 2, 3, 4, 5].forEach(i => {
    $('step' + i).dataset.state = i < n ? 'done' : (i === n ? 'active' : '');
  });
}

function downloadCsv(name, fields, data) {
  const csv = Papa.unparse({ fields, data });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --- API + access gate --------------------------------------------------- */

const KEY_STORE = 'boc.key';
// Remembered on this device until the key changes (was per-tab).
const keyStore = window.localStorage;

function askForKey(message) {
  $('gateError').hidden = !message;
  $('gateError').textContent = message || '';
  $('gateKey').value = '';
  if (!$('gate').open) $('gate').showModal();
  return new Promise(resolve => {
    $('gateForm').onsubmit = () => {
      keyStore.setItem(KEY_STORE, $('gateKey').value);
      resolve();
    };
  });
}

async function api(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!keyStore.getItem(KEY_STORE)) await askForKey();
    const res = await fetch('/.netlify/functions/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-console-key': keyStore.getItem(KEY_STORE) || ''
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) {
      keyStore.removeItem(KEY_STORE);
      await askForKey('That key was not accepted.');
      continue;
    }
    if (res.status === 202) return {};
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.message || `Request failed (${res.status}).`);
      err.status = res.status; err.code = data.error;
      throw err;
    }
    return data;
  }
  throw new Error('Could not unlock the console.');
}

/* --- Config -------------------------------------------------------------- */

async function loadConfig() {
  const res = await fetch('/config/shipping-rules.json');
  CONFIG = await res.json();
  if (CONFIG.pricing.defaultShippingPerRecipient != null) {
    $('shippingEach').value = CONFIG.pricing.defaultShippingPerRecipient;
  }
}

function showScreening() {
  const n = $('screeningNotice');
  if (serverStatus !== 'ok' || !screening) { n.hidden = true; return; }
  n.hidden = false;
  if (screening.mode === 'shopify-zones' || screening.mode === 'allowlist') {
    n.dataset.tone = 'info';
    $('screeningCode').textContent = 'SCREEN';
    $('screeningText').innerHTML =
      `Destinations are checked against <b>${esc(screening.source)}</b> — ` +
      `${screening.allowed.length} states. Bulk orders skip checkout, so this is where that rule is enforced.`;
  } else if (screening.mode === 'error') {
    n.dataset.tone = 'stop';
    $('screeningCode').textContent = 'SCREEN';
    $('screeningText').textContent = screening.message;
  } else {
    n.dataset.tone = '';
    $('screeningCode').textContent = 'OFF';
    $('screeningText').innerHTML =
      '<b>Destination screening is off.</b> Bulk orders never pass through checkout, so no destination rule is being applied to this batch.';
  }
}

/* --- 01 · Parse ----------------------------------------------------------- */

function ingest(file) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => clean(h).toLowerCase().replace(/\s+/g, '_'),
    complete: results => {
      const headers = results.meta.fields || [];
      const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
      if (missing.length) {
        alert('This sheet is missing required columns:\n\n  ' + missing.join('\n  ') +
              '\n\nDownload the template and match its header row.');
        return;
      }
      rows = results.data.map((raw, i) => {
        const r = { _n: i + 2, _issues: [] };
        COLUMNS.forEach(c => { r[c.key] = clean(raw[c.key]); });
        r.state = normaliseState(r.state);
        r.zip = r.zip.replace(/\s/g, '');
        return r;
      });
      $('batchId').textContent = newBatchId();
      show('uploadStage', false);
      show('reviewStage');
      setStep(2);
      validate();
    }
  });
}

/* --- 02 · Validate -------------------------------------------------------- */

async function validate() {
  invalidateQuote();
  rows.forEach(r => { r._issues = []; });

  rows.forEach(r => {
    RULES.forEach(rule => {
      let bad = false;
      try { bad = rule.test(r); } catch { bad = false; }
      if (bad) r._issues.push({
        code: rule.code, sev: rule.sev, field: rule.field,
        msg: typeof rule.msg === 'function' ? rule.msg(r) : rule.msg
      });
    });
  });

  crossRowChecks();
  await serverChecks();
  render();
}

const addrSig = r => [r.first_name, r.last_name, r.address1, r.address2, r.city, r.state, r.zip]
  .join('|').toLowerCase();

function crossRowChecks() {
  const groupSig = new Map();
  const groupMsg = new Map();
  const groupDate = new Map();
  const seen = new Map();
  const conflictMode = (CONFIG.grouping && CONFIG.grouping.giftMessageConflict) || 'first';

  rows.forEach(r => {
    if (r.recipient_id) {
      const sig = addrSig(r);
      const prev = groupSig.get(r.recipient_id);
      if (prev && prev !== sig) {
        r._issues.push({ code: 'E23', sev: 'stop', field: 'recipient_id',
          msg: `Group ${r.recipient_id} is used on rows with different addresses. Give them separate group IDs.` });
      } else if (!prev) groupSig.set(r.recipient_id, sig);

      if (r.gift_message) {
        const m = groupMsg.get(r.recipient_id);
        if (m === undefined) groupMsg.set(r.recipient_id, r.gift_message);
        else if (m !== r.gift_message) {
          r._issues.push(conflictMode === 'block'
            ? { code: 'E25', sev: 'stop', field: 'gift_message',
                msg: `Group ${r.recipient_id} has different gift messages. Make them match.` }
            : { code: 'W07', sev: 'warn', field: 'gift_message',
                msg: `Group ${r.recipient_id} has different gift messages. The first one will be used.` });
        }
      }

      if (r.delivery_date) {
        const d = groupDate.get(r.recipient_id);
        if (d === undefined) groupDate.set(r.recipient_id, r.delivery_date);
        else if (d !== r.delivery_date) {
          r._issues.push({ code: 'E26', sev: 'stop', field: 'delivery_date',
            msg: `Group ${r.recipient_id} has different delivery dates. One order can only have one.` });
        }
      }
    }

    const k = addrSig(r) + '|' + r.sku.toLowerCase();
    if (!r.recipient_id && seen.has(k)) {
      r._issues.push({ code: 'W01', sev: 'warn', field: 'last_name',
        msg: `Same person, address and SKU as row ${seen.get(k)}. Two orders will be created unless they share a group ID.` });
    } else if (!seen.has(k)) seen.set(k, r._n);
  });

  if (rows.length > CONFIG.limits.maxRowsPerBatch) {
    rows.slice(CONFIG.limits.maxRowsPerBatch).forEach(r => r._issues.push({
      code: 'E22', sev: 'stop', field: 'recipient_id',
      msg: `Batch limit is ${CONFIG.limits.maxRowsPerBatch} rows. Split this sheet.` }));
  }
}

async function serverChecks() {
  const skus = [...new Set(rows.map(r => r.sku).filter(Boolean))];
  const states = [...new Set(rows.map(r => r.state).filter(s => STATE_CODES.has(s)))];
  if (!skus.length) { serverStatus = 'idle'; return; }

  let data;
  try {
    data = await api('validate-batch', { method: 'POST', body: { skus, states } });
    serverStatus = 'ok';
  } catch (err) {
    serverStatus = 'unavailable';
    serverError = err.message;
    showScreening();
    return;
  }

  skuMap = data.skus;
  screening = data.screening;
  $('storeLabel').textContent = data.shop || 'connected';
  showScreening();

  // How much of each SKU the whole batch wants, for the stock check.
  const demand = {};
  rows.forEach(r => { if (Number.isInteger(+r.qty)) demand[r.sku] = (demand[r.sku] || 0) + +r.qty; });

  rows.forEach(r => {
    const hit = skuMap[r.sku];
    if (r.sku && (!hit || !hit.found)) {
      r._issues.push({ code: 'E21', sev: 'stop', field: 'sku', msg: 'No product in Shopify has this SKU.' });
    } else if (hit) {
      if (!hit.active) {
        r._issues.push({ code: 'W04', sev: 'warn', field: 'sku',
          msg: `${hit.title} is not active in Shopify (draft or archived).` });
      }
      if (hit.tracked && hit.available < demand[r.sku]) {
        r._issues.push({ code: 'W03', sev: 'warn', field: 'sku',
          msg: `${hit.title}: ${hit.available} on hand, this batch needs ${demand[r.sku]}.` });
      }
    }
    if (screening && screening.blocked && screening.blocked.includes(r.state)) {
      r._issues.push({ code: 'E20', sev: 'stop', field: 'state',
        msg: `${r.state} is not in the store's shipping zones.` });
    }
  });
}
let serverError = '';

/* --- 02 · Render ---------------------------------------------------------- */

const rowStatus = r =>
  r._issues.some(i => i.sev === 'stop') ? 'stop' : r._issues.length ? 'warn' : 'ok';

const blockingCount = () => rows.filter(r => rowStatus(r) === 'stop').length;

function render() {
  const stops = blockingCount();
  const warns = rows.filter(r => rowStatus(r) === 'warn').length;
  const units = rows.reduce((n, r) => n + (Number.isInteger(+r.qty) ? +r.qty : 0), 0);

  $('cRows').textContent = rows.length;
  $('cOrders').textContent = buildRecipients().length;
  $('cStop').textContent = stops;
  $('cWarn').textContent = warns;
  $('cUnits').textContent = units;

  renderHead(); renderBody(); renderLedger();

  const ready = stops === 0 && rows.length > 0 && serverStatus === 'ok';
  show('orderStage', ready);
  $('getQuote').disabled = !ready;
  setStep(ready ? 3 : 2);
}

function renderHead() {
  const tr = $('gridHead');
  if (tr.children.length) return;
  tr.innerHTML = '<th class="rail">Status</th>' + COLUMNS.map(c => `<th>${c.label}</th>`).join('');
}

function renderBody() {
  const body = $('gridBody');
  body.innerHTML = '';
  const frag = document.createDocumentFragment();

  rows.forEach((r, idx) => {
    const status = rowStatus(r);
    const tr = document.createElement('tr');
    tr.dataset.status = status;
    tr.hidden = (filter === 'stop' && status !== 'stop') || (filter === 'warn' && status !== 'warn');

    const rail = document.createElement('td');
    rail.className = 'rail';
    const codes = r._issues.length ? [...new Set(r._issues.map(i => i.code))].join(' ') : 'OK';
    rail.innerHTML = `<span class="rail__code">${codes}</span><span class="rail__line">row ${r._n}</span>`;
    tr.appendChild(rail);

    COLUMNS.forEach(c => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'cell';
      input.value = r[c.key];
      input.dataset.row = idx;
      input.dataset.key = c.key;
      if (c.numeric) input.dataset.numeric = '';
      const issue = r._issues.find(i => i.field === c.key);
      if (issue) { input.dataset.flag = 'bad'; input.title = `${issue.code} — ${issue.msg}`; }
      input.setAttribute('aria-label', `${c.label}, row ${r._n}`);
      td.appendChild(input);
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  });
  body.appendChild(frag);
}

function renderLedger() {
  const tally = new Map();
  rows.forEach(r => r._issues.forEach(i => {
    if (!tally.has(i.code)) tally.set(i.code, { code: i.code, sev: i.sev, msg: i.msg, rows: [] });
    tally.get(i.code).rows.push(r._n);
  }));

  const list = [...tally.values()].sort((a, b) =>
    a.sev === b.sev ? a.code.localeCompare(b.code) : (a.sev === 'stop' ? -1 : 1));

  let html = list.map(e => `
    <li class="ledger__item" data-sev="${e.sev}">
      <span class="ledger__code">${e.code}</span>
      <span>${esc(e.msg)}<br><span class="mono small muted">rows ${e.rows.slice(0, 12).join(', ')}${e.rows.length > 12 ? ` +${e.rows.length - 12} more` : ''}</span></span>
      <span class="ledger__count">${e.rows.length}</span>
    </li>`).join('');

  if (serverStatus === 'unavailable') {
    html = `
      <li class="ledger__item" data-sev="stop">
        <span class="ledger__code">API</span>
        <span>Shopify checks did not run: ${esc(serverError)}<br>
        <span class="small muted">SKUs, stock and destinations were not checked. The rows above passed the structural checks only.</span></span>
        <span class="ledger__count">—</span>
      </li>` + html;
  }

  $('ledger').innerHTML = html;
  $('ledgerEmpty').hidden = list.length > 0 || serverStatus === 'unavailable';
}

/* --- Recipients ----------------------------------------------------------
   Rows → one entry per order. Rows sharing a group collapse; the same SKU
   twice in a group becomes one line with the quantities added.
   ------------------------------------------------------------------------ */

function buildRecipients() {
  const groups = new Map();
  let loose = 0;
  rows.forEach(r => {
    const key = r.recipient_id ? 'g:' + r.recipient_id : 'r:' + (loose++) + ':' + r._n;
    if (!groups.has(key)) {
      groups.set(key, {
        clientKey: key, rows: [],
        firstName: r.first_name, lastName: r.last_name, company: r.company,
        address1: r.address1, address2: r.address2, city: r.city, state: r.state, zip: r.zip,
        phone: r.phone, email: r.email,
        giftMessage: '', deliveryDate: '', lines: []
      });
    }
    const g = groups.get(key);
    g.rows.push(r._n);
    if (!g.giftMessage && r.gift_message) g.giftMessage = r.gift_message;
    if (!g.deliveryDate && r.delivery_date) g.deliveryDate = r.delivery_date;
    if (!g.phone && r.phone) g.phone = r.phone;
    if (!g.email && r.email) g.email = r.email;

    const hit = skuMap[r.sku] || {};
    const existing = g.lines.find(l => l.sku === r.sku);
    if (existing) existing.qty += +r.qty || 0;
    else g.lines.push({
      sku: r.sku, variantId: hit.variantId || null, qty: +r.qty || 0, price: hit.price || null,
      title: [hit.title, hit.variantTitle].filter(Boolean).join(' — ')
    });
  });
  return [...groups.values()];
}

/* --- 03 · Quote ----------------------------------------------------------- */

function invalidateQuote() {
  quotes = {};
  quoteFresh = false;
  show('quoteStage', false);
}

function readOrderForm() {
  const buyer = {
    name: clean($('buyerName').value), company: clean($('buyerCompany').value),
    email: clean($('buyerEmail').value), phone: clean($('buyerPhone').value),
    poNumber: clean($('buyerPo').value)
  };
  const pricing = {
    discountPct: parseFloat($('discountPct').value || '0'),
    // Blank = live carrier rate for each address.
    shippingPerRecipient: $('shippingEach').value.trim() === '' ? null : parseFloat($('shippingEach').value)
  };
  const test = $('testMode').checked;

  let error = '';
  if (!test && !EMAIL_RE.test(buyer.email)) error = 'An invoice email is required.';
  else if (pricing.shippingPerRecipient !== null && !(pricing.shippingPerRecipient >= 0)) error = 'Shipping must be 0 or more — or leave it blank for live rates.';
  else if (!(pricing.discountPct >= 0 && pricing.discountPct <= CONFIG.pricing.maxDiscountPct)) {
    error = `Discount must be between 0 and ${CONFIG.pricing.maxDiscountPct}%.`;
  }
  return { buyer, pricing, test, error };
}

async function getQuote() {
  const form = readOrderForm();
  $('orderError').hidden = !form.error;
  $('orderError').textContent = form.error;
  if (form.error) return;

  const recipients = buildRecipients();
  quotes = {};
  quoteFresh = false;
  show('quoteStage');
  show('quoteResult', false);
  show('quoteProgress');
  $('getQuote').disabled = true;

  const CHUNK = 5;
  let done = 0;
  try {
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const part = recipients.slice(i, i + CHUNK).map(r => ({ ...r, key: r.clientKey }));
      $('quoteLabel').textContent = `Pricing ${done} of ${recipients.length} destinations…`;
      const data = await api('quote-batch', { method: 'POST', body: { recipients: part, pricing: form.pricing } });
      Object.assign(quotes, data.quotes);
      done += part.length;
      $('quoteBar').style.width = `${Math.round((done / recipients.length) * 100)}%`;
    }
  } catch (err) {
    $('quoteLabel').textContent = `Quote stopped: ${err.message}`;
    $('getQuote').disabled = false;
    return;
  }

  $('getQuote').disabled = false;
  show('quoteProgress', false);
  quoteFresh = true;
  renderQuote(recipients, form);
}

function renderQuote(recipients, form) {
  const t = { merchandise: 0, discount: 0, shipping: 0, tax: 0, total: 0 };
  const errors = [];
  recipients.forEach(r => {
    const q = quotes[r.clientKey];
    if (!q || q.error) { errors.push({ r, msg: q ? q.error : 'No quote returned.' }); return; }
    t.merchandise += q.cents.merchandise;
    t.discount += q.cents.discount;
    t.shipping += q.cents.shipping;
    t.tax += q.cents.tax;
    t.total += q.cents.total;
  });

  $('qRecipients').textContent = recipients.length;
  $('qMerch').textContent = usd(t.merchandise);
  $('qDiscount').textContent = t.discount ? '−' + usd(t.discount) : usd(0);
  $('qShipping').textContent = usd(t.shipping);
  $('qTax').textContent = usd(t.tax);
  $('qTotal').textContent = usd(t.total);

  $('quoteErrors').innerHTML = errors.map(e => `
    <li class="ledger__item" data-sev="stop">
      <span class="ledger__code">Q01</span>
      <span>${esc(e.r.firstName)} ${esc(e.r.lastName)}, ${esc(e.r.city)} ${esc(e.r.state)} — ${esc(e.msg)}
        <br><span class="small muted mono">rows ${e.r.rows.join(', ')}</span></span>
      <span class="ledger__count">1</span>
    </li>`).join('');

  $('createBatch').textContent = form.test ? 'Create test batch' : 'Create invoice';
  $('createBatch').disabled = errors.length > 0;
  show('quoteResult');
}

/* --- 04 · Create batch ---------------------------------------------------- */

async function createBatch() {
  if (!quoteFresh) return;
  const form = readOrderForm();
  if (form.error) { $('orderError').hidden = false; $('orderError').textContent = form.error; return; }

  const recipients = buildRecipients().map(r => ({ ...r, quote: quotes[r.clientKey] }));
  const total = recipients.reduce((n, r) => n + r.quote.cents.total, 0);

  const msg = form.test
    ? `Create a TEST batch of ${recipients.length} orders?\n\nNo invoice is sent. Orders are created as Shopify test orders.`
    : `Create an invoice for ${usd(total)} to ${form.buyer.email}?\n\n${recipients.length} orders will be created after it is paid.`;
  if (!confirm(msg)) return;

  $('createBatch').disabled = true;
  try {
    const data = await api('create-batch', {
      method: 'POST',
      body: { id: $('batchId').textContent, test: form.test, buyer: form.buyer, pricing: form.pricing, recipients }
    });
    openBatch(data.batch);
  } catch (err) {
    alert(err.message);
    $('createBatch').disabled = false;
  }
}

/* --- 04/05 · Batch view --------------------------------------------------- */

const STATUS = {
  creating:         { label: 'Creating',          tone: 'warn' },
  draft:            { label: 'Draft',             tone: '' },
  awaiting_payment: { label: 'Awaiting payment',  tone: 'warn' },
  paid:             { label: 'Paid · ready',      tone: 'ok' },
  releasing:        { label: 'Releasing',         tone: 'warn' },
  partial:          { label: 'Partly released',   tone: 'stop' },
  released:         { label: 'Released',          tone: 'ok' },
  failed:           { label: 'Failed',            tone: 'stop' },
  cancelled:        { label: 'Cancelled',         tone: 'stop' }
};

function openBatch(batch) {
  currentBatch = batch;
  $('batchId').textContent = batch.id;
  show('uploadStage', false);
  show('reviewStage', false);
  show('orderStage', false);
  show('quoteStage', false);
  show('batchStage');
  renderBatch();
  schedulePoll();
  $('batchStage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderBatch() {
  const b = currentBatch;
  const st = STATUS[b.status] || { label: b.status, tone: '' };
  $('bId').textContent = b.id + (b.test ? '  ·  TEST' : '');
  $('bStatus').textContent = st.label;
  $('bStatus').dataset.tone = st.tone;

  const made = b.recipients.filter(r => r.child && r.child.orderId).length;
  const failed = b.recipients.filter(r => r.child && r.child.error && !r.child.orderId).length;
  const buyer = b.buyer.company || b.buyer.name || b.buyer.email || '—';
  $('bSummary').textContent =
    `${buyer} · ${b.recipients.length} recipients · ${b.totals.units} gifts · total $${b.totals.total}` +
    (b.buyer.poNumber ? ` · PO ${b.buyer.poNumber}` : '');

  // Invoice box
  const p = b.parent;
  show('bInvoice', Boolean(p));
  if (p) {
    $('bDraft').textContent = p.orderName || p.draftName;
    $('bTotal').textContent = '$' + b.totals.total;
    $('bSent').textContent = p.invoiceSentAt ? `· emailed ${new Date(p.invoiceSentAt).toLocaleString()}` : '· not emailed yet';
    $('bInvoiceLink').href = p.invoiceUrl || '#';
    const open = b.status === 'awaiting_payment';
    $('sendInvoice').disabled = !open;
    $('checkPayment').disabled = !open;
    $('sendInvoice').textContent = p.invoiceSentAt ? 'Email invoice again' : 'Email invoice to buyer';
  }

  // Release control
  const canRelease = ['paid', 'partial'].includes(b.status);
  show('releaseBtn', canRelease);
  $('releaseBtn').textContent = b.status === 'partial'
    ? `Resume release (${b.recipients.length - made} left)`
    : `Release ${b.recipients.length} orders`;

  const releasing = b.status === 'releasing' || made > 0 || failed > 0;
  show('releaseProgress', releasing);
  $('releaseBar').style.width = `${Math.round((made / b.recipients.length) * 100)}%`;
  $('releaseLabel').textContent =
    `${made} of ${b.recipients.length} orders created` + (failed ? ` · ${failed} failed` : '');

  setStep(['released'].includes(b.status) ? 6 : (['paid', 'releasing', 'partial'].includes(b.status) ? 5 : 4));

  // Results
  $('resultsBody').innerHTML = b.recipients.map(r => {
    const c = r.child || {};
    const status = c.orderId ? 'ok' : c.error ? 'stop' : '';
    const items = r.lines.map(l => `${l.qty}× ${esc(l.sku)}`).join(', ');
    const result = c.orderId ? `Created${c.recovered ? ' (found existing)' : ''}` :
                   c.error ? esc(c.error) : 'Not created yet';
    return `<tr data-status="${status}">
      <td class="rail"><span class="rail__code">${esc(c.orderName || '—')}</span></td>
      <td class="plain">${esc(r.firstName)} ${esc(r.lastName)}${r.company ? `<br><span class="small muted">${esc(r.company)}</span>` : ''}</td>
      <td class="plain">${esc(r.city)}, ${esc(r.state)} ${esc(r.zip)}</td>
      <td class="plain mono small">${items}</td>
      <td class="plain mono">$${esc(r.quote.display.total)}</td>
      <td class="plain small">${result}</td>
    </tr>`;
  }).join('');

  $('bLog').innerHTML = (b.log || []).slice().reverse()
    .map(l => `<li>${esc(new Date(l.at).toLocaleString())} — ${esc(l.msg)}</li>`).join('');
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!currentBatch) return;
  const s = currentBatch.status;
  const delay = s === 'releasing' || s === 'creating' ? 3000 : s === 'awaiting_payment' ? 30000 : 0;
  if (delay) pollTimer = setTimeout(refreshBatch, delay);
}

async function refreshBatch() {
  if (!currentBatch) return;
  try {
    const data = await api('batch-status?id=' + encodeURIComponent(currentBatch.id));
    currentBatch = data.batch;
    renderBatch();
  } catch (err) {
    console.warn('Status check failed:', err.message);
  }
  schedulePoll();
}

async function sendInvoice() {
  if (!confirm(`Email the invoice to ${currentBatch.buyer.email}?`)) return;
  $('sendInvoice').disabled = true;
  try {
    const data = await api('send-invoice', { method: 'POST', body: { id: currentBatch.id } });
    currentBatch = data.batch;
    renderBatch();
  } catch (err) {
    alert(err.message);
    $('sendInvoice').disabled = false;
  }
}

async function release() {
  const b = currentBatch;
  const left = b.recipients.filter(r => !(r.child && r.child.orderId)).length;
  const msg = (b.test ? 'TEST RUN — orders will be Shopify test orders.\n\n' : '') +
    `Create ${left} order${left === 1 ? '' : 's'} in Shopify now?\n\n` +
    'Recipients are not emailed. Each order is tagged ' + CONFIG.orderDefaults.batchTagPrefix + b.id + '.';
  if (!confirm(msg)) return;

  $('releaseBtn').disabled = true;
  try {
    await api('release-batch-background', { method: 'POST', body: { id: b.id } });
    currentBatch.status = 'releasing';
    renderBatch();
    setTimeout(refreshBatch, 2500);
  } catch (err) {
    alert(err.message);
  } finally {
    $('releaseBtn').disabled = false;
  }
}

/* --- Exports -------------------------------------------------------------- */

function taxRows(list, quoteOf) {
  return list.map(r => {
    const q = quoteOf(r);
    return q && q.cents ? [
      [r.firstName, r.lastName].join(' '), r.company || '', r.city, r.state, r.zip,
      (q.cents.gross / 100).toFixed(2), (q.cents.discount / 100).toFixed(2),
      (q.cents.merchandise / 100).toFixed(2), (q.cents.shipping / 100).toFixed(2),
      (q.cents.tax / 100).toFixed(2), (q.cents.total / 100).toFixed(2),
      (q.taxLines || []).map(t => `${t.title} ${(t.rate * 100).toFixed(3)}% $${(t.cents / 100).toFixed(2)}`).join('; ')
    ] : null;
  }).filter(Boolean);
}

const TAX_FIELDS = ['recipient', 'company', 'city', 'state', 'zip', 'gross', 'discount',
  'merchandise', 'shipping', 'tax', 'total', 'tax_lines'];

function exportFixed() {
  downloadCsv(`${$('batchId').textContent}-corrected.csv`,
    COLUMNS.map(c => c.key), rows.map(r => COLUMNS.map(c => r[c.key])));
}

/* --- Saved batches -------------------------------------------------------- */

async function openBatchesDialog() {
  $('batchesDialog').showModal();
  $('batchesBody').innerHTML = '<tr><td class="plain muted" colspan="7">Loading…</td></tr>';
  try {
    const { batches } = await api('batch-status');
    $('batchesEmpty').hidden = batches.length > 0;
    $('batchesBody').innerHTML = batches.map(b => `
      <tr>
        <td class="plain mono">${esc(b.id)}${b.test ? ' <span class="small muted">test</span>' : ''}</td>
        <td class="plain">${esc((STATUS[b.status] || {}).label || b.status)}</td>
        <td class="plain">${esc(b.buyer || '—')}</td>
        <td class="plain mono">${b.recipients}</td>
        <td class="plain mono">$${esc(b.total || '0.00')}</td>
        <td class="plain small">${esc(new Date(b.createdAt).toLocaleDateString())}</td>
        <td class="plain"><button data-open="${esc(b.id)}">Open</button></td>
      </tr>`).join('');
  } catch (err) {
    $('batchesBody').innerHTML = `<tr><td class="plain" colspan="7">${esc(err.message)}</td></tr>`;
  }
}

/* --- Wiring --------------------------------------------------------------- */

function init() {
  const dz = $('dropzone');
  const fi = $('fileInput');

  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.dataset.drag = 'true'; }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.dataset.drag = 'false'; }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) ingest(f); });
  fi.addEventListener('change', e => { if (e.target.files[0]) ingest(e.target.files[0]); });

  // Edits write back to the row model. Any edit makes an existing quote stale.
  $('gridBody').addEventListener('input', e => {
    const t = e.target;
    if (!t.classList.contains('cell')) return;
    const r = rows[+t.dataset.row];
    r[t.dataset.key] = t.value;
    if (t.dataset.key === 'state') r.state = normaliseState(t.value);
    invalidateQuote();
    $('getQuote').disabled = true;
  });

  ['discountPct', 'shippingEach', 'testMode'].forEach(id =>
    $(id).addEventListener('input', () => { if (quoteFresh) invalidateQuote(); }));
  $('testMode').addEventListener('change', () => { if (quoteFresh) invalidateQuote(); });

  $('recheck').addEventListener('click', validate);
  $('exportFixed').addEventListener('click', exportFixed);
  $('startOver').addEventListener('click', () => location.reload());

  const chips = { all: $('fAll'), stop: $('fStop'), warn: $('fWarn') };
  Object.entries(chips).forEach(([name, btn]) => btn.addEventListener('click', () => {
    filter = name;
    Object.entries(chips).forEach(([n, b]) => b.setAttribute('aria-pressed', String(n === name)));
    renderBody();
  }));

  $('getQuote').addEventListener('click', getQuote);
  $('createBatch').addEventListener('click', createBatch);
  $('taxCsvQuote').addEventListener('click', () => downloadCsv(
    `${$('batchId').textContent}-tax-quote.csv`, TAX_FIELDS,
    taxRows(buildRecipients(), r => quotes[r.clientKey])));

  $('sendInvoice').addEventListener('click', sendInvoice);
  $('checkPayment').addEventListener('click', refreshBatch);
  $('releaseBtn').addEventListener('click', release);
  $('taxCsvBatch').addEventListener('click', () => downloadCsv(
    `${currentBatch.id}-tax.csv`, TAX_FIELDS, taxRows(currentBatch.recipients, r => r.quote)));
  $('resultsCsv').addEventListener('click', () => downloadCsv(
    `${currentBatch.id}-results.csv`,
    ['recipient', 'company', 'city', 'state', 'zip', 'items', 'order', 'result', 'sheet_rows'],
    currentBatch.recipients.map(r => [
      `${r.firstName} ${r.lastName}`, r.company, r.city, r.state, r.zip,
      r.lines.map(l => `${l.qty}x ${l.sku}`).join('; '),
      (r.child && r.child.orderName) || '',
      r.child ? (r.child.orderId ? 'created' : r.child.error) : 'not created',
      (r.rows || []).join(' ')
    ])));

  $('openBatches').addEventListener('click', openBatchesDialog);
  $('batchesClose').addEventListener('click', () => $('batchesDialog').close());
  $('batchesBody').addEventListener('click', async e => {
    const id = e.target.dataset && e.target.dataset.open;
    if (!id) return;
    try {
      const data = await api('batch-status?id=' + encodeURIComponent(id));
      $('batchesDialog').close();
      openBatch(data.batch);
    } catch (err) { alert(err.message); }
  });

  loadConfig();
}

document.addEventListener('DOMContentLoaded', init);
