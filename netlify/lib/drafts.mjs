/* ==========================================================================
   Saved orders (drafts) and usage tracking for the customer page.

   A draft is saved the moment a buyer gets a price (we ask for their email
   first). It holds everything they entered, so a private resume link puts
   them back where they were. It also mirrors to a Shopify draft order
   tagged corp-abandoned on the buyer's customer record, so staff can see
   and follow up on it in Shopify admin. When the buyer submits, the
   Shopify draft is deleted — the real invoice order replaces it — so any
   draft order still carrying that tag is an order that never got submitted.

   The Shopify draft is a follow-up record only. It is NOT how the order
   gets placed: it has no recipients, addresses, shipping or tax. Staff
   send the resume link, never Shopify's own "Send invoice" on the draft.
   ========================================================================== */

import { getStore } from '@netlify/blobs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { gql, env } from './shopify.mjs';
import { rules } from './common.mjs';
import { discountFor } from '../../shared/rules.mjs';

const now = () => new Date().toISOString();
const drafts = () => getStore({ name: 'corp-drafts', consistency: 'strong' });
const usage = () => getStore({ name: 'corp-usage', consistency: 'strong' });

export const DRAFT_ID_RE = /^D\d{8}-[A-Z0-9]{6}$/;
export const SID_RE = /^[A-Za-z0-9_-]{16,40}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ABANDONED_TAG = 'corp-abandoned';
const DRAFT_TAGS = [ABANDONED_TAG, 'corporate-order'];

export function newDraftId() {
  const stamp = now().slice(0, 10).replace(/-/g, '');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return `D${stamp}-${[...randomBytes(6)].map((b) => alphabet[b % 32]).join('')}`;
}

export const loadDraft = (id) => (DRAFT_ID_RE.test(id || '') ? drafts().get(`draft/${id}`, { type: 'json' }) : null);

export function draftTokenMatches(draft, token) {
  if (!draft || !draft.token || !token) return false;
  const a = Buffer.from(draft.token), b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function saveDraft(draft) {
  draft.updatedAt = now();
  await drafts().setJSON(`draft/${draft.id}`, draft);
  return draft;
}

const site = () => env('URL') || 'https://corporder.thebrobasket.com';
export const resumeLink = (d) => `${site()}/?d=${encodeURIComponent(d.id)}&t=${encodeURIComponent(d.token)}`;

export function createDraft(fields) {
  return { id: newDraftId(), token: randomBytes(24).toString('base64url'), createdAt: now(), status: 'open', ...fields };
}

/* --- Shopify draft order mirror -------------------------------------------- */

const DRAFT_CREATE = `
  mutation CorpDraftCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
  }`;
const DRAFT_UPDATE = `
  mutation CorpDraftUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) { draftOrder { id name } userErrors { field message } }
  }`;
const DRAFT_DELETE = `
  mutation CorpDraftDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) { deletedId userErrors { field message } }
  }`;

const usd = (c) => '$' + (c / 100).toFixed(2);

/* Products summed across recipients, checked against the catalog so only
   real corporate gifts ever reach Shopify. */
export function draftLines(summaryLines, catalog) {
  const by = new Map();
  for (const l of summaryLines || []) {
    const item = catalog.get(String(l.sku || ''));
    const qty = Math.floor(Number(l.qty));
    if (!item || !(qty > 0)) continue;
    by.set(item.variantId, (by.get(item.variantId) || 0) + Math.min(qty, 5000));
  }
  return [...by.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

function draftInput(d, lineItems) {
  const s = d.summary || {};
  const pct = Math.min(discountFor(s.recipients || 0, rules), rules.pricing.maxDiscountPct || 100);
  const parts = String(d.buyer.name || '').trim().split(/\s+/).filter(Boolean);
  const note = [
    'Corporate order started on the order page but NOT submitted.',
    `Resume link (send this to the buyer): ${resumeLink(d)}`,
    `Recipients: ${s.recipients || 0} · Gifts: ${s.units || 0}` +
      (s.totalCents ? ` · Quoted total incl. shipping & tax: ${usd(s.totalCents)}` : ''),
    d.buyer.company ? `Company: ${d.buyer.company}` : '',
    d.buyer.phone ? `Phone: ${d.buyer.phone}` : '',
    'Do not use "Send invoice" on this draft: it has no recipient addresses, shipping or tax. ' +
      'Send the resume link instead. This draft is deleted automatically when the buyer submits.'
  ].filter(Boolean).join('\n');
  const input = {
    email: d.buyer.email,
    tags: DRAFT_TAGS,
    note,
    lineItems,
    customAttributes: [
      { key: 'Corporate draft', value: d.id },
      { key: 'Recipients', value: String(s.recipients || 0) }
    ]
  };
  if (parts.length) {
    // Billing name only; it gives the draft a readable customer in admin.
    input.billingAddress = { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0], company: d.buyer.company || undefined, countryCode: 'US' };
  }
  if (pct > 0) input.appliedDiscount = { valueType: 'PERCENTAGE', value: pct, title: `${pct}% volume discount` };
  return input;
}

/* Create or update the Shopify draft. Never throws: a Shopify problem must
   not stop the buyer's own save. Skips the call if nothing it shows changed. */
export async function syncShopifyDraft(d, catalog) {
  const lineItems = draftLines(d.summary && d.summary.lines, catalog);
  if (!lineItems.length || !d.buyer.email) return d;
  const input = draftInput(d, lineItems);
  const sig = createHash('sha256').update(JSON.stringify({ ...input, note: input.note })).digest('hex').slice(0, 16);
  if (d.shopify && d.shopify.sig === sig) return d;
  try {
    if (d.shopify && d.shopify.id) {
      const out = await gql(DRAFT_UPDATE, { id: d.shopify.id, input });
      const r = out.draftOrderUpdate;
      if (r.userErrors.length) throw new Error(r.userErrors[0].message);
      d.shopify = { id: r.draftOrder.id, name: r.draftOrder.name, sig, at: now() };
    } else {
      const out = await gql(DRAFT_CREATE, { input });
      const r = out.draftOrderCreate;
      if (r.userErrors.length) throw new Error(r.userErrors[0].message);
      d.shopify = { id: r.draftOrder.id, name: r.draftOrder.name, sig, at: now() };
    }
    delete d.shopifyError;
  } catch (e) {
    d.shopifyError = e.message;
  }
  return d;
}

export async function removeShopifyDraft(d) {
  if (!d || !d.shopify || !d.shopify.id) return;
  try {
    const out = await gql(DRAFT_DELETE, { input: { id: d.shopify.id } });
    if (out.draftOrderDelete.userErrors.length) throw new Error(out.draftOrderDelete.userErrors[0].message);
    d.shopify.deletedAt = now();
  } catch (e) {
    d.shopifyError = `Could not delete draft: ${e.message}`;
  }
}

export function shopifyAdminDraftUrl(gid) {
  const num = String(gid || '').split('/').pop();
  const handle = String(env('SHOPIFY_SHOP') || '').replace('.myshopify.com', '');
  return num && handle ? `https://admin.shopify.com/store/${handle}/draft_orders/${num}` : null;
}

export async function listDrafts(sinceIso) {
  const { blobs } = await drafts().list({ prefix: 'draft/' });
  const all = await Promise.all(blobs.map((b) => drafts().get(b.key, { type: 'json' })));
  return all.filter((d) => d && (!sinceIso || (d.updatedAt || d.createdAt) >= sinceIso));
}

/* --- Usage tracking ------------------------------------------------------------
   First-party only: no cookies, no third-party scripts. The page keeps a
   random session id in localStorage and reports which steps it reached.
   Sessions are stored by the day they started: s/<day>/<sid>.
   -------------------------------------------------------------------------------- */

export const EVENTS = ['visit', 'browse', 'upload', 'recipients', 'contact', 'priced', 'saved', 'resumed', 'submitted'];
const short = (v, n = 200) => String(v ?? '').slice(0, n);

export async function recordEvent({ sid, day, event, props = {}, device }) {
  const key = `s/${day}/${sid}`;
  const s = (await usage().get(key, { type: 'json' })) || { sid, day, firstAt: now(), events: {}, hits: 0 };
  const at = now();
  s.lastAt = at;
  s.hits += 1;
  if (!s.events[event]) s.events[event] = at;
  if (device && !s.device) s.device = device;
  if (event === 'visit') {
    if (!s.referrer && props.referrer) s.referrer = short(props.referrer);
    if (!s.landing && props.landing) s.landing = short(props.landing);
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) if (props[k] && !s[k]) s[k] = short(props[k], 80);
  }
  for (const k of ['email', 'name', 'company']) if (props[k]) s[k] = short(props[k], 120);
  if (props.recipients) s.recipients = Math.min(Number(props.recipients) || 0, 10000);
  if (props.totalCents) s.totalCents = Math.min(Number(props.totalCents) || 0, 1e10);
  if (props.draftId && DRAFT_ID_RE.test(props.draftId)) s.draftId = props.draftId;
  if (props.batchId && /^B\d{8}-[A-Z0-9]{4,8}$/.test(props.batchId)) s.batchId = props.batchId;
  await usage().setJSON(key, s);
  return s;
}

export async function listSessions(days) {
  const out = [];
  const today = new Date();
  const wanted = new Set();
  for (let i = 0; i < days; i++) wanted.add(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  const { blobs } = await usage().list({ prefix: 's/' });
  const keys = blobs.map((b) => b.key).filter((k) => wanted.has(k.split('/')[1]));
  for (let i = 0; i < keys.length; i += 50) {
    const part = await Promise.all(keys.slice(i, i + 50).map((k) => usage().get(k, { type: 'json' })));
    out.push(...part.filter(Boolean));
  }
  return out;
}
