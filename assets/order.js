/* ==========================================================================
   Corporate ordering — customer page
   1 recipients → 2 price → 3 details → pay (Shopify checkout)

   Checks here are for the customer's benefit: they show problems while the
   sheet is still open. The server runs the same rules again before it
   prices or saves anything.
   ========================================================================== */

import {
  checkRecipient, groupRows, mergeMessage, discountFor, isAdult, normaliseState, clean, EMAIL_RE
} from '/shared/rules.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const COLS = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'sku', label: 'Gift', cls: 'c-gift', select: true },
  { key: 'qty', label: 'Qty', cls: 'c-qty', mode: 'numeric' },
  { key: 'company', label: 'Company' },
  { key: 'address1', label: 'Street address' },
  { key: 'address2', label: 'Apt / suite' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State', cls: 'c-st' },
  { key: 'zip', label: 'ZIP', cls: 'c-zip', mode: 'numeric' },
  { key: 'phone', label: 'Phone', mode: 'tel' }
];
const FIELD_TO_COLS = {
  firstName: ['firstName'], lastName: ['lastName'], address1: ['address1'], city: ['city'],
  state: ['state'], zip: ['zip'], phone: ['phone'], lines: ['sku', 'qty']
};

// Spreadsheet headings we understand, normalised → our field.
const HEADERS = {
  first_name: 'firstName', firstname: 'firstName', first: 'firstName',
  last_name: 'lastName', lastname: 'lastName', last: 'lastName',
  company: 'company', company_name: 'company',
  address1: 'address1', address: 'address1', street: 'address1', street_address: 'address1', address_1: 'address1',
  address2: 'address2', address_2: 'address2', apt: 'address2', suite: 'address2', apt_suite: 'address2',
  city: 'city', state: 'state', province: 'state', zip: 'zip', zip_code: 'zip', zipcode: 'zip', postal_code: 'zip',
  phone: 'phone', phone_number: 'phone', email: 'email',
  gift_sku: 'sku', sku: 'sku', gift: 'sku', product: 'sku',
  qty: 'qty', quantity: 'qty', gift_message: 'giftMessage', message: 'giftMessage', note: 'giftMessage'
};

let CONFIG, catalog = new Map(), rows = [], seq = 1;
let priced = null;         // { recipients, quotes, discountPct }

/* --- Setup ------------------------------------------------------------------ */

async function init() {
  CONFIG = await (await fetch('/config/shipping-rules.json')).json();
  const mail = `mailto:${CONFIG.publicSite.supportEmail}?subject=${encodeURIComponent('Corporate gift order')}`;
  $('helpLink').href = mail; $('footHelp').href = mail;

  try {
    const { items } = await (await fetch('/.netlify/functions/order-catalog')).json();
    items.forEach((i) => catalog.set(i.sku, i));
  } catch {
    showIssues([{ sev: 'stop', msg: 'Our gift list didn’t load. Please refresh the page.' }]);
  }
  $('giftAll').insertAdjacentHTML('beforeend', giftOptions(''));

  addRow(); addRow();
  wire();
  if (CONFIG.publicSite.turnstileSiteKey) loadTurnstile(CONFIG.publicSite.turnstileSiteKey);
}

const giftOptions = (selected) => [...catalog.values()].map((i) =>
  `<option value="${esc(i.sku)}"${i.sku === selected ? ' selected' : ''}${i.available ? '' : ' disabled'}>` +
  `${esc(i.title)} — $${esc(i.price)}${i.available ? '' : ' (sold out)'}</option>`).join('');

/* --- Rows ---------------------------------------------------------------------- */

function addRow(data = {}) {
  rows.push({ id: seq++, firstName: '', lastName: '', company: '', address1: '', address2: '', city: '', state: '',
    zip: '', phone: '', email: '', sku: '', qty: '1', giftMessage: '', ...data });
}

function renderRows(issueMap = new Map()) {
  const body = $('rows');
  body.innerHTML = '';
  const frag = document.createDocumentFragment();
  rows.forEach((r, i) => {
    const bad = issueMap.get(r.id) || { stop: new Set(), warn: new Set() };
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    if (bad.stop.size) tr.className = 'row-err';
    tr.innerHTML = `<td class="c-n">${i + 1}</td>` + COLS.map((c) => {
      const cls = [c.cls, bad.stop.has(c.key) ? 'bad' : bad.warn.has(c.key) ? 'warn' : ''].filter(Boolean).join(' ');
      if (c.select) {
        return `<td class="${cls}"><select data-k="sku" aria-label="Gift, row ${i + 1}"><option value="">Choose a gift…</option>${giftOptions(r.sku)}</select></td>`;
      }
      return `<td class="${cls}"><input data-k="${c.key}" value="${esc(r[c.key])}" aria-label="${c.label}, row ${i + 1}"` +
        `${c.mode ? ` inputmode="${c.mode}"` : ''} autocomplete="off"></td>`;
    }).join('') + `<td class="c-x"><button type="button" data-del="${r.id}" aria-label="Remove row ${i + 1}">×</button></td>`;
    frag.appendChild(tr);
  });
  body.appendChild(frag);
  $('emptyNote').hidden = rows.length > 0;
  updateCount();
}

function updateCount() {
  const filled = rows.filter((r) => r.firstName || r.address1 || r.sku);
  const people = new Set(filled.map((r) => [r.firstName, r.lastName, r.address1, r.zip].join('|').toLowerCase())).size;
  const gifts = filled.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  $('countLine').textContent = filled.length
    ? `${people} recipient${people === 1 ? '' : 's'} · ${gifts} gift${gifts === 1 ? '' : 's'}` +
      (people >= 20 ? ' · 10% volume discount applies' : people >= 15 ? ` · ${20 - people} more for 10% off` : '')
    : '';
}

function invalidate() {
  priced = null;
  $('step2').hidden = true;
  $('step3').hidden = true;
  $('done').hidden = true;
}

/* --- Spreadsheet --------------------------------------------------------------- */

function findSku(v) {
  const s = clean(v);
  if (!s) return '';
  if (catalog.has(s)) return s;
  const upper = s.toUpperCase();
  for (const k of catalog.keys()) if (k.toUpperCase() === upper) return k;
  const lower = s.toLowerCase();
  for (const i of catalog.values()) if (i.title.toLowerCase() === lower) return i.sku;
  return s;  // keep what they typed; checking will flag it
}

function ingest(file) {
  Papa.parse(file, {
    header: true, skipEmptyLines: 'greedy',
    transformHeader: (h) => clean(h).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    complete: (res) => {
      const map = {};
      for (const h of res.meta.fields || []) if (HEADERS[h]) map[h] = HEADERS[h];
      const needed = ['firstName', 'lastName', 'address1', 'city', 'state', 'zip'];
      const have = new Set(Object.values(map));
      const missing = needed.filter((n) => !have.has(n));
      if (missing.length) {
        showIssues([{ sev: 'stop', msg: `Your spreadsheet is missing: ${missing.join(', ')}. Download the template to see the columns we use.` }]);
        return;
      }
      const incoming = res.data.map((raw) => {
        const r = {};
        for (const [h, k] of Object.entries(map)) r[k] = clean(raw[h]);
        r.sku = findSku(r.sku);
        r.qty = r.qty || '1';
        if (r.state) r.state = normaliseState(r.state);   // "California" → "CA" in the grid too
        return r;
      }).filter((r) => r.firstName || r.lastName || r.address1);
      if (rows.every((r) => !r.firstName && !r.address1 && !r.sku)) rows = [];
      incoming.forEach((r) => addRow(r));
      invalidate();
      renderRows();
      showIssues([]);
    }
  });
}

/* --- Checking + pricing ------------------------------------------------------------ */

function showIssues(list) {
  const ul = $('issues');
  ul.hidden = !list.length;
  ul.innerHTML = list.slice(0, 40).map((i) =>
    `<li class="${i.sev === 'warn' ? 'warn' : ''}">${i.where ? `<b>${esc(i.where)}</b>` : ''}${esc(i.msg)}</li>`).join('') +
    (list.length > 40 ? `<li>…and ${list.length - 40} more.</li>` : '');
}

function buildRecipients() {
  const filled = rows.filter((r) => r.firstName || r.lastName || r.address1 || r.sku);
  const groups = groupRows(filled.map((r) => ({ ...r, rowNumber: r.id })));
  const template = $('message').value;
  const deliveryDate = $('deliveryDate').value;
  return groups.map((g, i) => ({
    ...g,
    key: 'r' + i,
    giftMessage: g.giftMessage || mergeMessage(template, g),
    deliveryDate
  }));
}

const rowLabel = (ids) => {
  const n = ids.map((id) => rows.findIndex((r) => r.id === id) + 1).filter((x) => x > 0);
  return n.length ? `Row ${n.join(', ')}: ` : '';
};

async function price() {
  const recipients = buildRecipients();
  const problems = [];
  const issueMap = new Map();
  const mark = (ids, field, sev) => ids.forEach((id) => {
    if (!issueMap.has(id)) issueMap.set(id, { stop: new Set(), warn: new Set() });
    (FIELD_TO_COLS[field] || []).forEach((c) => issueMap.get(id)[sev].add(c));
  });

  if (recipients.length < CONFIG.limits.minRecipientsPerBatch) {
    problems.push({ sev: 'stop', msg: `Corporate orders need at least ${CONFIG.limits.minRecipientsPerBatch} recipients.` });
  }
  if (recipients.length > CONFIG.limits.maxRowsPerBatch) {
    problems.push({ sev: 'stop', msg: `Orders can have up to ${CONFIG.limits.maxRowsPerBatch} recipients. Split your list into two orders.` });
  }
  for (const r of recipients) {
    for (const i of checkRecipient(r, CONFIG)) {
      problems.push({ ...i, where: rowLabel(r.rows) });
      mark(r.rows, i.field, i.sev);
    }
    for (const l of r.lines) {
      if (l.sku && !catalog.has(l.sku)) {
        problems.push({ sev: 'stop', where: rowLabel(r.rows), msg: `We don’t recognise the gift “${l.sku}”. Pick one from the list.` });
        mark(r.rows, 'lines', 'stop');
      }
    }
  }
  renderRows(issueMap);
  const blocking = problems.filter((p) => p.sev === 'stop');
  showIssues(blocking.length ? blocking : problems);
  if (blocking.length) { $('issues').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

  // Price in small chunks; the server re-checks everything.
  $('step2').hidden = false;
  $('priceResult').hidden = true;
  $('progress').hidden = false;
  $('priceBtn').disabled = true;
  $('step2').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const quotes = {};
  let discountPct = 0, done = 0;
  try {
    for (let i = 0; i < recipients.length; i += 5) {
      const part = recipients.slice(i, i + 5);
      $('progressLabel').textContent = `Pricing ${done} of ${recipients.length} addresses…`;
      const res = await fetch('/.netlify/functions/order-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: part, batchSize: recipients.length })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Pricing failed.');
      Object.assign(quotes, data.quotes);
      discountPct = data.discountPct;
      done += part.length;
      $('progressBar').style.width = `${Math.round((done / recipients.length) * 100)}%`;
    }
  } catch (err) {
    $('progressLabel').textContent = `We couldn’t finish pricing: ${err.message}`;
    $('priceBtn').disabled = false;
    return;
  }
  $('priceBtn').disabled = false;
  $('progress').hidden = true;

  const failed = recipients.filter((r) => quotes[r.key] && quotes[r.key].error);
  if (failed.length) {
    failed.forEach((r) => mark(r.rows, 'address1', 'stop'));
    renderRows(issueMap);
    showIssues(failed.map((r) => ({ sev: 'stop', where: rowLabel(r.rows), msg: quotes[r.key].error })));
    $('step2').hidden = true;
    $('issues').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  priced = { recipients, quotes, discountPct };
  renderPrice();
  $('step3').hidden = false;
}

function renderPrice() {
  const { recipients, quotes, discountPct } = priced;
  const t = { merchandise: 0, discount: 0, shipping: 0, tax: 0, total: 0 };
  $('priceRows').innerHTML = recipients.map((r) => {
    const q = quotes[r.key];
    for (const k of Object.keys(t)) t[k] += q.cents[k];
    const gifts = r.lines.map((l) => `${l.qty > 1 ? l.qty + '× ' : ''}${esc((catalog.get(l.sku) || {}).title || l.sku)}`).join('<br>');
    return `<tr><td>${esc(r.firstName)} ${esc(r.lastName)}${r.company ? `<br><small class="muted">${esc(r.company)}</small>` : ''}</td>
      <td>${esc(r.city)}, ${esc(r.state)}</td><td>${gifts}</td>
      <td>${esc(q.shippingTitle)}<br><small class="mono">${usd(q.cents.shipping)}</small></td>
      <td class="num">${usd(q.cents.tax)}</td><td class="num"><b>${usd(q.cents.total)}</b></td></tr>`;
  }).join('');

  $('summary').innerHTML =
    `<div><b>${recipients.length}</b><span>recipients</span></div>` +
    `<div><b>${usd(t.merchandise)}</b><span>gifts${discountPct ? ` after ${discountPct}% off` : ''}</span></div>` +
    (t.discount ? `<div><b>−${usd(t.discount)}</b><span>you save</span></div>` : '') +
    `<div><b>${usd(t.shipping)}</b><span>shipping</span></div>` +
    `<div><b>${usd(t.tax)}</b><span>tax</span></div>` +
    `<div><b>${usd(t.total)}</b><span>total</span></div>`;
  priced.total = t.total;

  const toGo = 20 - recipients.length;
  $('nudge').hidden = !(discountPct === 0 && toGo > 0 && toGo <= 5);
  $('nudge').textContent = `Add ${toGo} more recipient${toGo === 1 ? '' : 's'} and your whole order gets 10% off.`;
  $('submitBtn').textContent = `Continue to secure checkout · ${usd(t.total)}`;
  $('priceResult').hidden = false;
}

/* --- Submit ------------------------------------------------------------------------ */

let turnstileToken = '';

async function submit() {
  const err = (m) => { $('submitError').hidden = false; $('submitError').textContent = m; };
  $('submitError').hidden = true;
  if (!priced) return err('Please get a price first.');

  const buyer = {
    name: clean($('bName').value), company: clean($('bCompany').value), email: clean($('bEmail').value),
    phone: clean($('bPhone').value), poNumber: clean($('bPo').value), dob: $('bDob').value
  };
  if (!buyer.name) return err('Please enter your name.');
  if (!EMAIL_RE.test(buyer.email)) return err('Please enter a valid email.');
  if (!isAdult(buyer.dob)) return err('You must be 21 or older to place this order.');
  if (CONFIG.publicSite.turnstileSiteKey && !turnstileToken) return err('Please complete the security check.');

  $('submitBtn').disabled = true;
  $('submitBtn').textContent = 'Creating your invoice…';
  try {
    const res = await fetch('/.netlify/functions/order-submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyer, turnstileToken, deliveryDate: $('deliveryDate').value,
        recipients: priced.recipients.map((r) => ({ ...r, quote: priced.quotes[r.key] }))
      })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'stale_quote' || data.error === 'bad_quote') invalidate();
      throw new Error(data.message || 'Something went wrong.');
    }
    $('doneId').textContent = data.id;
    $('payLink').href = data.invoiceUrl;
    $('payTotal').textContent = usd(Math.round(parseFloat(data.total) * 100));
    $('statusLink').href = data.statusUrl;
    $('doneEmail').textContent = buyer.email;
    ['step1', 'step2', 'step3'].forEach((id) => { $(id).hidden = true; });
    $('done').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    err(e.message);
    $('submitBtn').disabled = false;
    $('submitBtn').textContent = `Continue to secure checkout · ${usd(priced ? priced.total : 0)}`;
  }
}

function loadTurnstile(siteKey) {
  window.onTurnstile = () => window.turnstile.render('#turnstile', {
    sitekey: siteKey, callback: (t) => { turnstileToken = t; }
  });
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstile';
  s.async = true;
  document.head.appendChild(s);
}

/* --- Wiring -------------------------------------------------------------------------- */

function wire() {
  $('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) ingest(e.target.files[0]); e.target.value = ''; });
  $('addRow').addEventListener('click', () => { addRow(); invalidate(); renderRows();
    const last = $('rows').lastElementChild; if (last) last.querySelector('input').focus(); });
  $('applyAll').addEventListener('click', () => {
    const sku = $('giftAll').value; if (!sku) return;
    rows.forEach((r) => { r.sku = sku; }); invalidate(); renderRows();
  });
  $('rows').addEventListener('input', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const r = rows.find((x) => x.id === Number(tr.dataset.id));
    r[e.target.dataset.k] = e.target.value;
    if (e.target.dataset.k === 'state' && e.target.value.length > 2) r.state = normaliseState(e.target.value);
    e.target.closest('td').classList.remove('bad', 'warn');
    invalidate(); updateCount();
  });
  $('rows').addEventListener('focusout', (e) => {
    if (e.target.dataset.k !== 'state') return;
    const r = rows.find((x) => x.id === Number(e.target.closest('tr').dataset.id));
    r.state = normaliseState(e.target.value); e.target.value = r.state;
  });
  $('rows').addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.del; if (!id) return;
    rows = rows.filter((r) => r.id !== Number(id)); invalidate(); renderRows();
  });
  $('message').addEventListener('input', () => {
    invalidate();
    const first = rows.find((r) => r.firstName);
    $('msgPreview').textContent = first && $('message').value ? `Preview: “${mergeMessage($('message').value, first)}”` : '';
  });
  document.querySelectorAll('[data-merge]').forEach((b) => b.addEventListener('click', () => {
    const t = $('message'); const at = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, at) + b.dataset.merge + t.value.slice(at); t.focus();
    t.dispatchEvent(new Event('input'));
  }));
  $('deliveryDate').min = new Date().toISOString().slice(0, 10);
  $('deliveryDate').addEventListener('input', invalidate);
  $('priceBtn').addEventListener('click', price);
  $('submitBtn').addEventListener('click', submit);
  renderRows();
}

init();
