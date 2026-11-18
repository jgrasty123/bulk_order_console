/* ==========================================================================
   track (public)
   First-party usage events from the customer page. No cookies, no
   third-party scripts: a random session id from the page plus which step
   it reached. Read back in the staff console (usage function).
   ========================================================================== */

import { json } from '../lib/common.mjs';
import { rateLimited } from '../lib/guard.mjs';
import { recordEvent, EVENTS, SID_RE, DAY_RE } from '../lib/drafts.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const limited = await rateLimited(req, 'track', 600);
  if (limited) return limited;
  let body;
  try { body = JSON.parse((await req.text()).slice(0, 20000)); } catch { return json(400, { error: 'bad_json' }); }
  const { sid, day, event, props } = body || {};
  if (!SID_RE.test(sid || '') || !DAY_RE.test(day || '') || !EVENTS.includes(event)) return json(400, { error: 'invalid' });
  // A session's day must be recent; stops a page from writing anywhere in the log.
  const age = Date.now() - Date.parse(day + 'T00:00:00Z');
  if (!(age > -2 * 86400000 && age < 3 * 86400000)) return json(400, { error: 'day' });
  const ua = req.headers.get('user-agent') || '';
  const device = /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  await recordEvent({ sid, day, event, props: props && typeof props === 'object' ? props : {}, device });
  return json(200, { ok: true });
};
