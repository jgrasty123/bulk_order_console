/* ==========================================================================
   usage (staff, console key)
   GET ?days=30 — who used the customer page: the step funnel, every
   session (with buyer details once given), saved/abandoned orders with
   their resume links and Shopify drafts, and what became of submitted ones.
   ========================================================================== */

import { json, fail, denied, loadBatch } from '../lib/common.mjs';
import { listSessions, listDrafts, resumeLink, shopifyAdminDraftUrl } from '../lib/drafts.mjs';

const STEPS = ['visit', 'browse', 'recipients', 'contact', 'priced', 'submitted', 'paid'];
const PAID = new Set(['paid', 'releasing', 'released', 'partial', 'partially_released']);

export default async (req) => {
  const blocked = denied(req);
  if (blocked) return blocked;
  const days = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get('days') || '30', 10) || 30, 1), 180);
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [sessions, drafts] = await Promise.all([listSessions(days), listDrafts(since)]);

    // What happened to each submitted batch.
    const batchIds = new Set([...sessions.map((s) => s.batchId), ...drafts.map((d) => d.batchId)].filter(Boolean));
    const batches = {};
    await Promise.all([...batchIds].map(async (id) => {
      const b = await loadBatch(id);
      if (b) batches[id] = { status: b.status, total: b.totals && b.totals.total, paid: PAID.has(b.status) };
    }));

    const reached = (s, step) => step === 'paid' ? Boolean(s.batchId && batches[s.batchId] && batches[s.batchId].paid)
      : step === 'recipients' ? Boolean(s.events.recipients || s.events.upload)
      : step === 'visit' ? true : Boolean(s.events[step]);
    const funnel = STEPS.map((step) => ({ step, sessions: sessions.filter((s) => reached(s, step)).length }));

    const furthest = (s) => [...STEPS].reverse().find((st) => reached(s, st)) || 'visit';
    const rows = sessions
      .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
      .slice(0, 500)
      .map((s) => ({
        sid: s.sid, firstAt: s.firstAt, lastAt: s.lastAt, device: s.device || '',
        furthest: furthest(s), name: s.name || '', company: s.company || '', email: s.email || '',
        recipients: s.recipients || 0, totalCents: s.totalCents || 0,
        source: s.utm_source || (s.referrer ? hostOf(s.referrer) : 'direct'),
        campaign: s.utm_campaign || '', draftId: s.draftId || '', batchId: s.batchId || '',
        batchStatus: s.batchId && batches[s.batchId] ? batches[s.batchId].status : ''
      }));

    const draftRows = drafts
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .map((d) => ({
        id: d.id, status: d.status, updatedAt: d.updatedAt, createdAt: d.createdAt,
        buyer: d.buyer, recipients: (d.summary && d.summary.recipients) || 0,
        totalCents: (d.summary && d.summary.totalCents) || 0,
        resumeUrl: d.status === 'open' ? resumeLink(d) : null,
        shopifyDraft: d.shopify && !d.shopify.deletedAt ? { name: d.shopify.name, url: shopifyAdminDraftUrl(d.shopify.id) } : null,
        shopifyError: d.shopifyError || null,
        batchId: d.batchId || null,
        batchStatus: d.batchId && batches[d.batchId] ? batches[d.batchId].status : null
      }));

    const known = new Set(rows.filter((r) => r.email).map((r) => r.email));
    return json(200, {
      days, funnel,
      totals: { sessions: sessions.length, identifiedBuyers: known.size, openDrafts: draftRows.filter((d) => d.status === 'open').length },
      sessions: rows, drafts: draftRows
    });
  } catch (err) {
    return fail(err);
  }
};

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'other'; } }
