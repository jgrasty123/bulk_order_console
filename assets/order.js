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
import { buildIndex, matchGift, displayTitle } from '/shared/giftmatch.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const COLS = [
  { key: 'firstName', label: 'First name', cls: 'c-first' },
  { key: 'lastName', label: 'Last name', cls: 'c-last' },
  { key: 'sku', label: 'Gift', cls: 'c-gift', select: true },
  { key: 'qty', label: 'Qty', cls: 'c-qty', mode: 'numeric' },
  { key: 'giftMessage', label: 'Gift message', cls: 'c-msg' },
  { key: 'deliveryDate', label: 'Deliver on', cls: 'c-date', type: 'date' },
  { key: 'company', label: 'Company' },
  { key: 'address1', label: 'Street address', cls: 'c-addr' },
  { key: 'address2', label: 'Apt / suite' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State', cls: 'c-st' },
  { key: 'zip', label: 'ZIP', cls: 'c-zip', mode: 'numeric' },
  { key: 'phone', label: 'Phone', mode: 'tel' },
  { key: 'email', label: 'Email', cls: 'c-email', mode: 'email' }
];
const FIELD_TO_COLS = {
  firstName: ['firstName'], lastName: ['lastName'], address1: ['address1'], city: ['city'],
  state: ['state'], zip: ['zip'], phone: ['phone'], email: ['email'], lines: ['sku', 'qty'],
  giftMessage: ['giftMessage'], deliveryDate: ['deliveryDate']
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
  gift_sku: 'giftText', sku: 'giftText', gift: 'giftText', gift_name: 'giftText', product: 'giftText',
  product_name: 'giftText', item: 'giftText', basket: 'giftText',
  qty: 'qty', quantity: 'qty', gift_message: 'giftMessage', message: 'giftMessage', note: 'giftMessage',
  card_message: 'giftMessage', delivery_date: 'deliveryDate', deliver_on: 'deliveryDate', ship_date: 'deliveryDate',
  date: 'deliveryDate'
};

let CONFIG, catalog = new Map(), giftIndex = [], rows = [], seq = 1;
let priced = null;         // { recipients, quotes, discountPct }

/* --- Setup ------------------------------------------------------------------ */

async function init() {
  CONFIG = await (await fetch('/config/shipping-rules.json')).json();
  const mail = `mailto:${CONFIG.publicSite.supportEmail}?subject=${encodeURIComponent('Corporate gift order')}`;
  $('helpLink').href = mail; $('footHelp').href = mail;

  try {
    const { items } = await (await fetch('/.netlify/functions/order-catalog')).json();
    items.forEach((i) => catalog.set(i.sku, { ...i, title: displayTitle(i.title) }));
    giftIndex = buildIndex([...catalog.values()]);
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

/* --- Helpers for per-row message and date --------------------------------------- */

const today = () => new Date().toISOString().slice(0, 10);

// What a blank message cell will actually send, shown as grey placeholder text.
function previewFor(r) {
  const t = $('message') ? $('message').value : '';
  return t ? mergeMessage(t, r) : 'No message';
}

// Spreadsheets arrive as 2026-12-15, 12/15/2026, 12/15/26, or "Dec 15 2026".
function isoDate(v) {
  const s = clean(v);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function refreshPreviews() {
  document.querySelectorAll('#rows input[data-k="giftMessage"]').forEach((el) => {
    const r = rows.find((x) => x.id === Number(el.closest('tr').dataset.id));
    el.placeholder = previewFor(r);
  });
}

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
        const hint = r.giftText && !r.sku ? ` title="You wrote: ${esc(r.giftText)}"` : '';
        return `<td class="${cls}"${hint}><select data-k="sku" aria-label="Gift, row ${i + 1}"><option value="">${r.giftText && !r.sku ? `“${esc(r.giftText)}” — choose…` : 'Choose a gift…'}</option>${giftOptions(r.sku)}</select></td>`;
      }
      const ph = c.key === 'giftMessage' ? previewFor(r) : '';
      return `<td class="${cls}"><input data-k="${c.key}" value="${esc(r[c.key])}" aria-label="${c.label}, row ${i + 1}"` +
        `${c.type ? ` type="${c.type}" min="${today()}"` : ''}${c.mode ? ` inputmode="${c.mode}"` : ''}` +
        `${ph ? ` placeholder="${esc(ph)}"` : ''} autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other"></td>`;
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
        const m = matchGift(r.giftText, giftIndex);
        r.sku = m.confidence === 'exact' || m.confidence === 'likely' ? m.sku : '';
        r.match = m.confidence === 'exact' ? 'ok' : r.giftText ? m.confidence : 'ok';
        r.candidates = m.candidates;
        r.qty = r.qty || '1';
        if (r.state) r.state = normaliseState(r.state);   // "California" → "CA" in the grid too
        if (r.deliveryDate) r.deliveryDate = isoDate(r.deliveryDate);
        return r;
      }).filter((r) => r.firstName || r.lastName || r.address1);
      if (rows.every((r) => !r.firstName && !r.address1 && !r.sku)) rows = [];
      incoming.forEach((r) => addRow(r));
      invalidate();
      renderRows();
      renderMatches();
      showIssues([]);
    }
  });
}

/* --- Gift matching ------------------------------------------------------------
   One decision per distinct name the customer typed, not per row. Confident
   matches are pre-selected but still need a Confirm, because a wrong guess
   would ship the wrong basket to everyone who shares that name.
   -------------------------------------------------------------------------------- */

const pending = () => {
  const groups = new Map();
  for (const r of rows) {
    if (!r.giftText || r.match === 'ok') continue;
    const k = r.giftText.trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, { text: r.giftText.trim(), rows: [], state: r.match, sku: r.sku, candidates: r.candidates || [] });
    groups.get(k).rows.push(r);
  }
  return [...groups.values()];
};

function renderMatches() {
  const list = pending();
  const box = $('matchPanel');
  box.hidden = !list.length;
  if (!list.length) { $('matchList').innerHTML = ''; box._groups = []; return; }
  const others = (skip) => [...catalog.values()].filter((i) => !skip.includes(i.sku))
    .map((i) => `<option value="${esc(i.sku)}">${esc(i.title)} — $${esc(i.price)}</option>`).join('');
  $('matchList').innerHTML = list.map((g, n) => {
    const best = g.candidates.filter((s) => catalog.has(s));
    const opts = `<option value="">${g.state === 'likely' ? 'Choose…' : 'Pick the gift you meant…'}</option>` +
      (best.length ? `<optgroup label="Best matches">${best.map((s) => {
        const i = catalog.get(s);
        return `<option value="${esc(s)}"${s === g.sku ? ' selected' : ''}>${esc(i.title)} — $${esc(i.price)}</option>`;
      }).join('')}</optgroup>` : '') +
      `<optgroup label="All gifts">${others(best)}</optgroup>`;
    const tag = g.state === 'likely' ? '<span class="tag tag--ok">Matched</span>'
      : g.state === 'none' ? '<span class="tag tag--bad">No match</span>' : '<span class="tag tag--warn">Pick one</span>';
    return `<li data-n="${n}">${tag}
      <span class="match__typed">“${esc(g.text)}”<small>${g.rows.length} row${g.rows.length === 1 ? '' : 's'}</small></span>
      <span class="match__arrow">→</span>
      <select data-match="${n}" aria-label="Gift for “${esc(g.text)}”">${opts}</select>
      ${g.state === 'likely' ? `<button type="button" class="btn" data-confirm="${n}">Confirm</button>` : '<span></span>'}</li>`;
  }).join('');
  const likely = list.filter((g) => g.state === 'likely' && g.sku).length;
  $('confirmAll').hidden = likely < 2;
  $('confirmAll').textContent = `Confirm all ${likely} matches`;
  $('matchPanel')._groups = list;
}

function settle(g, sku) {
  g.rows.forEach((r) => { r.sku = sku; r.match = 'ok'; });
  invalidate(); renderRows(); renderMatches();
}

function wireMatches() {
  $('matchList').addEventListener('change', (e) => {
    const n = e.target.dataset.match; if (n === undefined) return;
    const g = $('matchPanel')._groups[+n];
    // Choosing from the list is the decision — apply it straight away.
    if (e.target.value) settle(g, e.target.value);
  });
  $('matchList').addEventListener('click', (e) => {
    const n = e.target.dataset.confirm; if (n === undefined) return;
    const g = $('matchPanel')._groups[+n];
    if (g.sku) settle(g, g.sku);
  });
  $('confirmAll').addEventListener('click', () => {
    ($('matchPanel')._groups || []).filter((g) => g.state === 'likely' && g.sku)
      .forEach((g) => g.rows.forEach((r) => { r.sku = g.sku; r.match = 'ok'; }));
    invalidate(); renderRows(); renderMatches();
  });
  $('giftList').addEventListener('click', () => {
    const csv = Papa.unparse({ fields: ['gift', 'price', 'sku'],
      data: [...catalog.values()].filter((i) => i.available).map((i) => [i.title, i.price, i.sku]) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'brobasket-corporate-gift-list.csv'; a.click();
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
    deliveryDate: g.deliveryDate || deliveryDate
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

  const open = pending();
  if (open.length) {
    problems.push({ sev: 'stop', msg: `Please check ${open.length} gift name${open.length === 1 ? '' : 's'} from your spreadsheet in “Check your gifts” above.` });
  }
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
  const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'As soon as possible';
  $('priceRows').innerHTML = recipients.map((r) => {
    const q = quotes[r.key];
    for (const k of Object.keys(t)) t[k] += q.cents[k];
    const gifts = r.lines.map((l) => `${l.qty > 1 ? l.qty + '× ' : ''}${esc((catalog.get(l.sku) || {}).title || l.sku)}`).join('<br>');
    const addr = [r.address1, r.address2].filter(Boolean).map(esc).join(', ') + `<br>${esc(r.city)}, ${esc(r.state)} ${esc(r.zip)}`;
    const contact = [r.phone, r.email].filter(Boolean).map(esc).join('<br>');
    return `<tr>
      <td><b>${esc(r.firstName)} ${esc(r.lastName)}</b>${r.company ? `<br><small class="muted">${esc(r.company)}</small>` : ''}</td>
      <td>${addr}${contact ? `<br><small class="muted">${contact}</small>` : ''}</td>
      <td>${gifts}</td>
      <td class="msg">${r.giftMessage ? `“${esc(r.giftMessage)}”` : '<span class="muted">No message</span>'}</td>
      <td>${esc(fmtDate(r.deliveryDate))}</td>
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
    if (e.target.dataset.k === 'sku') { r.match = 'ok'; renderMatches(); }
    if (e.target.dataset.k === 'state' && e.target.value.length > 2) r.state = normaliseState(e.target.value);
    e.target.closest('td').classList.remove('bad', 'warn');
    if (['firstName', 'lastName', 'company'].includes(e.target.dataset.k)) {
      const msg = tr.querySelector('input[data-k="giftMessage"]');
      if (msg) msg.placeholder = previewFor(r);
    }
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
    refreshPreviews();
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
  wireMatches();
  $('submitBtn').addEventListener('click', submit);
  renderRows();
}

init();
