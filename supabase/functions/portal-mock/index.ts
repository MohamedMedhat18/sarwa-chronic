// MOCK of the portal's ORDS endpoints for "Chronic Attach" - TEST requests only.
// It behaves like the contract IT is asked to build (docs/PORTAL-INTEGRATION.md): OAuth2 client credentials, list of changed
// requests, one request with attachments + timeline, attachment download, and the decision endpoint (idempotent, 409 on a
// stale request, the portal's own "Reply" result). Used by the "portal" function while Settings > Portal is in mock mode.
// /_test/* endpoints (portal token only) seed requests, simulate the member / portal staff, inject failures and act as an agent.
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const STATUS: Record<number, string> = { 1: 'Assigned', 2: 'Processing', 3: 'Pending', 4: 'Closed', 5: 'Approved', 6: 'Partially_Approved_Pending', 7: 'Partially_Approved_Rejected', 8: 'Rejected', 9: 'Reopened' };
const DECIDE: Record<string, number | null> = { APPROVE: 5, PARTIAL: 7, REJECT: 8, PENDING_DOCS: 3, MESSAGE: null };
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
async function sha256(s: string) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function secret(name: string) { const { data } = await db.from('app_secrets').select('value').eq('name', name).maybeSingle(); try { return data ? JSON.parse(data.value) : null; } catch { return null; } }
async function getReq(id: string) { const { data } = await db.from('portal_mock_requests').select('data').eq('request_id', id).maybeSingle(); return data?.data || null; }
async function putReq(d: any) { d.last_update = new Date().toISOString(); await db.from('portal_mock_requests').upsert({ request_id: String(d.request_id), data: d, updated_at: d.last_update }); return d; }
const ev = (ts: string) => ts.replace(/\D/g, '').slice(0, 17) + '_' + rand(6);

async function record(method: string, path: string, http: number, body: unknown) { await db.from('portal_mock_calls').insert({ method, path, http, body }).then(() => {}, () => {}); }
async function fault(path: string) {
  const { data } = await db.from('portal_mock_faults').select('*').gt('remaining', 0).order('id');
  for (const f of data || []) {
    const re = new RegExp('^' + String(f.path_like).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$');
    if (re.test(path)) { await db.from('portal_mock_faults').update({ remaining: f.remaining - 1 }).eq('id', f.id); return f.http as number; }
  }
  return 0;
}

Deno.serve(async (req) => {
  const u = new URL(req.url); const path = u.pathname.replace(/^.*?\/portal-mock/, '') || '/';
  const method = req.method;
  try {
    // ---------- test helpers (portal token) ----------
    if (path.startsWith('/_test/')) {
      const tok = req.headers.get('x-portal-token') || ''; const s = await secret('portal_token');
      if (!tok || !s || s.hash !== await sha256(tok)) return json({ error: 'portal token required' }, 401);
      const cfg = await secret('portal'); if (!cfg || !['mock', 'browser'].includes(cfg.mode)) return json({ error: 'only in mock / browser (test) mode' }, 400);
      const b = await req.json().catch(() => ({}));
      switch (path) {
        case '/_test/seed': {
          const out = [];
          for (const r of b.requests || []) {
            const files = r.files || []; delete r.files;
            r.attachments = files.map((f: any) => ({ id: String(f.id), file_name: f.file_name, mime_type: f.mime_type, size: Math.floor(String(f.content_b64 || '').length * 3 / 4), source: f.source || 'WhatsApp', uploaded_at: new Date().toISOString() }));
            r.timeline = r.timeline || [{ id: 'tl-' + r.request_id + '-1', status_code: r.status_code, status_name: STATUS[r.status_code], comment: r.notes || '', by: r.creation_user || r.mobile || '', actor_type: 'requester', source: r.channel || 'WhatsApp', at: r.creation_date || new Date().toISOString() }];
            r.status_name = STATUS[r.status_code];
            for (const f of files) await db.from('portal_mock_files').upsert({ id: String(f.id), request_id: String(r.request_id), file_name: f.file_name, mime_type: f.mime_type, content_b64: f.content_b64 });
            out.push((await putReq(r)).request_id);
          }
          return json({ ok: true, seeded: out });
        }
        case '/_test/reply': {   // the member answers on WhatsApp / the broker by email: new file + message, the portal reopens it
          const r = await getReq(String(b.request_id)); if (!r) return json({ error: 'unknown request' }, 404);
          const at = new Date().toISOString();
          if (b.file) { const id = 'f-' + rand(6); await db.from('portal_mock_files').insert({ id, request_id: String(r.request_id), file_name: b.file.file_name, mime_type: b.file.mime_type, content_b64: b.file.content_b64 }); r.attachments.push({ id, file_name: b.file.file_name, mime_type: b.file.mime_type, size: 100, source: r.channel || 'WhatsApp', uploaded_at: at }); }
          r.timeline.push({ id: 'tl-' + rand(6), status_code: 9, status_name: 'Reopened', comment: b.comment || '', by: r.broker_mail || r.creation_user || '', actor_type: 'requester', source: r.broker_mail ? 'broker' : 'whatsapp', at });
          if (b.reopen !== false) { r.status_code = 9; r.status_name = STATUS[9]; }
          return json({ ok: true, request: await putReq(r) });
        }
        case '/_test/direct': {  // portal staff decide directly in the portal (not through the helpdesk)
          const r = await getReq(String(b.request_id)); if (!r) return json({ error: 'unknown request' }, 404);
          r.status_code = +b.status_code; r.status_name = STATUS[r.status_code];
          r.timeline.push({ id: 'tl-' + rand(6), status_code: r.status_code, status_name: r.status_name, comment: b.comment || 'Replied in the portal', by: b.by || 'portal.user', actor_type: 'staff', source: 'portal', at: new Date().toISOString() });
          return json({ ok: true, request: await putReq(r) });
        }
        case '/_test/fault': { const { error } = await db.from('portal_mock_faults').insert({ path_like: b.path_like, http: +b.http, remaining: +b.remaining || 1 }); return json({ ok: !error, error: error?.message }); }
        case '/_test/decide': {  // exactly what the app does when an agent sends a decision on a portal ticket
          const { data: link } = await db.from('portal_links').select('request_id').eq('ticket', String(b.ticket)).maybeSingle();
          if (!link) return json({ error: 'ticket not linked' }, 404);
          const id = 'pd_' + Date.now().toString(36) + rand(4); const paths: string[] = [], names: string[] = [];
          for (const f of b.files || []) { const p = `hd/portal/${id}/${f.name}`; const bytes = Uint8Array.from(atob(f.content_b64), (ch) => ch.charCodeAt(0)); await db.storage.from('chronic').upload(p, bytes, { contentType: f.mime, upsert: true }); paths.push(p); names.push(f.name); }
          const job = { decision: b.decision, text: b.text || '', html: b.text ? '<p>' + b.text + '</p>' : '', reason: b.reason || '', missing: b.missing || [], agent: b.agent || 'Test Agent', agentEmail: 'test.agent@example.invalid', attachments: paths, attachmentNames: names, ticketUpdate: b.ticketUpdate || {} };
          const { error } = await db.from('portal_outbox').insert({ id, ticket: b.ticket, request_id: link.request_id, job, status: 'queued' });
          if (error) return json({ error: error.message }, 409);
          const ts = new Date().toISOString();
          await db.from('events').insert({ id: ev(ts), ts, actor: job.agent, pc: 'portal-test', type: 'portal.queued', t: b.ticket, d: { jobId: id, decision: b.decision, reason: job.reason, text: job.text, html: job.html, atts: paths.map((p, i) => ({ name: names[i], path: p, cls: 'readable' })), channel: '', to: '' } });
          return json({ ok: true, id });
        }
        case '/_test/state': {
          const r = b.request_id ? await getReq(String(b.request_id)) : null;
          const { data: link } = b.request_id ? await db.from('portal_links').select('*').eq('request_id', String(b.request_id)).maybeSingle() : { data: null };
          const t = b.ticket || link?.ticket;
          const { data: evs } = t ? await db.from('events').select('ts,actor,type,d').eq('t', t).order('ts') : { data: [] };
          const { data: jobs } = t ? await db.from('portal_outbox').select('id,status,attempts,http_code,error,next_try_at').eq('ticket', t).order('created_at') : { data: [] };
          const { data: mail } = t ? await db.from('outbox').select('id,status,subject:job->>subject,to:job->>to').eq('ticket', t) : { data: [] };
          return json({ ok: true, request: r, link, events: evs, jobs, alerts: mail });
        }
        case '/_test/calls': { const { data } = await db.from('portal_mock_calls').select('*').order('id', { ascending: false }).limit(+b.limit || 50); return json({ ok: true, calls: data }); }
      }
      return json({ error: 'unknown test action' }, 400);
    }

    // ---------- OAuth2 client credentials ----------
    if (path === '/oauth/token' && method === 'POST') {
      const m = await secret('portal_mock') || {};
      const [id, sec] = atob((req.headers.get('authorization') || '').replace(/^Basic\s+/i, '') || 'Og==').split(':');
      if (!m.clientId || id !== m.clientId || sec !== m.clientSecret) { await record(method, path, 401, null); return json({ error: 'invalid_client' }, 401); }
      const v = 'mk_' + rand(32); await db.from('portal_state').upsert({ key: 'mock_token', value: { v, exp: Date.now() + 3600e3 } });
      return json({ access_token: v, token_type: 'bearer', expires_in: 3600 });
    }
    const { data: st } = await db.from('portal_state').select('value').eq('key', 'mock_token').maybeSingle();
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!st || st.value.v !== bearer || Date.now() > st.value.exp) { await record(method, path, 401, null); return json({ error: 'invalid_token' }, 401); }
    const f = await fault(path); if (f) { await record(method, path, f, null); return json({ error: 'injected fault ' + f }, f); }

    // ---------- GET /requests?changed_since=&limit=&offset= ----------
    if (path === '/requests' && method === 'GET') {
      const since = u.searchParams.get('changed_since') || '1970-01-01T00:00:00Z'; const limit = Math.min(100, +(u.searchParams.get('limit') || 50)); const offset = +(u.searchParams.get('offset') || 0);
      const { data } = await db.from('portal_mock_requests').select('request_id,data,updated_at').gt('updated_at', since).order('updated_at').range(offset, offset + limit);
      const rows = (data || []).slice(0, limit);
      await record(method, path + u.search, 200, null);
      return json({ items: rows.map((r: any) => ({ request_id: r.request_id, status_code: r.data.status_code, status_name: r.data.status_name, last_update: r.data.last_update })), hasMore: (data || []).length > limit, limit, offset, count: rows.length });
    }
    const m1 = path.match(/^\/requests\/([^/]+)$/), m2 = path.match(/^\/requests\/([^/]+)\/attachments\/([^/]+)$/), m3 = path.match(/^\/requests\/([^/]+)\/decision$/);
    if (m1 && method === 'GET') { const r = await getReq(decodeURIComponent(m1[1])); await record(method, path, r ? 200 : 404, null); return r ? json(r) : json({ error: 'not found' }, 404); }
    if (m2 && method === 'GET') {
      const { data } = await db.from('portal_mock_files').select('*').eq('id', decodeURIComponent(m2[2])).eq('request_id', decodeURIComponent(m2[1])).maybeSingle();
      await record(method, path, data ? 200 : 404, null);
      if (!data) return json({ error: 'not found' }, 404);
      return new Response(Uint8Array.from(atob(data.content_b64), (c) => c.charCodeAt(0)), { headers: { 'Content-Type': data.mime_type, 'Content-Disposition': `attachment; filename="${data.file_name}"` } });
    }
    // ---------- POST /requests/{id}/decision  (Idempotency-Key header) ----------
    if (m3 && method === 'POST') {
      const id = decodeURIComponent(m3[1]); const key = req.headers.get('idempotency-key') || '';
      const b = await req.json().catch(() => ({}));
      const logged = { ...b, attachments: (b.attachments || []).map((a: any) => ({ file_name: a.file_name, mime_type: a.mime_type, bytes: Math.floor(String(a.content_base64 || '').length * 3 / 4) })) };
      if (!key) { await record(method, path, 400, logged); return json({ error: 'Idempotency-Key header required' }, 400); }
      const { data: seen } = await db.from('portal_state').select('value').eq('key', 'mock_idem:' + key).maybeSingle();
      if (seen) { await record(method, path, 200, { replay: key }); return json(seen.value); }
      const r = await getReq(id); if (!r) { await record(method, path, 404, logged); return json({ error: 'not found' }, 404); }
      if (!(b.decision in DECIDE)) { await record(method, path, 422, logged); return json({ error: 'unknown decision' }, 422); }
      if (b.decision === 'REJECT' && !String(b.reason || '').trim()) { await record(method, path, 422, logged); return json({ error: 'reason is required for REJECT' }, 422); }
      if (b.decision === 'PENDING_DOCS' && !(b.missing_documents || []).length && !String(b.message || '').trim()) { await record(method, path, 422, logged); return json({ error: 'missing_documents or message required' }, 422); }
      if (FINAL(r.status_code) && b.decision !== 'MESSAGE') { await record(method, path, 409, logged); return json({ error: 'conflict', message: 'request already ' + r.status_name, current_status: r.status_code, last_update: r.last_update }, 409); }
      if (b.base_last_update && Date.parse(b.base_last_update) < Date.parse(r.last_update) - 1000) { await record(method, path, 409, logged); return json({ error: 'conflict', message: 'request changed since ' + b.base_last_update, current_status: r.status_code, last_update: r.last_update }, 409); }
      const at = new Date().toISOString(); const tl = 'tl-' + rand(6);
      if (DECIDE[b.decision] != null) { r.status_code = DECIDE[b.decision]; r.status_name = STATUS[r.status_code]; }
      for (const a of b.attachments || []) { const fid = 'sf-' + rand(6); await db.from('portal_mock_files').insert({ id: fid, request_id: id, file_name: a.file_name, mime_type: a.mime_type, content_b64: a.content_base64 }); r.attachments.push({ id: fid, file_name: a.file_name, mime_type: a.mime_type, size: 0, source: 'Sarwa', uploaded_at: at }); }
      r.timeline.push({ id: tl, status_code: r.status_code, status_name: r.status_name, comment: b.message || '', extra_comment: [b.reason, ...(b.missing_documents || [])].filter(Boolean).join(' | '), by: 'sarwa-chronic (' + (b.agent_email || b.agent_name || '') + ')', actor_type: 'integration', source: 'integration', at });
      await putReq(r);
      const res = { request_id: id, status_code: r.status_code, status_name: r.status_name, timeline_id: tl, last_update: r.last_update,
        delivered: r.broker_mail ? { channel: 'email', to: r.broker_mail, cc: r.cc || [] } : { channel: 'whatsapp', to: r.mobile || r.creation_user } };
      await db.from('portal_state').upsert({ key: 'mock_idem:' + key, value: res });
      await record(method, path, 200, logged);
      return json(res);
    }
    await record(method, path, 404, null);
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
function FINAL(c: number) { return [4, 5, 7, 8].includes(+c); }
