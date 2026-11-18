/* ==========================================================================
   order-draft (public)
   POST — save the buyer's order in progress. First save creates the draft
          and returns its id + private token; later saves need both.
          With a summary (sent after pricing) it also mirrors to a Shopify
          draft order tagged corp-abandoned, for staff follow-up.
   GET  ?d=<id>&t=<token> — load a saved order (the resume link).
   ========================================================================== */

import { json, rules } from '../lib/common.mjs';
import { loadCatalog } from '../lib/pricing.mjs';
import { rateLimited } from '../lib/guard.mjs';
import {
  loadDraft, draftTokenMatches, saveDraft, createDraft, syncShopifyDraft, resumeLink, SID_RE
} from '../lib/drafts.mjs';
import { clean, EMAIL_RE } from '../../shared/rules.mjs';

const MAX_BYTES = 600_000;
const notFound = () => json(404, { error: 'not_found', message: 'We couldn’t find that saved order. Check the link in your email.' });

export default async (req) => {
  if (req.method === 'GET') {
    const limited = await rateLimited(req, 'draft-get', 120);
    if (limited) return limited;
    const url = new URL(req.url);
    const d = await loadDraft(url.searchParams.get('d') || '');
    if (!draftTokenMatches(d, url.searchParams.get('t'))) return notFound();
    return json(200, { id: d.id, status: d.status, batchId: d.batchId || null, buyer: d.buyer, state: d.state, updatedAt: d.updatedAt });
  }
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const limited = await rateLimited(req, 'draft', 240);
  if (limited) return limited;

  const text = await req.text();
  if (text.length > MAX_BYTES) return json(413, { error: 'too_big', message: 'This order is too large to save.' });
  let body;
  try { body = JSON.parse(text); } catch { return json(400, { error: 'bad_json' }); }

  const buyer = {
    name: clean(body.buyer && body.buyer.name).slice(0, 120),
    company: clean(body.buyer && body.buyer.company).slice(0, 120),
    email: clean(body.buyer && body.buyer.email).toLowerCase().slice(0, 200),
    phone: clean(body.buyer && body.buyer.phone).slice(0, 40),
    poNumber: clean(body.buyer && body.buyer.poNumber).slice(0, 60)
  };
  if (!EMAIL_RE.test(buyer.email)) return json(400, { error: 'email', message: 'Please enter a valid email.' });
  const state = body.state && typeof body.state === 'object' ? body.state : null;
  if (!state) return json(400, { error: 'state' });

  let d = null;
  if (body.draftId) {
    d = await loadDraft(body.draftId);
    if (!draftTokenMatches(d, body.token)) d = null;      // unknown or wrong token: start a fresh draft
    else if (d.status !== 'open') d = null;               // already submitted: a new order is a new draft
  }
  if (!d) d = createDraft({ buyer, sessionId: SID_RE.test(body.sessionId || '') ? body.sessionId : null });

  d.buyer = buyer;
  d.state = state;
  if (body.summary && typeof body.summary === 'object') {
    const s = body.summary;
    d.summary = {
      recipients: Math.max(0, Math.min(Number(s.recipients) || 0, rules.limits.maxRowsPerBatch)),
      units: Math.max(0, Number(s.units) || 0),
      totalCents: Math.max(0, Math.round(Number(s.totalCents) || 0)),
      lines: Array.isArray(s.lines) ? s.lines.slice(0, 500).map((l) => ({ sku: clean(l.sku), qty: Number(l.qty) })) : [],
      pricedAt: new Date().toISOString()
    };
    try {
      const catalog = new Map((await loadCatalog()).map((i) => [i.sku, i]));
      await syncShopifyDraft(d, catalog);
    } catch (e) {
      d.shopifyError = e.message;
    }
  }
  await saveDraft(d);
  return json(200, { draftId: d.id, token: d.token, resumeUrl: resumeLink(d) });
};
