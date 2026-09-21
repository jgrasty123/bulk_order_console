/* ==========================================================================
   Shared validation rules — used by the customer page, the staff console,
   and the server. On the public page the browser checks are for the
   customer's convenience; the server runs the same rules again before
   anything is priced or created, because the browser can't be trusted.
   ========================================================================== */

export const STATES = {
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
  VIRGINIA:'VA', WASHINGTON:'WA', 'WEST VIRGINIA':'WV', WISCONSIN:'WI', WYOMING:'WY'
};
export const STATE_CODES = new Set(Object.values(STATES));

const PO_BOX   = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box)\b/i;
const MILITARY = /\b(apo|fpo|dpo)\b/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
export const digits = (s) => (s || '').replace(/\D/g, '');

export function normaliseState(v) {
  const s = clean(v).toUpperCase();
  return STATE_CODES.has(s) ? s : (STATES[s] || s);
}

export function isUsableDate(v, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
  const d = new Date(v + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const t = new Date(today); t.setHours(0, 0, 0, 0);
  return d >= t;
}

/* One recipient (an order), checked field by field. Returns plain-English
   issues; `field` lets the page highlight the right cell. */
export function checkRecipient(r, cfg) {
  const out = [];
  const add = (code, sev, field, msg) => out.push({ code, sev, field, msg });
  const lim = cfg.limits, car = cfg.carrier;

  if (!r.firstName) add('E10', 'stop', 'firstName', 'First name is missing.');
  if (!r.lastName) add('E11', 'stop', 'lastName', 'Last name is missing.');
  if (!r.address1) add('E12', 'stop', 'address1', 'Street address is missing.');
  if (!r.city) add('E13', 'stop', 'city', 'City is missing.');
  if (!STATE_CODES.has(r.state)) add('E14', 'stop', 'state', 'State must be a US state, like CA or California.');
  if (!/^\d{5}(-\d{4})?$/.test(r.zip || '')) add('E15', 'stop', 'zip', 'ZIP code must be 5 digits.');
  const addr = `${r.address1 || ''} ${r.address2 || ''}`;
  if (car.blockPoBoxes && PO_BOX.test(addr)) add('E19', 'stop', 'address1', 'We can’t deliver to a PO box. Please use a street address.');
  if (car.blockMilitaryAddresses && MILITARY.test(`${addr} ${r.city || ''}`)) add('E24', 'stop', 'address1', 'We can’t ship to APO, FPO or DPO addresses.');
  if ((r.giftMessage || '').length > lim.maxGiftMessageChars) add('E30', 'stop', 'giftMessage', `Gift message is over ${lim.maxGiftMessageChars} characters.`);
  if (r.deliveryDate && !isUsableDate(r.deliveryDate)) add('E18', 'stop', 'deliveryDate', 'Delivery date must be today or later.');
  if (r.email && !EMAIL_RE.test(r.email)) add('W02', 'warn', 'email', 'This email doesn’t look right.');
  if (digits(r.phone).length < 10) add('W06', 'warn', 'phone', 'Add a phone number — the carrier may call about the signature delivery.');

  if (!r.lines || !r.lines.length) add('E16', 'stop', 'lines', 'Choose a gift.');
  for (const l of r.lines || []) {
    if (!l.sku) add('E16', 'stop', 'lines', 'Choose a gift.');
    if (!Number.isInteger(+l.qty) || +l.qty < 1 || +l.qty > lim.maxQtyPerLine) {
      add('E17', 'stop', 'lines', `Quantity must be between 1 and ${lim.maxQtyPerLine}.`);
    }
  }
  return out;
}

export const addressKey = (r) =>
  [r.firstName, r.lastName, r.address1, r.address2, r.city, r.state, r.zip]
    .map((v) => clean(v).toLowerCase()).join('|');

/* Customer rows → orders. The same person at the same address with several
   gifts becomes one order; the same gift twice becomes one line. */
export function groupRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const r = {
      firstName: clean(row.firstName), lastName: clean(row.lastName), company: clean(row.company),
      address1: clean(row.address1), address2: clean(row.address2), city: clean(row.city),
      state: normaliseState(row.state), zip: clean(row.zip).replace(/\s/g, ''),
      phone: clean(row.phone), email: clean(row.email),
      giftMessage: clean(row.giftMessage), deliveryDate: clean(row.deliveryDate)
    };
    const key = addressKey(r);
    if (!map.has(key)) map.set(key, { ...r, key, rows: [], lines: [] });
    const g = map.get(key);
    g.rows.push(row.rowNumber);
    if (!g.giftMessage && r.giftMessage) g.giftMessage = r.giftMessage;
    if (!g.phone && r.phone) g.phone = r.phone;
    if (!g.email && r.email) g.email = r.email;
    const sku = clean(row.sku);
    const qty = Number(row.qty);
    const line = g.lines.find((l) => l.sku === sku);
    if (line) line.qty += qty; else g.lines.push({ sku, qty });
  }
  return [...map.values()];
}

/* Merge fields in the gift message: {first_name}, {last_name}, {company}. */
export function mergeMessage(template, r) {
  return (template || '')
    .replace(/\{\s*first_name\s*\}/gi, r.firstName || '')
    .replace(/\{\s*last_name\s*\}/gi, r.lastName || '')
    .replace(/\{\s*company\s*\}/gi, r.company || '')
    .trim();
}

export function discountFor(recipientCount, cfg) {
  let pct = 0;
  for (const tier of cfg.pricing.volumeDiscounts || []) {
    if (recipientCount >= tier.minRecipients) pct = Math.max(pct, tier.percent);
  }
  return pct;
}

export function isAdult(dob, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const birth = new Date(Date.UTC(y, mo - 1, d));
  if (birth.getUTCFullYear() !== y || birth.getUTCMonth() !== mo - 1 || birth.getUTCDate() !== d) return false;
  const t = today;
  let age = t.getFullYear() - y;
  if (t.getMonth() + 1 < mo || (t.getMonth() + 1 === mo && t.getDate() < d)) age--;
  return age >= 21 && age < 120;
}
