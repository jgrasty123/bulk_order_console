/* ==========================================================================
   Bulk Order Console — validation engine
   Go-To Gifting LLC

   Everything a batch can get wrong is caught here, before a single order
   exists in Shopify. Half-created batches are the failure mode that makes
   people stop trusting the tool, so validation is all-or-nothing: the
   create step stays locked until zero blocking issues remain.
   ========================================================================== */

'use strict';

/* --- Column contract ----------------------------------------------------- */

const COLUMNS = [
  { key: 'recipient_id',  label: 'Group',      required: false },
  { key: 'first_name',    label: 'First',      required: true  },
  { key: 'last_name',     label: 'Last',       required: true  },
  { key: 'company',       label: 'Company',    required: false },
  { key: 'address1',      label: 'Address 1',  required: true  },
  { key: 'address2',      label: 'Address 2',  required: false },
  { key: 'city',          label: 'City',       required: true  },
  { key: 'state',         label: 'State',      required: true  },
  { key: 'zip',           label: 'ZIP',        required: true  },
  { key: 'phone',         label: 'Phone',      required: false },
  { key: 'email',         label: 'Email',      required: false },
  { key: 'sku',           label: 'SKU',        required: true  },
  { key: 'qty',           label: 'Qty',        required: true,  numeric: true },
  { key: 'gift_message',  label: 'Gift message', required: false },
  { key: 'delivery_date', label: 'Deliver on', required: false }
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

const PO_BOX  = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box)\b/i;
const MILITARY = /\b(apo|fpo|dpo)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* --- Rule set ------------------------------------------------------------
   Each rule owns one code, one field, and one plain-language message.
   Codes are stable so the ledger can be filtered and so support can talk
   about "an E14 on row 32" without ambiguity.
   ------------------------------------------------------------------------ */

const RULES = [
  { code:'E10', sev:'stop', field:'first_name',
    test: r => !r.first_name,
    msg:  'First name is empty.' },

  { code:'E11', sev:'stop', field:'last_name',
    test: r => !r.last_name,
    msg:  'Last name is empty.' },

  { code:'E12', sev:'stop', field:'address1',
    test: r => !r.address1,
    msg:  'Street address is empty.' },

  { code:'E13', sev:'stop', field:'city',
    test: r => !r.city,
    msg:  'City is empty.' },

  { code:'E14', sev:'stop', field:'state',
    test: r => !STATE_CODES.has(r.state),
    msg:  'State is not a US state code.' },

  { code:'E15', sev:'stop', field:'zip',
    test: r => !/^\d{5}(-\d{4})?$/.test(r.zip),
    msg:  'ZIP must be 5 digits, or 5+4 with a hyphen.' },

  { code:'E16', sev:'stop', field:'sku',
    test: r => !r.sku,
    msg:  'SKU is empty.' },

  { code:'E17', sev:'stop', field:'qty',
    test: r => !Number.isInteger(+r.qty) || +r.qty < 1 || +r.qty > CONFIG.limits.maxQtyPerLine,
    msg:  () => `Quantity must be a whole number from 1 to ${CONFIG.limits.maxQtyPerLine}.` },

  { code:'E18', sev:'stop', field:'delivery_date',
    test: r => r.delivery_date !== '' && !isUsableDate(r.delivery_date),
    msg:  'Delivery date is unreadable or already past. Use YYYY-MM-DD.' },

  { code:'E19', sev:'stop', field:'address1',
    test: r => CONFIG.carrier.blockPoBoxes &&
               (PO_BOX.test(r.address1 + ' ' + r.address2)),
    msg:  'Carriers will not deliver alcohol to a PO box. Needs a street address.' },

  { code:'E24', sev:'stop', field:'address1',
    test: r => CONFIG.carrier.blockMilitaryAddresses &&
               (MILITARY.test(r.address1 + ' ' + r.address2 + ' ' + r.city)),
    msg:  'Alcohol cannot ship to APO, FPO, or DPO addresses.' },

  { code:'E30', sev:'stop', field:'gift_message',
    test: r => r.gift_message.length > CONFIG.limits.maxGiftMessageChars,
    msg:  () => `Gift message is over ${CONFIG.limits.maxGiftMessageChars} characters.` },

  { code:'W02', sev:'warn', field:'email',
    test: r => r.email !== '' && !EMAIL_RE.test(r.email),
    msg:  'Email does not look valid. Shipment notifications will not reach them.' },

  { code:'W06', sev:'warn', field:'phone',
    test: r => digits(r.phone).length < 10,
    msg:  'No usable phone number. Carriers ask for one on adult-signature deliveries.' }
];

/* --- State -------------------------------------------------------------- */

let CONFIG = null;
let rows = [];             // { _n, _issues:[], ...fields }
let serverStatus = 'idle'; // idle | ok | unavailable
let filter = 'all';

/* --- Helpers ------------------------------------------------------------ */

const $ = id => document.getElementById(id);
const digits = s => (s || '').replace(/\D/g, '');
const clean  = s => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

function isUsableDate(v) {
  const d = new Date(v + (/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'T12:00:00' : ''));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d >= today;
}

function normaliseState(v) {
  const s = clean(v).toUpperCase();
  if (STATE_CODES.has(s)) return s;
  return STATES[s] || s;
}

function batchId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `B${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/* --- Config load -------------------------------------------------------- */

async function loadConfig() {
  const res = await fetch('/config/shipping-rules.json');
  CONFIG = await res.json();
  const screeningOn = CONFIG.screening.mode === 'allowlist' &&
                      CONFIG.screening.shippableStates.length > 0;
  $('screeningNotice').hidden = screeningOn;
}

/* --- Parse -------------------------------------------------------------- */

function ingest(file) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => clean(h).toLowerCase().replace(/\s+/g, '_'),
    complete: results => {
      const headers = results.meta.fields || [];
      const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
      if (missing.length) {
        alert(
          'This sheet is missing required columns:\n\n  ' + missing.join('\n  ') +
          '\n\nDownload the template and match its header row.'
        );
        return;
      }
      rows = results.data.map((raw, i) => {
        const r = { _n: i + 2, _issues: [] };   // _n mirrors the spreadsheet row
        COLUMNS.forEach(c => { r[c.key] = clean(raw[c.key]); });
        r.state = normaliseState(r.state);
        r.zip   = r.zip.replace(/\s/g, '');
        return r;
      });
      $('batchId').textContent = batchId();
      $('uploadStage').hidden = true;
      $('reviewStage').hidden = false;
      setStep(2);
      validate();
    }
  });
}

/* --- Validation --------------------------------------------------------- */

async function validate() {
  rows.forEach(r => { r._issues = []; });

  // Pass 1 — per-row rules that need nothing but the row itself.
  rows.forEach(r => {
    RULES.forEach(rule => {
      let bad = false;
      try { bad = rule.test(r); } catch { bad = false; }
      if (bad) {
        r._issues.push({
          code: rule.code,
          sev:  rule.sev,
          field: rule.field,
          msg:  typeof rule.msg === 'function' ? rule.msg(r) : rule.msg
        });
      }
    });
  });

  // Pass 2 — cross-row checks.
  crossRowChecks();

  // Pass 3 — anything that needs Shopify.
  await serverChecks();

  render();
}

function crossRowChecks() {
  const byGroup = new Map();
  const seenAddress = new Map();

  rows.forEach(r => {
    // Rows sharing a recipient_id must agree on where they are going.
    if (r.recipient_id) {
      const sig = [r.first_name, r.last_name, r.address1, r.address2, r.city, r.state, r.zip]
        .join('|').toLowerCase();
      const prev = byGroup.get(r.recipient_id);
      if (prev && prev !== sig) {
        r._issues.push({
          code: 'E23', sev: 'stop', field: 'recipient_id',
          msg: `Group ${r.recipient_id} is used on rows with different addresses. Give them separate group IDs.`
        });
      } else if (!prev) {
        byGroup.set(r.recipient_id, sig);
      }
    }

    // Same person, same address, no shared group — probably a duplicated paste.
    const addrKey = [r.first_name, r.last_name, r.address1, r.zip, r.sku]
      .join('|').toLowerCase();
    if (addrKey !== '||||' && seenAddress.has(addrKey) && !r.recipient_id) {
      r._issues.push({
        code: 'W01', sev: 'warn', field: 'last_name',
        msg: `Same person and SKU as row ${seenAddress.get(addrKey)}. Two orders will be created unless they share a group ID.`
      });
    } else if (!seenAddress.has(addrKey)) {
      seenAddress.set(addrKey, r._n);
    }
  });

  // Batch-level ceilings.
  if (rows.length > CONFIG.limits.maxRowsPerBatch) {
    rows.slice(CONFIG.limits.maxRowsPerBatch).forEach(r => {
      r._issues.push({
        code: 'E22', sev: 'stop', field: 'recipient_id',
        msg: `Batch limit is ${CONFIG.limits.maxRowsPerBatch} rows. Split this sheet.`
      });
    });
  }
}

async function serverChecks() {
  const skus   = [...new Set(rows.map(r => r.sku).filter(Boolean))];
  const states = [...new Set(rows.map(r => r.state).filter(Boolean))];
  if (!skus.length) { serverStatus = 'idle'; return; }

  let data;
  try {
    const res = await fetch('/.netlify/functions/validate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus, states })
    });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
    serverStatus = 'ok';
  } catch {
    serverStatus = 'unavailable';
    return;
  }

  $('storeLabel').textContent = data.shop || 'connected';

  rows.forEach(r => {
    const hit = data.skus[r.sku];
    if (!hit || !hit.found) {
      r._issues.push({
        code: 'E21', sev: 'stop', field: 'sku',
        msg: 'No product in Shopify has this SKU.'
      });
    } else if (hit.tracked && hit.available < +r.qty) {
      r._issues.push({
        code: 'W03', sev: 'warn', field: 'sku',
        msg: `${hit.title} shows ${hit.available} on hand. This row asks for ${r.qty}.`
      });
    }

    if (data.screening.mode === 'allowlist' && data.screening.blocked.includes(r.state)) {
      r._issues.push({
        code: 'E20', sev: 'stop', field: 'state',
        msg: `We are not set up to ship alcohol to ${r.state}.`
      });
    }
  });
}

/* --- Derived counts ----------------------------------------------------- */

const rowStatus = r =>
  r._issues.some(i => i.sev === 'stop') ? 'stop' :
  r._issues.length ? 'warn' : 'ok';

function orderCount() {
  const groups = new Set();
  let loose = 0;
  rows.forEach(r => r.recipient_id ? groups.add(r.recipient_id) : loose++);
  return groups.size + loose;
}

/* --- Render ------------------------------------------------------------- */

function render() {
  const stops = rows.filter(r => rowStatus(r) === 'stop').length;
  const warns = rows.filter(r => rowStatus(r) === 'warn').length;
  const units = rows.reduce((n, r) => n + (Number.isInteger(+r.qty) ? +r.qty : 0), 0);

  $('cRows').textContent   = rows.length;
  $('cOrders').textContent = orderCount();
  $('cStop').textContent   = stops;
  $('cWarn').textContent   = warns;
  $('cUnits').textContent  = units;

  renderHead();
  renderBody();
  renderLedger();

  const ready = stops === 0 && rows.length > 0 && serverStatus === 'ok';
  $('createOrders').disabled = !ready;
  setStep(stops ? 3 : (ready ? 4 : 3));
}

function renderHead() {
  const tr = $('gridHead');
  if (tr.children.length) return;
  tr.innerHTML = '<th class="rail">Status</th>' +
    COLUMNS.map(c => `<th>${c.label}</th>`).join('');
}

function renderBody() {
  const body = $('gridBody');
  body.innerHTML = '';
  const frag = document.createDocumentFragment();

  rows.forEach((r, idx) => {
    const status = rowStatus(r);
    const tr = document.createElement('tr');
    tr.dataset.status = status;
    tr.hidden = (filter === 'stop' && status !== 'stop') ||
                (filter === 'warn' && status !== 'warn');

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
      if (issue) {
        input.dataset.flag = 'bad';
        input.title = `${issue.code} — ${issue.msg}`;
      }
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
    const k = i.code;
    if (!tally.has(k)) tally.set(k, { code: i.code, sev: i.sev, msg: i.msg, rows: [] });
    tally.get(k).rows.push(r._n);
  }));

  const list = [...tally.values()].sort((a, b) =>
    a.sev === b.sev ? a.code.localeCompare(b.code) : (a.sev === 'stop' ? -1 : 1));

  const ul = $('ledger');
  ul.innerHTML = list.map(e => `
    <li class="ledger__item" data-sev="${e.sev}">
      <span class="ledger__code">${e.code}</span>
      <span>${e.msg}<br><span class="mono" style="color:var(--ink-faint);font-size:.6875rem">
        rows ${e.rows.slice(0, 12).join(', ')}${e.rows.length > 12 ? ` +${e.rows.length - 12} more` : ''}
      </span></span>
      <span class="ledger__count">${e.rows.length}</span>
    </li>`).join('');

  $('ledgerEmpty').hidden = list.length > 0;

  if (serverStatus === 'unavailable') {
    ul.insertAdjacentHTML('afterbegin', `
      <li class="ledger__item" data-sev="stop">
        <span class="ledger__code">API</span>
        <span>Could not reach Shopify, so SKUs, stock, and destination screening were not checked.
        Structural checks above still ran. Set the Admin API credentials before creating orders.</span>
        <span class="ledger__count">—</span>
      </li>`);
  }
}

function setStep(n) {
  [1, 2, 3, 4].forEach(i => {
    const el = $('step' + i);
    el.dataset.state = i < n ? 'done' : (i === n ? 'active' : '');
  });
}

/* --- Corrected export --------------------------------------------------- */

function exportFixed() {
  const csv = Papa.unparse({
    fields: COLUMNS.map(c => c.key),
    data: rows.map(r => COLUMNS.map(c => r[c.key]))
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${$('batchId').textContent}-corrected.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* --- Wiring ------------------------------------------------------------- */

function init() {
  const dz = $('dropzone');
  const fi = $('fileInput');

  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
  });
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.dataset.drag = 'true'; }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.dataset.drag = 'false'; }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) ingest(f);
  });
  fi.addEventListener('change', e => { if (e.target.files[0]) ingest(e.target.files[0]); });

  // Inline edits write straight back to the row model; re-check is explicit
  // so the grid does not reshuffle under the cursor mid-typing.
  $('gridBody').addEventListener('input', e => {
    const t = e.target;
    if (!t.classList.contains('cell')) return;
    const r = rows[+t.dataset.row];
    r[t.dataset.key] = t.value;
    if (t.dataset.key === 'state') r.state = normaliseState(t.value);
  });

  $('recheck').addEventListener('click', validate);
  $('exportFixed').addEventListener('click', exportFixed);
  $('startOver').addEventListener('click', () => location.reload());

  const chips = { all: $('fAll'), stop: $('fStop'), warn: $('fWarn') };
  Object.entries(chips).forEach(([name, btn]) => {
    btn.addEventListener('click', () => {
      filter = name;
      Object.entries(chips).forEach(([n, b]) =>
        b.setAttribute('aria-pressed', String(n === name)));
      renderBody();
    });
  });

  $('createOrders').addEventListener('click', () => {
    alert('Order creation is not built yet — this is the validator stage.\n\n' +
          'Next up: parent draft-order invoice for the batch total, then the ' +
          'child order loop.');
  });

  loadConfig();
}

document.addEventListener('DOMContentLoaded', init);
