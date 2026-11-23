// Sarwa portal (Oracle APEX "Chronic Attach", Medical Claims app 2009 / page 165) <-> Sarwa Chronic helpdesk.
//
// IN : every request on the portal becomes ONE ticket (key = portal request id, table portal_links). Later changes on the
//      portal (new files, the member answered on WhatsApp, the request reopened, or someone decided directly in the portal)
//      are added to that ticket. A requester answer reopens a pending ticket with the "customer_response" tag (same rule as email).
// OUT: the agent's decision / message is queued in portal_outbox by the app and posted here to the portal's decision endpoint,
//      which runs the portal's own Reply logic (status, Request Timeline, WhatsApp / broker email). The ticket only changes
//      (Closed / Pending) after the portal confirmed - a ticket never shows "replied" while the portal is still open.
//
// The portal credentials (OAuth2 client credentials) stay on the server (app_secrets, readable by the service role only).
// Callers: signed-in team members (tick / push / retry / status), admins (settings, sync now), and a scheduler or test
// script with the portal token (x-portal-token; only its SHA-256 is stored).
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const db = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-portal-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const BUCKET = 'chronic';
const HD = 'hd';
const MAX_ATT = 20 * 1048576;          // per file
const MAX_POST_ATT = 15 * 1048576;     // all files of one decision together
const RETRY_MIN = [1, 3];              // minutes before attempt 2 and 3
const MAX_ATTEMPTS = 3;                // then "Sync failed" + admin alert (portal_claim_* also stop at 3)
const LEASE_MIN = 5;                   // a claimed job with no answer from the bridge for 5 min is taken back (lost connection)
const TIMEOUT_MIN = 15;                // a reply not confirmed by the portal within 15 min -> Failed with the reason + alert
const BRIDGE_MIN_VERSION = 6;          // older bridge / in-page agent copies may not claim replies any more
const TIMEOUT_CODE = 408;              // http_code of a job failed by the 15-min timeout (the bridge re-checks the Timeline for it)

// ---------- portal status codes (read from the page's Status Filter, P165_STATUS) ----------
const PORTAL_STATUS: Record<number, string> = { 1: 'Assigned', 2: 'Processing', 3: 'Pending', 4: 'Closed', 5: 'Approved', 6: 'Partially_Approved_Pending', 7: 'Partially_Approved_Rejected', 8: 'Rejected', 9: 'Reopened' };
const FINAL = new Set([4, 5, 7, 8]);
// helpdesk decision -> what is posted to the portal (decision code + the portal status it must end in)
export const DECISION_MAP: Record<string, { code: string; portalStatus: number | null }> = {
  'Approved': { code: 'APPROVE', portalStatus: 5 },
  'Partially approved': { code: 'PARTIAL', portalStatus: 7 },
  'Rejected': { code: 'REJECT', portalStatus: 8 },
  'Pending': { code: 'PENDING_DOCS', portalStatus: 3 },   // NOT closed: stays Pending with the missing-documents list sent
  'Message': { code: 'MESSAGE', portalStatus: null },     // a message / reminder only, the status does not change
};

// ---------- small helpers ----------
class HttpErr extends Error { constructor(public status: number, msg: string) { super(msg); } }
async function sha256(s: string) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
const safe = (s: string) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120);
const str = (v: unknown, n = 500) => String(v ?? '').slice(0, n);
let lastTs = 0;
// strictly increasing timestamps: events are folded in (ts, id) order, so a ticket.create must sort before its first message
function nowIso() { let t = Date.now(); if (t <= lastTs) t = lastTs + 1; lastTs = t; return new Date(t).toISOString(); }
const evId = (ts: string) => ts.replace(/\D/g, '').slice(0, 17) + '_' + rand(6);
const phoneLocal = (s: unknown) => { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('0020')) d = d.slice(4); if (d.startsWith('20') && d.length === 12) d = d.slice(2); if (d.length === 10 && d.startsWith('1')) d = '0' + d; return d; };
const EXT_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', heic: 'image/heic', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const mimeOf = (name: string, m?: string) => { const x = String(m || '').toLowerCase(); if (x && !/octet-stream|unknown|binary/.test(x)) return x; return EXT_MIME[String(name).toLowerCase().split('.').pop() || ''] || 'application/octet-stream'; };
const readable = (mime: string) => /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(mime);
function b64(bytes: Uint8Array) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 500);

async function insertEv(actor: string, type: string, t: string | null, d: Record<string, unknown>) {
  const ts = nowIso();
  const { error } = await db.from('events').insert({ id: evId(ts), ts, actor, pc: 'portal-sync', type, t, d });
  if (error) throw new Error('event ' + type + ': ' + error.message);
}
async function log(row: Record<string, unknown>) { await db.from('portal_sync_log').insert(row).then(() => {}, () => {}); }
async function getState(key: string) { const { data } = await db.from('portal_state').select('value').eq('key', key).maybeSingle(); return (data?.value || {}) as Record<string, any>; }
async function setState(key: string, value: unknown) { await db.from('portal_state').upsert({ key, value, updated_at: new Date().toISOString() }); }

// ---------- configuration (Settings > Portal; stored server-side) ----------
// mode: off | mock (built-in test portal) | live (ORDS HTTP, needs IT) | browser (local bridge PC drives the real portal UI, no IT)
type Cfg = { mode: 'off' | 'mock' | 'live' | 'browser'; dryRun: boolean; baseUrl: string; tokenUrl: string; clientId: string; clientSecret: string; intervalMin: number; since: string; group: string; alertTo: string; mailbox: string };
const serverReaches = (c: Cfg) => c.mode === 'mock' || c.mode === 'live';   // in browser mode the portal is reachable only from the bridge PC
async function readSecret(name: string) { const { data } = await db.from('app_secrets').select('value').eq('name', name).maybeSingle(); try { return data ? JSON.parse(data.value) : null; } catch { return null; } }
async function writeSecret(name: string, value: unknown, by?: string) { const { error } = await db.from('app_secrets').upsert({ name, value: JSON.stringify(value), updated_at: new Date().toISOString(), updated_by: by || null }); if (error) throw new Error(error.message); }
async function config(): Promise<Cfg> {
  const c = { mode: 'off', dryRun: true, baseUrl: '', tokenUrl: '', clientId: '', clientSecret: '', intervalMin: 5, since: '', group: '', alertTo: '', mailbox: 'Chronic@sarwa.life', ...(await readSecret('portal') || {}) } as Cfg;
  if (c.mode === 'mock') { const m = await readSecret('portal_mock') || {}; c.baseUrl = SB_URL + '/functions/v1/portal-mock'; c.tokenUrl = c.baseUrl + '/oauth/token'; c.clientId = m.clientId || ''; c.clientSecret = m.clientSecret || ''; }
  return c;
}

// ---------- portal API (ORDS, OAuth2 client credentials) ----------
let TOK = { v: '', exp: 0, key: '' };
async function token(c: Cfg) {
  const key = c.tokenUrl + '|' + c.clientId;
  if (TOK.v && TOK.key === key && Date.now() < TOK.exp - 60000) return TOK.v;
  const r = await fetch(c.tokenUrl, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(c.clientId + ':' + c.clientSecret) }, body: 'grant_type=client_credentials' });
  if (!r.ok) throw new HttpErr(r.status, 'portal sign-in failed (' + r.status + '): ' + (await r.text()).slice(0, 200));
  const j = await r.json(); TOK = { v: j.access_token, exp: Date.now() + (+j.expires_in || 3600) * 1000, key };
  return TOK.v;
}
async function api(c: Cfg, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  if (c.mode === 'off' || !c.baseUrl) throw new HttpErr(503, 'The portal connection is off (Settings > Portal)');
  const r = await fetch(c.baseUrl.replace(/\/$/, '') + path, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + await token(c), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) TOK.v = '';
  return r;
}
async function apiJson(c: Cfg, path: string) { const r = await api(c, 'GET', path); if (!r.ok) throw new HttpErr(r.status, 'GET ' + path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200)); return r.json(); }

// ---------- the portal request (contract in docs/PORTAL-INTEGRATION.md) ----------
type Att = { id: string | number; file_name?: string; mime_type?: string; size?: number; source?: string; uploaded_at?: string };
type Tl = { id: string | number; status_code?: number; status_name?: string; comment?: string; extra_comment?: string; by?: string; actor_type?: string; source?: string; at?: string };
type Req = {
  request_id: string | number; individual_number?: string; individual_name?: string; mobile?: string; channel?: string; contract_no?: string; policy_holder?: string; policy_holder_name?: string;
  broker?: string; broker_mail?: string; cc?: string[]; status_code: number; status_name?: string; chronic_date?: string; assign_to?: string; creation_user?: string; creation_date?: string; last_update?: string;
  request_type?: string; item_codes?: { code?: string; name?: string; dose?: string; quantity?: number }[]; starting_day?: number; notes?: string; attachments?: Att[]; timeline?: Tl[];
};
const statusName = (q: Req) => q.status_name || PORTAL_STATUS[q.status_code] || String(q.status_code);
const isOurs = (x: Tl) => x.actor_type === 'integration' || x.source === 'integration' || /^sarwa[- ]chronic/i.test(String(x.by || ''));
const isRequester = (q: Req, x: Tl) => x.actor_type === 'requester' || ['whatsapp', 'broker', 'member'].includes(String(x.source || '').toLowerCase()) ||
  (!!x.by && [q.creation_user, q.mobile, q.broker_mail].filter(Boolean).map((v) => String(v).toLowerCase()).includes(String(x.by).toLowerCase()));

function portalInfo(q: Req, hd: any) {
  const startDay = q.starting_day ?? hd?.start_day ?? null;
  return {
    requestId: String(q.request_id), channel: q.channel || '', mobile: phoneLocal(q.mobile || q.creation_user), individual: q.individual_number || '',
    policyHolder: q.policy_holder || q.policy_holder_name || '', contractNo: q.contract_no || '', broker: q.broker || '', brokerMail: q.broker_mail || '', cc: q.cc || [],
    statusCode: q.status_code, statusName: statusName(q), chronicDate: q.chronic_date || '', createdAt: q.creation_date || '', lastUpdate: q.last_update || '', assignTo: q.assign_to || '',
    requestType: q.request_type || '', items: (q.item_codes || []).slice(0, 60), startDay, startDaySrc: q.starting_day != null ? 'portal' : hd ? 'holder_days (' + hd.via + ')' : '',
    secondDay: hd?.second_day ?? null,
  };
}
function requestText(q: Req, p: ReturnType<typeof portalInfo>) {
  const L = [`Chronic Attach request No. ${q.request_id} - ${p.channel || 'portal'}`,
    `Member: ${q.individual_name || '-'} (${q.individual_number || '-'})${p.mobile ? ' - mobile ' + p.mobile : ''}`,
    `Policy holder: ${p.policyHolder || '-'}${p.contractNo ? ' - contract ' + p.contractNo : ''}${p.startDay != null ? ' - Starting Day ' + p.startDay : ''}`];
  if (p.broker || p.brokerMail) L.push(`Broker: ${p.broker || ''} ${p.brokerMail ? '<' + p.brokerMail + '>' : ''}`.trim());
  if ((q.item_codes || []).length) L.push('Items:', ...(q.item_codes || []).map((i) => `- ${i.code || ''} ${i.name || ''}${i.dose ? ' - ' + i.dose : ''}${i.quantity ? ' x ' + i.quantity : ''}`.trim()));
  if (q.notes) L.push('Notes: ' + q.notes);
  return L.join('\n');
}

async function copyAtts(c: Cfg, no: string, q: Req, list: Att[]) {
  const out = [];
  for (const a of list) {
    const r = await api(c, 'GET', `/requests/${encodeURIComponent(String(q.request_id))}/attachments/${encodeURIComponent(String(a.id))}`);
    if (!r.ok) throw new HttpErr(r.status, 'attachment ' + a.id + ' -> ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    const name = a.file_name || ('file-' + a.id); const mime = mimeOf(name, a.mime_type || r.headers.get('content-type') || '');
    if (buf.length > MAX_ATT) { out.push({ name, mime, size: buf.length, path: '', cls: 'unreadable', why: 'larger than 20 MB - open it in the portal', via: 'portal', portalId: String(a.id), source: a.source || '' }); continue; }
    const path = `${HD}/files/${no}/${rand(5)}_${safe(name)}`;
    const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: true });
    if (error) throw new Error('upload ' + name + ': ' + error.message);
    out.push({ name, mime, size: buf.length, path, cls: readable(mime) ? 'readable' : 'unreadable', why: readable(mime) ? '' : 'open it in the portal / Word', via: 'portal', portalId: String(a.id), source: a.source || '' });
  }
  return out;
}

// browser mode: the bridge PC already downloaded the file in the real browser and sends its bytes as base64
type InlineAtt = Att & { content_base64?: string };
async function saveInlineAtts(no: string, list: InlineAtt[]) {
  const out = [];
  for (const a of list) {
    const name = a.file_name || ('file-' + a.id); const mime = mimeOf(name, a.mime_type || '');
    if (!a.content_base64) { out.push({ name, mime, size: a.size || 0, path: '', cls: 'unreadable', why: 'not downloaded (too large / open it in the portal)', via: 'portal', portalId: String(a.id), source: a.source || '' }); continue; }
    const bytes = Uint8Array.from(atob(a.content_base64), (ch) => ch.charCodeAt(0));
    if (bytes.length > MAX_ATT) { out.push({ name, mime, size: bytes.length, path: '', cls: 'unreadable', why: 'larger than 20 MB - open it in the portal', via: 'portal', portalId: String(a.id), source: a.source || '' }); continue; }
    // one path per portal file id: a re-run overwrites the same object instead of storing the file twice
    const path = `${HD}/files/${no}/p_${safe(String(a.id))}_${safe(name)}`;
    const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
    if (error) throw new Error('upload ' + name + ': ' + error.message);
    out.push({ name, mime, size: bytes.length, path, cls: readable(mime) ? 'readable' : 'unreadable', why: readable(mime) ? '' : 'open it to view (Word / Excel download)', via: 'portal', portalId: String(a.id), source: a.source || '', ...((a as any).extra_comment ? { note: str((a as any).extra_comment, 300) } : {}) });
  }
  return out;
}
type AttFn = (no: string, list: InlineAtt[]) => Promise<any[]>;

// ---------- IN: portal -> tickets ----------
async function syncIn(c: Cfg, force = false) {
  const cur = await getState('cursor');
  if (!force && cur.lastRun && Date.now() - Date.parse(cur.lastRun) < Math.max(1, c.intervalMin) * 60000 - 20000) return { skipped: 'not due' };
  const { data: got } = await db.rpc('portal_try_lock', { p_key: 'lock:sync', p_secs: 240 });
  if (!got) return { skipped: 'another sync is running' };
  const startedAt = new Date().toISOString();
  const since = cur.since || c.since || new Date(Date.now() - 3 * 86400000).toISOString();
  const from = new Date(Date.parse(since) - 120000).toISOString();   // 2 minutes overlap - re-reads are cheap and idempotent
  const res = { seen: 0, created: 0, updated: 0, same: 0, skipped: 0, errors: [] as string[] };
  let maxTs = since;
  try {
    let offset = 0;
    for (let page = 0; page < 40; page++) {
      const j = await apiJson(c, `/requests?changed_since=${encodeURIComponent(from)}&limit=50&offset=${offset}`);
      const items: { request_id: string; last_update?: string; status_code?: number }[] = j.items || [];
      for (const s of items) {
        res.seen++;
        try {
          const r = await syncOne(c, String(s.request_id), s.last_update);
          (res as any)[r]++;
          if (s.last_update && s.last_update > maxTs) maxTs = s.last_update;
        } catch (e) {
          res.errors.push(s.request_id + ': ' + errMsg(e));
          await log({ direction: 'in', action: 'sync_request', request_id: String(s.request_id), ok: false, http_code: (e as HttpErr).status || null, error: errMsg(e) });
        }
      }
      if (!j.hasMore || !items.length) break;
      offset += items.length;
    }
    // the cursor only moves when everything up to it was taken in (a failed request is read again next time)
    await setState('cursor', { since: res.errors.length ? since : maxTs, lastRun: startedAt, lastOk: res.errors.length ? cur.lastOk || null : startedAt, lastError: res.errors[0] || null, last: res });
    if (res.created || res.updated || res.errors.length) await log({ direction: 'in', action: 'sync', ok: !res.errors.length, detail: res, error: res.errors[0] || null });
    return res;
  } catch (e) {
    await setState('cursor', { ...cur, lastRun: startedAt, lastError: errMsg(e) });
    await log({ direction: 'in', action: 'sync', ok: false, http_code: (e as HttpErr).status || null, error: errMsg(e) });
    throw e;
  } finally {
    await db.from('portal_state').update({ updated_at: new Date(Date.now() - 86400000).toISOString() }).eq('key', 'lock:sync');
  }
}

async function syncOne(c: Cfg, id: string, lastUpdate?: string): Promise<'created' | 'updated' | 'same' | 'skipped'> {
  const { data: link } = await db.from('portal_links').select('*').eq('request_id', id).maybeSingle();
  if (link && lastUpdate && link.portal_updated_at && Date.parse(link.portal_updated_at) >= Date.parse(lastUpdate)) return 'same';
  const q: Req = await apiJson(c, `/requests/${encodeURIComponent(id)}`);
  const hash = await reqHash(q);
  if (link && link.last_hash === hash) { await db.from('portal_links').update({ synced_at: new Date().toISOString() }).eq('request_id', id); return 'same'; }
  const attFn: AttFn = (no, list) => copyAtts(c, no, q, list);
  return link ? await updateTicket(c, q, link, hash, attFn) : await createTicket(c, q, hash, attFn);
}
const reqHash = (q: Req) => sha256(JSON.stringify([q.status_code, q.last_update || '', (q.attachments || []).map((a) => String(a.id)).sort(), (q.timeline || []).map((x) => String(x.id)).sort()]));

// ---------- one request = one ticket (duplicate rule, 23 Nov 2026) ----------
// Merged / linked automatically ONLY when it is certain: the same member card on both AND at least one byte-identical file
// (SHA-256) AND within 3 days. Anything less is only shown in the app as "Possible duplicate" for the team to confirm.
// A ticket answers ONE portal request: two different portal requests are never merged (each needs its own answer).
const DAY = 86400000;
const shaBytes = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
async function fileHash(path: string): Promise<string> {
  const { data: h } = await db.from('file_hashes').select('sha256').eq('path', path).maybeSingle();
  if (h) return h.sha256;
  const { data, error } = await db.storage.from(BUCKET).download(path); if (error || !data) return '';
  const bytes = new Uint8Array(await data.arrayBuffer()); const sha = await shaBytes(bytes);
  await db.from('file_hashes').upsert({ path, size: bytes.length, sha256: sha });
  return sha;
}
async function mergedInto(no: string): Promise<string> { const { data } = await db.from('events').select('d').eq('type', 'merge').eq('t', no).limit(1); return (data && data[0]?.d?.into) || ''; }
async function finalTicket(no: string) { let n = no; for (let i = 0; i < 5; i++) { const nx = await mergedInto(n); if (!nx) break; n = nx; } return n; }   // portal updates follow a merge
async function portalOf(no: string): Promise<string> { const { data } = await db.from('portal_links').select('request_id').eq('ticket', no).limit(1); return (data && data[0]?.request_id) || ''; }
async function ticketFiles(no: string) {   // the member's own files (no inline logos / signatures, nothing tiny)
  const { data } = await db.from('events').select('d').eq('t', no).eq('type', 'msg.in');
  return ((data || []) as any[]).flatMap((m) => m.d?.atts || []).filter((a: any) => a.path && !a.inline && +a.size > 20000 && a.source !== 'Sarwa');
}
async function sameFile(a: any[], b: any[]): Promise<string> {
  for (const x of a) for (const y of b) if (+x.size === +y.size && x.path !== y.path) { const [h1, h2] = [await fileHash(x.path), await fileHash(y.path)]; if (h1 && h1 === h2) return x.name || y.name || 'file'; }
  return '';
}
// a new portal request that is already here by email (same card + identical file): linked to that ticket, no second ticket
async function linkToEmailTicket(q: Req, hash: string): Promise<'updated' | 'skipped' | null> {
  const member = String(q.individual_number || ''); if (!member) return null;
  const at = Date.parse(q.creation_date || '') || Date.now();
  const mine = new Map<string, string>();   // sha -> file name (the portal's files, already in this request)
  for (const a of (q.attachments || []) as InlineAtt[]) {
    if (!a.content_base64 || /sarwa/i.test(String(a.source || ''))) continue;
    const bytes = Uint8Array.from(atob(a.content_base64), (ch) => ch.charCodeAt(0)); if (bytes.length > 20000) mine.set(await shaBytes(bytes), a.file_name || String(a.id));
  }
  if (!mine.size) return null;
  const { data: cands } = await db.from('events').select('t,ts,d').eq('type', 'ticket.create').eq('d->>member', member).neq('d->>source', 'portal')
    .gte('ts', new Date(at - 3 * DAY).toISOString()).lte('ts', new Date(at + 3 * DAY).toISOString()).order('ts', { ascending: false }).limit(10);
  for (const cnd of (cands || []) as any[]) {
    const no = await finalTicket(cnd.t);
    if (await portalOf(no)) continue;   // that ticket already answers another portal request
    for (const f of await ticketFiles(no)) {
      const sha = await fileHash(f.path);
      if (sha && mine.has(sha)) return await linkPortal(q, hash, no, `same member card ${member} and the identical file "${f.name}"`);
    }
  }
  return null;
}
async function linkPortal(q: Req, hash: string, no: string, why: string): Promise<'updated' | 'skipped'> {
  const id = String(q.request_id);
  const { error } = await db.from('portal_links').insert({ request_id: id, ticket: no, last_hash: '', status_code: q.status_code, status_name: statusName(q), portal_updated_at: q.last_update || null });
  if (error) { if (/duplicate|unique/i.test(error.message)) return 'skipped'; throw new Error(error.message); }
  const { data: hd } = await db.rpc('portal_holder_day', { p_holder: q.policy_holder || q.policy_holder_name || '', p_member: q.individual_number || '' });
  const p = portalInfo(q, hd);
  const atts = await saveInlineAtts(no, (q.attachments || []) as InlineAtt[]);
  await insertEv('Portal sync', 'portal.link', no, { requestId: id, portal: p, why, auto: true });
  await insertEv('Portal sync', 'msg.in', no, { key: `portal:${id}:init`, portal: true, channel: p.channel, fromName: q.individual_name || p.broker || '', fromEmail: p.brokerMail, to: '', cc: (q.cc || []).join('; '), date: q.creation_date || new Date().toISOString(), subject: `Chronic Attach #${id}`, text: requestText(q, p), atts });
  await insertEv('Portal sync', 'note', no, { auto: true, html: `<b>The same request also came on the portal</b> (Chronic Attach #${id}, ${String(p.channel || 'portal').replace(/</g, '&lt;')}): ${why.replace(/</g, '&lt;')}. It was added to this ticket instead of opening a second one. Answer once here: in the reply box tick <b>Email</b> and/or <b>Portal</b> (the portal sends it by ${p.brokerMail ? 'email to the broker' : 'WhatsApp'}).` });
  await db.from('portal_links').update({ last_hash: hash, att_ids: (q.attachments || []).map((a) => String(a.id)), timeline_ids: (q.timeline || []).map((x) => String(x.id)), synced_at: new Date().toISOString() }).eq('request_id', id);
  await log({ direction: 'in', action: 'link_ticket', request_id: id, ticket: no, detail: { why, files: atts.length } });
  return 'updated';
}
// every 5 minutes: a NEW ticket that is certainly the same request as an older one (same card + identical file, 3 days) is
// merged into the older one - only tickets created after this rule went live, and never one somebody already answered
async function dedupe(now: number) {
  const { data: go } = await db.rpc('portal_try_lock', { p_key: 'lock:dedupe', p_secs: 280 }); if (!go) return 0;
  const st0 = await getState('dedupe'); if (!st0.since) { await setState('dedupe', { since: new Date(now).toISOString() }); return 0; }
  const from = new Date(Math.max(Date.parse(st0.since), now - 6 * 3600000)).toISOString();
  const { data: fresh } = await db.from('events').select('t,ts,d').eq('type', 'ticket.create').gte('ts', from).order('ts').limit(60);
  let merged = 0;
  for (const n of (fresh || []) as any[]) {
    const no = n.t, member = String(n.d?.member || ''); if (!member || await mergedInto(no)) continue;
    const { count: acted } = await db.from('events').select('id', { count: 'exact', head: true }).eq('t', no).in('type', ['msg.out', 'portal.queued']);
    if (acted) continue;
    const { data: olds } = await db.from('events').select('t,ts,d').eq('type', 'ticket.create').eq('d->>member', member).lt('ts', n.ts).gte('ts', new Date(Date.parse(n.ts) - 3 * DAY).toISOString()).neq('t', no).order('ts', { ascending: false }).limit(10);
    if (!olds || !olds.length) continue;
    const mine = await ticketFiles(no); if (!mine.length) continue;
    const myPortal = await portalOf(no);
    for (const o of olds as any[]) {
      const target = await finalTicket(o.t); if (target === no) continue;
      if (myPortal && await portalOf(target)) continue;   // two portal requests: each keeps its own ticket (suggestion only)
      const file = await sameFile(mine, await ticketFiles(target)); if (!file) continue;
      const why = `same member card ${member} and the identical file "${file}"`;
      await insertEv('Duplicate check', 'merge', no, { into: target, auto: true, why });
      await insertEv('Duplicate check', 'note', target, { auto: true, html: `<b>${no} was merged into this ticket automatically</b>: ${why.replace(/</g, '&lt;')}. Its messages${myPortal ? ' and portal request #' + myPortal : ''} show here with their original dates; nothing was deleted.` });
      await log({ direction: 'system', action: 'auto_merge', ticket: target, detail: { from: no, into: target, why, portal: myPortal || null } });
      merged++; break;
    }
  }
  return merged;
}

async function createTicket(c: Cfg, q: Req, hash: string, attFn: AttFn): Promise<'created' | 'skipped'> {
  const id = String(q.request_id);
  // a request that is already decided in the portal and was never in the helpdesk is not imported (history before go-live)
  if (FINAL.has(+q.status_code)) { await log({ direction: 'in', action: 'skip_final', request_id: id, detail: { status: statusName(q) } }); return 'skipped'; }
  const linked = await linkToEmailTicket(q, hash).catch((e) => { console.warn('link check', errMsg(e)); return null; });
  if (linked) return linked as any;
  const { data: hd } = await db.rpc('portal_holder_day', { p_holder: q.policy_holder || q.policy_holder_name || '', p_member: q.individual_number || '' });
  const { data: nt, error: e1 } = await db.rpc('portal_next_ticket');
  if (e1 || !nt) throw new Error('ticket number: ' + (e1?.message || 'none'));
  const no = (nt as any).no as string, seq = (nt as any).seq as number;
  // claim the request first: the primary key makes a second run (or a second server) stop here - no duplicate ticket
  const { error: e2 } = await db.from('portal_links').insert({ request_id: id, ticket: no, last_hash: '', status_code: q.status_code, status_name: statusName(q), portal_updated_at: q.last_update || null });
  if (e2) { if (/duplicate|unique/i.test(e2.message)) return 'skipped'; throw new Error(e2.message); }
  try {
    const p = portalInfo(q, hd);
    const atts = await attFn(no, q.attachments || []);
    const created = q.creation_date || new Date().toISOString();
    const channelTag = String(p.channel || 'portal').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    await insertEv('Portal sync', 'ticket.create', no, {
      no, seq, source: 'portal', subject: `Chronic Attach #${id} - ${q.individual_name || q.individual_number || ''}`.trim(),
      requester: { name: p.broker || q.individual_name || '', email: p.brokerMail, phone: p.mobile }, member: q.individual_number || '', memberName: q.individual_name || '',
      lang: 'AR', status: q.status_code === 9 ? 'Open' : 'Open', priority: 'Medium', type: /renew/i.test(q.request_type || '') ? 'Renewal' : 'New chronic request',
      group: c.group || 'Chronic review', agent: '', tags: ['portal', 'chronic_portal', channelTag], ruleNames: [], createdAt: created, requestId: '', portal: p, mobile: p.mobile,
    });
    await insertEv('Portal sync', 'msg.in', no, {
      key: `portal:${id}:init`, initial: true, portal: true, channel: p.channel, fromName: q.individual_name || p.broker || '', fromEmail: p.brokerMail, to: '', cc: (q.cc || []).join('; '),
      date: created, subject: `Chronic Attach #${id}`, text: requestText(q, p), atts,
    });
    await db.from('portal_links').update({ last_hash: hash, att_ids: (q.attachments || []).map((a) => String(a.id)), timeline_ids: (q.timeline || []).map((x) => String(x.id)), synced_at: new Date().toISOString() }).eq('request_id', id);
    await log({ direction: 'in', action: 'create_ticket', request_id: id, ticket: no, new_status: statusName(q), detail: { attachments: atts.length, startDay: p.startDay, policyHolder: p.policyHolder } });
    return 'created';
  } catch (e) {
    // leave the link with an empty hash: the next run completes the ticket (files / first message) instead of creating another one
    await log({ direction: 'in', action: 'create_ticket', request_id: id, ticket: no, ok: false, error: errMsg(e) });
    throw e;
  }
}

async function updateTicket(c: Cfg, q: Req, link: any, hash: string, attFn: AttFn): Promise<'updated' | 'same'> {
  const id = String(q.request_id), no = await finalTicket(link.ticket as string);   // merged: updates go to the ticket it was merged into
  const { data: created } = await db.from('events').select('id').eq('type', 'ticket.create').eq('t', link.ticket).maybeSingle();
  if (!created) { await db.from('portal_links').delete().eq('request_id', id); return await createTicket(c, q, hash, attFn) as any; }   // half-made earlier: start again
  const knownAtt = new Set<string>(link.att_ids || []), knownTl = new Set<string>(link.timeline_ids || []);
  const newAtts = (q.attachments || []).filter((a) => !knownAtt.has(String(a.id)) && !/sarwa/i.test(String(a.source || '')));
  const newTl = (q.timeline || []).filter((x) => !knownTl.has(String(x.id)) && !isOurs(x));
  const fromReq = newTl.filter((x) => isRequester(q, x)), staff = newTl.filter((x) => !isRequester(q, x));
  const oldCode = +link.status_code, newCode = +q.status_code;
  const p = portalInfo(q, null);
  let changed = false;
  // a) the requester answered: new documents, a WhatsApp / email answer, or the request reopened -> reopens the ticket (customer_response)
  if (newAtts.length || fromReq.length || (newCode === 9 && oldCode !== 9)) {
    const atts = await attFn(no, newAtts);
    const text = fromReq.map((x) => [x.comment, x.extra_comment].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
      || (newAtts.length ? `New document(s) added on the portal: ${newAtts.map((a) => a.file_name || a.id).join(', ')}` : 'The request was reopened on the portal.');
    const at = [...fromReq.map((x) => x.at || ''), ...newAtts.map((a) => a.uploaded_at || ''), q.last_update || ''].filter(Boolean).sort().pop() || new Date().toISOString();
    await insertEv('Portal sync', 'msg.in', no, { key: `portal:${id}:${hash.slice(0, 16)}`, portal: true, channel: p.channel, fromName: q.individual_name || p.broker || '', fromEmail: p.brokerMail, to: '', cc: (q.cc || []).join('; '), date: at, subject: `Chronic Attach #${id} - answer`, text, atts });
    await log({ direction: 'in', action: 'customer_response', request_id: id, ticket: no, old_status: PORTAL_STATUS[oldCode], new_status: statusName(q), detail: { files: atts.length, messages: fromReq.length } });
    changed = true;
  }
  // b) the status changed on the portal without the helpdesk (someone used Reply / changed it in the portal directly)
  if (oldCode !== newCode) {
    const who = staff.map((x) => x.by).filter(Boolean)[0] || '';
    const direct = newCode !== 9 && staff.length > 0;
    await insertEv('Portal sync', 'portal.update', no, { statusCode: newCode, statusName: statusName(q), from: PORTAL_STATUS[oldCode] || String(oldCode), by: who, direct, lastUpdate: q.last_update || '', assignTo: q.assign_to || '' });
    if (direct && FINAL.has(newCode)) {
      await insertEv('Portal sync', 'note', no, { auto: true, html: `<b>Decided directly on the portal</b>${who ? ' by ' + who.replace(/</g, '&lt;') : ''}: ${statusName(q)}. The helpdesk did not send this decision. Check it, then close the ticket here (no second message is sent).` });
    }
    await log({ direction: 'in', action: direct ? 'portal_direct_change' : 'portal_status', request_id: id, ticket: no, ok: !direct, actor: who || null, old_status: PORTAL_STATUS[oldCode], new_status: statusName(q) });
    changed = true;
  } else if (staff.length) {
    await insertEv('Portal sync', 'portal.update', no, { statusCode: newCode, statusName: statusName(q), by: staff[0].by || '', direct: true, comment: str(staff.map((x) => x.comment || '').join(' / '), 500), lastUpdate: q.last_update || '' });
    changed = true;
  }
  await db.from('portal_links').update({ last_hash: hash, status_code: newCode, status_name: statusName(q), portal_updated_at: q.last_update || null,
    att_ids: (q.attachments || []).map((a) => String(a.id)), timeline_ids: (q.timeline || []).map((x) => String(x.id)), synced_at: new Date().toISOString() }).eq('request_id', id);
  return changed ? 'updated' : 'same';
}

// apply a successful decision result (from the ORDS HTTP response, or from the bridge PC's browser result)
async function recordSent(j: any, link: any, res: any, httpCode: number | null) {
  const job = j.job || {}; const id = String(j.request_id); const by = (job.agent || 'Agent') + ' (via portal)';
  const sentAt = new Date().toISOString();
  await db.from('portal_outbox').update({ status: 'sent', http_code: httpCode, result: res, error: null, sent_at: sentAt }).eq('id', j.id);
  await db.from('portal_links').update({ status_code: res.status_code ?? link?.status_code, status_name: res.status_name || link?.status_name, portal_updated_at: res.last_update || link?.portal_updated_at,
    timeline_ids: [...new Set([...(link?.timeline_ids || []), ...(res.timeline_id ? [String(res.timeline_id)] : [])])], synced_at: sentAt }).eq('request_id', id);
  await insertEv('Portal sync', 'portal.status', j.ticket, { jobId: j.id, status: 'sent', statusCode: res.status_code ?? null, statusName: res.status_name || '', timelineId: res.timeline_id || '', delivered: res.delivered || null, sentAt });
  if (job.ticketUpdate && Object.keys(job.ticketUpdate).length) await insertEv(by, 'update', j.ticket, job.ticketUpdate);
  await log({ direction: 'out', action: 'decision', request_id: id, ticket: j.ticket, http_code: httpCode, actor: job.agent || null, old_status: link?.status_name || null, new_status: res.status_name || null, detail: { job: j.id, decision: job.decision, delivered: res.delivered || null, attempts: j.attempts, via: res.via || 'api' } });
}
// a transient failure: queue again with back-off (minutes; seconds on the mock with fastRetry)
async function recordRetry(c: Cfg, j: any, status: number | null, text: string): Promise<'retrying'> {
  const unit = (c as any).fastRetry ? 1000 : 60000;   // seconds instead of minutes when fast-retry is on (tests)
  const next = new Date(Date.now() + RETRY_MIN[Math.min(j.attempts - 1, RETRY_MIN.length - 1)] * unit).toISOString();
  await db.from('portal_outbox').update({ status: 'queued', next_try_at: next, http_code: status || null, error: text }).eq('id', j.id);
  await insertEv('Portal sync', 'portal.status', j.ticket, { jobId: j.id, status: 'retrying', attempt: j.attempts, nextTry: next, error: str(text, 300), http: status || null });
  await log({ direction: 'out', action: 'decision', request_id: j.request_id, ticket: j.ticket, ok: false, http_code: status || null, error: text, detail: { job: j.id, attempt: j.attempts, nextTry: next } });
  return 'retrying';
}

// ---------- OUT: decisions -> portal ----------
async function pushOut(c: Cfg) {
  const out = { sent: 0, retrying: 0, failed: 0 };
  for (let round = 0; round < 5; round++) {
    const { data: jobs, error } = await db.rpc('portal_claim_outbox', { n: 10 });
    if (error) throw new Error(error.message);
    if (!jobs || !jobs.length) break;
    for (const j of jobs as any[]) { const r = await pushOne(c, j); (out as any)[r]++; }
  }
  return out;
}

async function pushOne(c: Cfg, j: any): Promise<'sent' | 'retrying' | 'failed'> {
  const job = j.job || {}; const id = String(j.request_id); const by = (job.agent || 'Agent') + ' (via portal)';
  const { data: link } = await db.from('portal_links').select('*').eq('request_id', id).maybeSingle();
  let r: Response | null = null, problem = '';
  try {
    const files = []; let total = 0;
    for (let i = 0; i < (job.attachments || []).length; i++) {
      const path = job.attachments[i]; const { data, error } = await db.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error('attachment not found: ' + path);
      const bytes = new Uint8Array(await data.arrayBuffer()); total += bytes.length;
      if (total > MAX_POST_ATT) throw new HttpErr(413, 'attachments over 15 MB together - send fewer files');
      const name = (job.attachmentNames || [])[i] || path.split('/').pop();
      files.push({ file_name: name, mime_type: mimeOf(name, data.type), content_base64: b64(bytes) });
    }
    const map = DECISION_MAP[job.decision] || DECISION_MAP.Message;
    const body = {
      decision: map.code, status_code: map.portalStatus, message: str(job.text, 8000), message_html: str(job.html, 60000), reason: str(job.reason, 500), missing_documents: (job.missing || []).slice(0, 30),
      agent_name: str(job.agent, 200), agent_email: str(job.agentEmail, 200), ticket: j.ticket, base_last_update: link?.portal_updated_at || null, source: 'sarwa-chronic', attachments: files,
    };
    r = await api(c, 'POST', `/requests/${encodeURIComponent(id)}/decision`, body, { 'Idempotency-Key': j.id });
  } catch (e) { problem = errMsg(e); if (e instanceof HttpErr && e.status === 413) return await fail(j, 'dead', 413, problem); }

  if (r && r.ok) { const res = await r.json().catch(() => ({})); await recordSent(j, link, res, r.status); return 'sent'; }
  const status = r ? r.status : 0;
  const text = r ? (await r.text().catch(() => '')).slice(0, 400) : problem;
  if (status === 409) return await fail(j, 'conflict', 409, 'The request changed on the portal after this ticket was last updated - refresh, check, then send again. ' + text);
  const transient = !r || status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
  if (transient && j.attempts < MAX_ATTEMPTS) return await recordRetry(c, j, status, text);
  return await fail(j, transient ? 'dead' : 'error', status || null, text || ('HTTP ' + status));
}

// a job that will not go through by itself: the ticket shows it (Sync failed queue) and the admin gets an email
async function fail(j: any, status: 'conflict' | 'error' | 'dead', http: number | null, error: string): Promise<'failed'> {
  await db.from('portal_outbox').update({ status, http_code: http, error }).eq('id', j.id);
  await insertEv('Portal sync', 'portal.status', j.ticket, { jobId: j.id, status, http, error: str(error, 500), attempts: j.attempts });
  await log({ direction: 'out', action: 'decision', request_id: j.request_id, ticket: j.ticket, ok: false, http_code: http, error, detail: { job: j.id, final: status, attempts: j.attempts } });
  if (status !== 'conflict') await alertAdmin(j, status, error).catch(() => {});
  return 'failed';
}
async function alertAdmin(j: any, status: string, error: string) {
  const c = await config();
  const to = c.alertTo || ((await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)).data || []).map((p: any) => p.email).filter(Boolean).join('; ');
  if (!to) return;
  const outId = 'out_portal_' + Date.now().toString(36) + rand(4);
  const html = `<p>The decision on <b>${j.ticket}</b> (portal request ${j.request_id}) could not be posted to the portal: <b>${status}</b>.</p><p>${String(error).replace(/</g, '&lt;')}</p><p>Open the ticket > Portal panel > Try again, or the "Portal - sync failed" queue. The request is still open on the portal.</p>`;
  await db.from('outbox').insert({ id: outId, ticket: j.ticket, status: 'queued', job: { outId, ticket: j.ticket, to, cc: '', replyAll: false, subject: `[Portal sync failed] ${j.ticket} / request ${j.request_id}`, html, replyToMid: '', attachments: [], attachmentNames: [], attachmentCids: [], mailbox: c.mailbox || 'Chronic@sarwa.life', queuedBy: 'Portal sync', queuedAt: new Date().toISOString(), internal: true } });
}

// ---------- who is calling ----------
type Who = { kind: 'token' } | { kind: 'user'; id: string; name: string; email: string; role: string };
async function caller(req: Request): Promise<Who | null> {
  const pt = req.headers.get('x-portal-token') || '';
  if (pt.startsWith('chp_')) { const s = await readSecret('portal_token'); if (s && s.hash && s.hash === await sha256(pt)) return { kind: 'token' }; return null; }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt); if (!data?.user) return null;
  const { data: p } = await db.from('profiles').select('id,name,email,role,active').eq('id', data.user.id).maybeSingle();
  return p && p.active ? { kind: 'user', id: p.id, name: p.name || p.email, email: p.email, role: p.role } : null;
}
const isAdmin = (w: Who | null) => !!w && (w.kind === 'token' || w.role === 'admin');

async function statusOf(c: Cfg) {
  const cur = await getState('cursor');
  const counts: Record<string, number> = {};
  for (const s of ['queued', 'sending', 'conflict', 'error', 'dead']) { const { count } = await db.from('portal_outbox').select('id', { count: 'exact', head: true }).eq('status', s); counts[s] = count || 0; }
  const { count: links } = await db.from('portal_links').select('request_id', { count: 'exact', head: true });
  const health = c.mode === 'browser' ? await getState('health') : null;
  return { mode: c.mode, dryRun: c.dryRun !== false, liveAll: (c as any).liveAll === true, liveRequests: (c as any).liveRequests || [], levels: { ...DEFAULT_LEVELS, ...((c as any).levels || {}) }, configured: c.mode === 'mock' || c.mode === 'browser' || !!(c.baseUrl && c.clientId && c.clientSecret), baseUrl: c.mode === 'live' ? c.baseUrl : c.mode === 'mock' ? 'mock (test requests only)' : c.mode === 'browser' ? 'portal UI via the Outlook bridge PC (no IT)' : '', tokenUrl: c.mode === 'live' ? c.tokenUrl : '',
    clientId: c.mode === 'live' ? c.clientId : '', hasSecret: !!c.clientSecret, intervalMin: c.intervalMin, group: c.group, alertTo: c.alertTo, since: c.since,
    cursor: cur.since || null, lastRun: cur.lastRun || null, lastOk: cur.lastOk || null, lastError: cur.lastError || null, last: cur.last || null, queue: counts, linked: links || 0, health,
    bridgeProblem: health ? bridgeProblem(c, health, Date.now()) : '', sweep: await getState('sweep'), timeoutMin: TIMEOUT_MIN, maxAttempts: MAX_ATTEMPTS };
}

// ---------- mock helpers (only while the connection is in mock mode: TEST requests) ----------
async function mockSetup() {
  const m = (await readSecret('portal_mock')) || {};
  if (!m.clientId) await writeSecret('portal_mock', { clientId: 'mock-' + rand(8), clientSecret: rand(32) });
  return { ok: true };
}

// ---------- browser bridge: the local worker on the in-network PC (Outlook bridge PC) drives the real portal UI ----------
// Supabase never reaches the portal in this mode. The worker pulls decisions, carries them out in a signed-in browser,
// confirms from the Request Timeline, and pushes new/changed requests in. It authenticates with the chp_ portal token.
// claim: one specific job (id) - the bridge only claims what it is allowed to write - or, without id, whatever is due
// live gate: with dry run off, only requests on the admin's live list (or all, once approved) are handed out for writing
const liveOk = (c: any, requestId: string) => c.liveAll === true || ((c.liveRequests || []) as string[]).map(String).includes(String(requestId));
async function bridgeJobs(limit: number, id?: string) {
  const c: any = await config();
  if (c.dryRun !== false) return [];   // dry run: nothing is handed to the bridge for writing
  let jobs: any[] = [];
  if (id) {
    const { data: j0 } = await db.from('portal_outbox').select('request_id').eq('id', id).maybeSingle();
    if (!j0 || !liveOk(c, j0.request_id)) return [];
    const { data, error } = await db.rpc('portal_claim_one', { p_id: id }); if (error) throw new Error(error.message); jobs = data || [];
  } else if (c.liveAll === true) {
    const { data, error } = await db.rpc('portal_claim_outbox', { n: Math.max(1, Math.min(10, limit)) }); if (error) throw new Error(error.message); jobs = data || [];
  } else {
    const { data: due } = await db.from('portal_outbox').select('id').eq('status', 'queued').in('request_id', ((c.liveRequests || []) as string[]).map(String)).lte('next_try_at', new Date(Date.now() + 2000).toISOString()).order('created_at').limit(Math.max(1, Math.min(10, limit)));
    for (const d of due || []) { const { data } = await db.rpc('portal_claim_one', { p_id: d.id }); jobs.push(...(data || [])); }
  }
  return await jobViews(jobs);
}
// look without claiming (dry-run previews; jobs stay queued and the ticket keeps "Waiting for the portal")
async function bridgePeek(limit: number) {
  const { data, error } = await db.from('portal_outbox').select('*').eq('status', 'queued').lte('next_try_at', new Date(Date.now() + 2000).toISOString()).order('created_at').limit(Math.max(1, Math.min(25, limit)));
  if (error) throw new Error(error.message);
  return await jobViews((data || []) as any[]);
}
async function jobViews(jobs: any[]) {
  const out = [];
  for (const j of jobs) {
    const job = j.job || {}; const paths: string[] = job.attachments || [];
    let files: { name: string; url: string }[] = [];
    if (paths.length) { const { data: su } = await db.storage.from(BUCKET).createSignedUrls(paths, 900); files = (su || []).map((s, i) => ({ name: (job.attachmentNames || [])[i] || paths[i].split('/').pop()!, url: s.signedUrl || '' })); }
    const { data: link } = await db.from('portal_links').select('portal_updated_at,status_name').eq('request_id', j.request_id).maybeSingle();
    out.push({ id: j.id, ticket: j.ticket, request_id: j.request_id, attempt: j.attempts, decision: job.decision, status_code: DECISION_MAP[job.decision]?.portalStatus ?? null,
      message: job.text || '', reason: job.reason || '', missing: job.missing || [], lang: job.lang || 'AR', agent: job.agent || '', base_last_update: link?.portal_updated_at || null, portal_status_now: link?.status_name || null, files });
  }
  return out;
}
async function bridgeJobResult(b: any) {
  const { data: j } = await db.from('portal_outbox').select('*').eq('id', String(b.id || '')).maybeSingle();
  if (!j) throw new HttpErr(404, 'unknown job');
  const result = String(b.result || 'error');
  // a confirmation from the portal Timeline is the truth even when it arrives late (result kept on the bridge PC while the
  // connection was down, or the job was taken back / timed out meanwhile): record it once, never send again
  const late = result === 'sent' && (j.status === 'queued' || ((j.status === 'dead' || j.status === 'error') && j.http_code === TIMEOUT_CODE));
  if (j.status !== 'sending' && !late) return { ok: true, already: j.status };   // idempotent: the result already came in
  const { data: link } = await db.from('portal_links').select('*').eq('request_id', j.request_id).maybeSingle();
  const c = await config();
  if (late) {
    const { data: upd } = await db.from('portal_outbox').update({ status: 'sending' }).eq('id', j.id).eq('status', j.status).select('id');   // one writer only
    if (!upd || !upd.length) return { ok: true, already: 'changed meanwhile' };
    await insertEv('Portal sync', 'note', j.ticket, { auto: true, html: `<b>Portal confirmed this reply after a delay</b> (found in the Request Timeline${b.late_check ? ' by the automatic check' : ''}). It was sent once; nothing is sent again.` });
  }
  if (result === 'sent') { await recordSent(j, link, { ...(b.portal || {}), via: 'browser' }, 200); return { ok: true, status: 'sent' }; }
  if (result === 'conflict') { await fail(j, 'conflict', 409, str(b.error || 'the request changed on the portal', 400)); return { ok: true, status: 'conflict' }; }
  if (result === 'retry' && j.attempts < MAX_ATTEMPTS) { await recordRetry(c, j, b.http || null, str(b.error || 'the bridge could not complete the submit', 400)); return { ok: true, status: 'retrying' }; }
  await fail(j, 'error', b.http || null, str(b.error || 'the bridge reported a failure', 400));
  return { ok: true, status: 'error' };
}
// replies failed by the 15-min timeout in the last 48 h: the bridge looks in each request's Timeline (read only) and
// confirms the ones that did reach the portal (e.g. saved, then the connection dropped before the answer came back)
async function bridgeUnconfirmed(limit: number) {
  const { data } = await db.from('portal_outbox').select('*').in('status', ['dead', 'error']).eq('http_code', TIMEOUT_CODE)
    .gte('waiting_since', new Date(Date.now() - 48 * 3600000).toISOString()).order('waiting_since').limit(Math.max(1, Math.min(10, limit)));
  return (await jobViews((data || []) as any[])).map((v: any, i: number) => ({ ...v, queued_at: (data as any[])[i].waiting_since }));
}

// ---------- safety sweep: nothing waits forever, nothing is hidden ----------
// Runs at most once a minute from the bridge's polls (every 8 s) and from every open app's tick (about every 2 min), so it
// also works while the bridge is down. 1) a claim the bridge never answered -> back to the queue (attempt counted),
// 2) a reply not confirmed within 15 min -> "Sync failed" with the reason + one alert email to the admins,
// 3) the app's view of each job (events) is compared with the queue and corrected, 4) bridge silent for 6+ min -> alert,
// 5) once a day: the list of every reply still not confirmed goes to the admins.
const mins = (ms: number) => Math.round(ms / 60000);
async function adminsTo(c: Cfg) { return c.alertTo || ((await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)).data || []).map((p: any) => p.email).filter(Boolean).join('; '); }
async function internalMail(c: Cfg, ticket: string, subject: string, html: string) {
  const to = await adminsTo(c); if (!to) return;
  const outId = 'out_portal_' + Date.now().toString(36) + rand(4);
  await db.from('outbox').insert({ id: outId, ticket, status: 'queued', job: { outId, ticket, to, cc: '', replyAll: false, subject, html, replyToMid: '', attachments: [], attachmentNames: [], attachmentCids: [], mailbox: c.mailbox || 'Chronic@sarwa.life', queuedBy: 'Portal sync', queuedAt: new Date().toISOString(), internal: true } });
}
function bridgeProblem(c: Cfg, h: Record<string, any>, now: number) {
  if (c.mode !== 'browser') return '';
  if (!h.at || now - Date.parse(h.at) > 6 * 60000) return `the portal bridge (Outlook PC) has not reported since ${h.at ? new Date(h.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'it was set up'} - PC off, task stopped or no network`;
  if (h.ok === false) return (h.loggedIn === false ? 'the portal sign-in expired or is blocked: ' : 'the portal bridge reports a problem: ') + String(h.error || 'unknown');
  return '';
}
async function sweep(c: Cfg, force = false) {
  if (c.mode === 'off') return null;
  if (!force) { const { data: go } = await db.rpc('portal_try_lock', { p_key: 'sweep', p_secs: 55 }); if (!go) return null; }
  const now = Date.now(); const out = { retaken: 0, timedOut: 0, resynced: 0, bridgeAlert: false, daily: 0 };
  const health = await getState('health'); const problem = bridgeProblem(c, health, now);
  // 1) lost claims
  const { data: stale } = await db.from('portal_outbox').select('*').eq('status', 'sending').lt('next_try_at', new Date(now - LEASE_MIN * 60000).toISOString());
  for (const j of (stale || []) as any[]) {
    if (j.attempts >= MAX_ATTEMPTS || now - Date.parse(j.waiting_since) > TIMEOUT_MIN * 60000) continue;   // step 2 decides
    const err = `no answer from the bridge for ${LEASE_MIN} minutes after it took this reply (connection lost?) - trying again; the portal Timeline is checked first, so it cannot go twice`;
    const { data: upd } = await db.from('portal_outbox').update({ status: 'queued', next_try_at: new Date().toISOString(), error: err }).eq('id', j.id).eq('status', 'sending').eq('next_try_at', j.next_try_at).select('id');
    if (upd && upd.length) { out.retaken++; await insertEv('Portal sync', 'portal.status', j.ticket, { jobId: j.id, status: 'retrying', attempt: j.attempts, error: err }); await log({ direction: 'out', action: 'lease_expired', request_id: j.request_id, ticket: j.ticket, ok: false, error: err, detail: { job: j.id, attempts: j.attempts } }); }
  }
  // 2) the 15-minute timeout
  const { data: old } = await db.from('portal_outbox').select('*').in('status', ['queued', 'sending']).lt('waiting_since', new Date(now - TIMEOUT_MIN * 60000).toISOString());
  const failedNow: any[] = [];
  for (const j of (old || []) as any[]) {
    if (j.status === 'sending' && now - Date.parse(j.next_try_at) < LEASE_MIN * 60000) continue;   // the bridge is on it right now
    const cause = problem || (j.error ? String(j.error).replace(/^requeued once: /, '') : j.attempts ? `${j.attempts} attempt(s) without a confirmation` : 'the bridge did not pick it up');
    const err = `Not confirmed by the portal within ${TIMEOUT_MIN} minutes (waited ${mins(now - Date.parse(j.waiting_since))} min, ${j.attempts} attempt(s)). Cause: ${cause}. ` +
      'If it did reach the portal, the bridge finds it in the Request Timeline and marks it sent by itself. Otherwise press Try again once the portal is reachable.';
    const { data: upd } = await db.from('portal_outbox').update({ status: 'dead', http_code: TIMEOUT_CODE, error: str(err, 900) }).eq('id', j.id).eq('status', j.status).eq('next_try_at', j.next_try_at).select('id');
    if (!upd || !upd.length) continue;
    out.timedOut++; failedNow.push({ ...j, err });
    await insertEv('Portal sync', 'portal.status', j.ticket, { jobId: j.id, status: 'dead', timeout: true, http: TIMEOUT_CODE, error: str(err, 900), attempts: j.attempts });
    await log({ direction: 'out', action: 'timeout', request_id: j.request_id, ticket: j.ticket, ok: false, http_code: TIMEOUT_CODE, error: err, detail: { job: j.id, attempts: j.attempts, waited_min: mins(now - Date.parse(j.waiting_since)) } });
  }
  if (failedNow.length) {
    const rows = failedNow.map((j) => `<li><b>${j.ticket}</b> / portal request ${j.request_id} - ${String(j.job?.decision || '')} by ${String(j.job?.agent || '').replace(/</g, '&lt;')}: ${String(j.err).replace(/</g, '&lt;')}</li>`).join('');
    await internalMail(c, failedNow[0].ticket, `[Portal] ${failedNow.length} repl${failedNow.length > 1 ? 'ies' : 'y'} not confirmed within ${TIMEOUT_MIN} min`, `<p>These replies were not confirmed by the portal and are now in the <b>Sync failed</b> queue:</p><ul>${rows}</ul><p>Nothing is lost: open the ticket and press <b>Try again</b> when the portal is reachable.</p>`).catch(() => {});
  }
  // 3) the app's view (latest portal.status event per job) must match the queue
  const { data: recent } = await db.from('portal_outbox').select('id,ticket,status,error,http_code,attempts,sent_at,result').gte('created_at', new Date(now - 3 * 86400000).toISOString());
  const ids = ((recent || []) as any[]).map((r) => r.id);
  if (ids.length) {
    const { data: evs } = await db.from('events').select('d,ts').eq('type', 'portal.status').in('d->>jobId', ids).order('ts');
    const lastEv: Record<string, string> = {}; for (const e of (evs || []) as any[]) lastEv[e.d.jobId] = e.d.status;
    const same = (o: string, e?: string) => o === 'queued' || o === 'sending' ? !e || ['retrying', 'requeued'].includes(e) : e === o;
    for (const r of (recent || []) as any[]) {
      if (same(r.status, lastEv[r.id])) continue;
      if (r.status === 'queued' || r.status === 'sending') continue;   // in flight: the bridge's answer will update it
      const d: Record<string, unknown> = { jobId: r.id, status: r.status, resync: true };
      if (r.status === 'sent') Object.assign(d, { statusCode: r.result?.status_code ?? null, statusName: r.result?.status_name || '', delivered: r.result?.delivered || null, sentAt: r.sent_at });
      else Object.assign(d, { error: str(r.error, 900), http: r.http_code, attempts: r.attempts, timeout: r.http_code === TIMEOUT_CODE });
      await insertEv('Portal sync', 'portal.status', r.ticket, d); out.resynced++;
      await log({ direction: 'system', action: 'resync', ticket: r.ticket, ok: true, detail: { job: r.id, queue: r.status, app: lastEv[r.id] || 'queued' } });
    }
  }
  // 4) bridge silent / signed out: one alert per hour (the bridge's own health reports alert too)
  if (problem && c.mode === 'browser') {
    const { data: go } = await db.rpc('portal_try_lock', { p_key: 'alert_bridge', p_secs: 3600 });
    const waiting = ((await db.from('portal_outbox').select('id', { count: 'exact', head: true }).in('status', ['queued', 'sending'])).count) || 0;
    if (go && (waiting || !health.at || now - Date.parse(health.at) > 6 * 60000)) {
      out.bridgeAlert = true;
      await log({ direction: 'system', action: 'health', ok: false, error: problem, detail: { waiting } });
      await internalMail(c, '', '[Portal bridge] not working - replies are held', `<p><b>${problem.replace(/</g, '&lt;')}</b>.</p><p>${waiting} repl${waiting === 1 ? 'y is' : 'ies are'} waiting. They stay in the queue (nothing is lost or sent twice); after ${TIMEOUT_MIN} minutes they move to the Sync failed queue with this reason.</p><p>Check the Outlook PC: task ChronicPortalBridge running, network, portal sign-in.</p>`).catch(() => {});
    }
  }
  // 5) daily list (from 07:00 Cairo): every reply not confirmed and not cancelled in the last 7 days
  if (new Date(now).getUTCHours() >= 5) {
    const { data: go } = await db.rpc('portal_try_lock', { p_key: 'daily_check:' + new Date(now).toISOString().slice(0, 10), p_secs: 20 * 3600 });   // once per date (new key each day)
    if (go) {
      const { data: open } = await db.from('portal_outbox').select('id,ticket,request_id,status,error,waiting_since,job').in('status', ['queued', 'sending', 'dead', 'error', 'conflict']).gte('created_at', new Date(now - 7 * 86400000).toISOString()).order('waiting_since');
      const list = (open || []) as any[]; out.daily = list.length;
      // duplicate sends of the last 24 h: the same email (same text) to the same people within 30 minutes
      const { data: outs } = await db.from('events').select('t,ts,actor,d').eq('type', 'msg.out').gte('ts', new Date(now - DAY).toISOString()).limit(5000);
      const sig = (d: any) => String(d?.to || '').toLowerCase().replace(/\s+/g, '') + '|' + String(d?.html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const real = ((outs || []) as any[]).filter((o) => !o.d?.auto && !o.d?.forward);
      const dups: any[] = [];
      for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
        const a = real[i], b = real[j];
        if (a.t === b.t && Math.abs(Date.parse(a.ts) - Date.parse(b.ts)) < 1800000 && sig(a.d) === sig(b.d)) dups.push({ t: a.t, to: a.d?.to, t1: a.ts, t2: b.ts, by: b.actor });
      }
      await log({ direction: 'system', action: 'daily_check', ok: list.length === 0 && dups.length === 0, detail: { open: list.map((x) => [x.ticket, x.request_id, x.status]), duplicate_sends: dups.map((x) => [x.t, x.t1, x.t2]) } });
      const dupHtml = dups.length ? `<p><b>The same email went twice</b> (last 24 h; nothing was sent to anyone about it):</p><ul>${dups.map((x) => `<li><b>${x.t}</b> to ${String(x.to || '').replace(/</g, '&lt;')} - ${String(x.t1).slice(11, 16)} and ${String(x.t2).slice(11, 16)} UTC (${String(x.by || '').replace(/</g, '&lt;')})</li>`).join('')}</ul>` : '';
      if (list.length || dups.length) await internalMail(c, '', `[Portal] daily check: ${list.length} not confirmed, ${dups.length} duplicate send(s)`, (list.length ? `<p>Replies to the portal that are not confirmed (last 7 days):</p><ul>${list.map((x) => `<li><b>${x.ticket}</b> / request ${x.request_id} - <b>${x.status}</b> since ${String(x.waiting_since).slice(0, 16).replace('T', ' ')} UTC - ${String(x.job?.decision || '')} by ${String(x.job?.agent || '').replace(/</g, '&lt;')}${x.error ? ': ' + String(x.error).slice(0, 300).replace(/</g, '&lt;') : ''}</li>`).join('')}</ul><p>Open each ticket: Try again, or Cancel if it is no longer needed. Refused (conflict) means the request was decided on the portal first.</p>` : '') + dupHtml).catch(() => {});
    }
  }
  // 6) one request = one ticket: certain duplicates among new tickets are merged (every 5 min)
  (out as any).merged = await dedupe(now).catch((e) => { console.warn('dedupe', errMsg(e)); return 0; });
  if (out.retaken || out.timedOut || out.resynced || out.bridgeAlert || (out as any).merged) await setState('sweep', { at: new Date().toISOString(), ...out });
  return out;
}
// ---------- arrival checks (rules engine) ----------
// Each rule gives ok / warn / fail / info with a reason; every rule run is logged (portal_sync_log action rule:<id>).
// The result is a Suggested Decision with confidence and the automation level that applies to it (Settings > Portal).
// Item-level checks (item codes vs past decisions, Sarwa rules) run in the app once the AI reader has read the files.
// Level 1 (fully automatic) is never executed here: it needs the admin's approval per rule and is OFF by default.
export const DEFAULT_LEVELS: Record<string, number> = { missing_docs: 2, approve: 2, reject: 2, partial: 3, duplicate: 3, medical_team: 3, review: 3 };
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
function cycleOf(startDay: number, at: Date) {   // the member's monthly cycle that contains the request date
  const dim = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const on = (base: Date) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(startDay, dim(base.getUTCFullYear(), base.getUTCMonth()))));
  let start = on(at); if (start > at) start = on(addMonths(at, -1));
  return { start: start.toISOString().slice(0, 10), next: on(addMonths(start, 1)).toISOString().slice(0, 10) };
}
async function runRules(no: string, requestId: string) {
  const { data: ev } = await db.from('events').select('d').eq('type', 'ticket.create').eq('t', no).maybeSingle();
  const d: any = ev?.d || {}; const p: any = d.portal || {};
  const { data: msgs } = await db.from('events').select('d').eq('t', no).eq('type', 'msg.in');
  const files = (msgs || []).flatMap((m: any) => (m.d?.atts || [])).filter((a: any) => a.path && a.source !== 'Sarwa');
  const readableFiles = files.filter((a: any) => a.cls === 'readable');
  const { data: ctx } = await db.rpc('portal_member_context', { p_member: d.member || '', p_ticket: no, p_request: requestId });
  const cx: any = ctx || {}; const c: any = await config(); const levels = { ...DEFAULT_LEVELS, ...(c.levels || {}) };
  const checks: { id: string; name: string; result: 'ok' | 'warn' | 'fail' | 'info'; detail: string }[] = [];
  // R1 documents
  checks.push(files.length ? { id: 'R1', name: 'Documents present', result: readableFiles.length ? 'ok' : 'warn', detail: files.length + ' file(s) from the portal' + (readableFiles.length < files.length ? ', ' + (files.length - readableFiles.length) + ' not readable by the AI reader (Word / HEIC / other)' : '') }
    : { id: 'R1', name: 'Documents present', result: 'fail', detail: 'No prescription or document on the portal for this request' });
  // R2 duplicate request: another open ticket or another open portal request for the same member
  const openT = (cx.open_tickets || []) as any[]; const openP = ((cx.portal_requests || []) as any[]).filter((r) => [1, 2, 3, 6, 9].includes(+r.status_code));
  checks.push(openT.length || openP.length ? { id: 'R2', name: 'Duplicate request', result: 'warn', detail: [openT.length ? 'open ticket(s) for this member: ' + openT.map((x) => x.no + ' (' + x.source + ', ' + x.status + ')').join(', ') : '', openP.length ? 'other open portal request(s): ' + openP.map((x) => '#' + x.request_id + ' ' + x.status).join(', ') : ''].filter(Boolean).join(' - ') }
    : { id: 'R2', name: 'Duplicate request', result: 'ok', detail: 'No other open request for this member' });
  // R3 recent decisions on the portal for the same member (possible repeat request)
  const recent = ((cx.portal_requests || []) as any[]).filter((r) => [4, 5, 7, 8].includes(+r.status_code) && Date.parse(r.created) > Date.now() - 30 * 86400000);
  checks.push(recent.length ? { id: 'R3', name: 'Recent portal decision', result: 'warn', detail: recent.slice(0, 3).map((r) => '#' + r.request_id + ' ' + r.status + ' ' + String(r.created).slice(0, 10)).join(', ') + ' (last 30 days)' }
    : { id: 'R3', name: 'Recent portal decision', result: 'ok', detail: 'No decided request in the last 30 days' });
  // R4 Starting Day alignment for the member's policy holder
  if (p.startDay != null) {
    const at = new Date(p.createdAt || d.createdAt || Date.now()); const cy = cycleOf(+p.startDay, at);
    checks.push({ id: 'R4', name: 'Starting Day alignment', result: 'info', detail: `Starting Day ${p.startDay} (${p.startDaySrc || 'holder data'}): request ${at.toISOString().slice(0, 10)} falls in the cycle that starts ${cy.start}; the next cycle starts ${cy.next}. Treatment start = ${cy.start}.` });
  } else checks.push({ id: 'R4', name: 'Starting Day alignment', result: 'warn', detail: 'Starting Day not found for this policy holder - add it in Policy holders' });
  // R5 contract / eligibility: needs i-CARE (checked by the agent / the i-CARE helper)
  checks.push({ id: 'R5', name: 'Contract active / member eligible', result: 'info', detail: 'Check in i-CARE (button on the ticket); not available to the server' });
  // suggestion
  let s: { decision: string; reason: string; kind: string; confidence: number };
  if (!files.length) s = { decision: 'Pending', reason: 'Missing documents', kind: 'missing_docs', confidence: 0.9 };
  else if (openT.length || openP.length) s = { decision: 'Review', reason: 'Possible duplicate - check ' + [...openT.map((x) => x.no), ...openP.map((x) => '#' + x.request_id)].join(', '), kind: 'duplicate', confidence: 0.6 };
  else s = { decision: 'Review', reason: 'Items are checked when the AI reader has read the prescription (item codes vs past decisions)', kind: 'review', confidence: 0 };
  const out = { at: new Date().toISOString(), requestId, checks, suggestion: { ...s, level: levels[s.kind] ?? 3 } };
  await insertEv('Portal rules', 'portal.rules', no, out);
  for (const ch of checks) await log({ direction: 'system', action: 'rule:' + ch.id, request_id: requestId, ticket: no, ok: ch.result !== 'fail', detail: { name: ch.name, result: ch.result, detail: ch.detail } });
  await log({ direction: 'system', action: 'suggestion', request_id: requestId, ticket: no, detail: out.suggestion });
  return { suggestion: out.suggestion, checks: checks.map((x) => x.id + ':' + x.result) };
}
// Backfill: files that were on the portal BEFORE the ticket was made (first import without files) are added as part of the
// original request - no "customer response", no reopen, no status change. Already stored file ids are skipped.
async function backfillFiles(q: Req & { attachments?: InlineAtt[] }, link: any) {
  const id = String(q.request_id), no = link.ticket as string;
  const known = new Set<string>(link.att_ids || []);
  const fresh = (q.attachments || []).filter((a) => !known.has(String(a.id)));
  if (!fresh.length) return { added: 0, files: 0 };
  const atts = await saveInlineAtts(no, fresh);
  await insertEv('Portal sync', 'msg.in', no, { key: `portal:${id}:files:${fresh.map((a) => String(a.id)).sort().join(',').slice(0, 120)}`, initial: true, portal: true, backfill: true,
    channel: q.channel || '', fromName: q.individual_name || q.broker || '', fromEmail: q.broker_mail || '', to: '', cc: '', date: q.creation_date || new Date().toISOString(),
    subject: `Chronic Attach #${id} - documents on the portal`, text: `Documents of portal request #${id} (Broker attachments: ${fresh.filter((a) => a.source !== 'Sarwa').length}, Sarwa attachments: ${fresh.filter((a) => a.source === 'Sarwa').length}).`, atts });
  const stored = atts.filter((a: any) => a.path).length;
  await db.from('portal_links').update({ att_ids: [...new Set([...known, ...fresh.filter((a) => a.content_base64).map((a) => String(a.id))])], synced_at: new Date().toISOString() }).eq('request_id', id);
  await log({ direction: 'in', action: 'backfill_files', request_id: id, ticket: no, ok: stored === fresh.length, detail: { files: fresh.length, stored }, error: stored === fresh.length ? null : (fresh.length - stored) + ' file(s) not stored' });
  return { added: stored, files: fresh.length };
}
async function bridgeIngest(requests: (Req & { attachments?: InlineAtt[] })[], backfill = false) {
  const res = { created: 0, updated: 0, same: 0, skipped: 0, files: 0, errors: [] as string[] };
  const c = await config(); const attFn: AttFn = (no, list) => saveInlineAtts(no, list as InlineAtt[]);
  for (const q of requests || []) {
    try {
      const id = String(q.request_id);
      let { data: link } = await db.from('portal_links').select('*').eq('request_id', id).maybeSingle();
      if (link && backfill) { const b = await backfillFiles(q, link); res.files += b.added; if (b.files) await runRules(link.ticket, id); ({ data: link } = await db.from('portal_links').select('*').eq('request_id', id).maybeSingle()); }
      const hash = await reqHash(q);
      if (link && link.last_hash === hash) { await db.from('portal_links').update({ synced_at: new Date().toISOString() }).eq('request_id', id); res.same++; continue; }
      const r = link ? await updateTicket(c, q, link, hash, attFn) : await createTicket(c, q, hash, attFn);
      (res as any)[r]++;
      if (r === 'created' || r === 'updated') { const { data: l2 } = await db.from('portal_links').select('ticket').eq('request_id', id).maybeSingle(); if (l2) await runRules(l2.ticket, id); }   // checks again on arrival and after an answer
    } catch (e) { res.errors.push(String(q.request_id) + ': ' + errMsg(e)); await log({ direction: 'in', action: 'bridge_ingest', request_id: String(q.request_id), ok: false, error: errMsg(e) }); }
  }
  const cur = await getState('cursor');
  await setState('cursor', { ...cur, lastRun: new Date().toISOString(), lastOk: res.errors.length ? cur.lastOk || null : new Date().toISOString(), lastError: res.errors[0] || null, last: res, via: 'browser' });
  if (res.created || res.updated || res.errors.length) await log({ direction: 'in', action: 'bridge_ingest', ok: !res.errors.length, detail: res, error: res.errors[0] || null });
  return res;
}
// Portal history: one row per portal request (any status), upserted by request id - re-running the import is safe
async function bridgeHistory(rows: any[]) {
  const clean = (rows || []).filter((r) => r && /^\d{1,12}$/.test(String(r.request_id || ''))).slice(0, 2000).map((r) => ({
    request_id: String(r.request_id), individual_number: str(r.individual_number, 20) || null, individual_name: str(r.individual_name, 200) || null,
    policy_holder: str(r.policy_holder, 200) || null, contract_no: str(r.contract_no, 40) || null, channel: str(r.channel, 40) || null,
    creation_user: str(r.creation_user, 120) || null, broker: str(r.broker, 200) || null, broker_mail: str(r.broker_mail, 200) || null,
    status_code: Number.isFinite(+r.status_code) ? +r.status_code : null, status_name: str(r.status_name, 60) || null,
    chronic_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.chronic_date || '')) ? r.chronic_date : null, creation_date: r.creation_date || null,
    assign_to: str(r.assign_to, 120) || null, source: str(r.source || 'chronic-attach', 40), updated_at: new Date().toISOString(),
  }));
  if (!clean.length) return { upserted: 0 };
  const { error } = await db.from('portal_history').upsert(clean, { onConflict: 'request_id' });
  if (error) throw new Error(error.message);
  return { upserted: clean.length };
}
async function bridgeReconcile(openIds: string[]) {
  const set = new Set((openIds || []).map(String));
  const { data } = await db.from('portal_links').select('request_id').limit(10000);
  const linked = new Set((data || []).map((l: any) => String(l.request_id)));
  const missing = [...set].filter((id) => !linked.has(id));
  const { data: openLinks } = await db.from('portal_links').select('request_id').in('status_code', [1, 2, 3, 6, 9]);
  const extra = (openLinks || []).map((l: any) => String(l.request_id)).filter((id: string) => !set.has(id));
  await log({ direction: 'system', action: 'reconcile', ok: missing.length === 0, detail: { portal_open: set.size, linked: linked.size, missing: missing.length, closed_elsewhere: extra.length } });
  return { portal_open: set.size, linked: linked.size, missing_tickets: missing, closed_on_portal_still_open_here: extra };
}
async function bridgeHealth(b: any) {
  const ok = !!b.ok, now = new Date().toISOString(); const prev = await getState('health');
  await setState('health', { ok, loggedIn: !!b.loggedIn, pageOk: !!b.pageOk, at: now, error: b.error || null, pc: str(b.pc, 120), alerted: (prev as any).alerted || null });
  if (!ok) {
    await log({ direction: 'system', action: 'health', ok: false, error: str(b.error, 400), detail: { loggedIn: !!b.loggedIn, pageOk: !!b.pageOk } });
    const c = await config();
    const to = c.alertTo || ((await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)).data || []).map((p: any) => p.email).filter(Boolean).join('; ');
    if (to && (!(prev as any).alerted || Date.now() - Date.parse((prev as any).alerted) > 3600000)) {
      await setState('health', { ok, loggedIn: !!b.loggedIn, pageOk: !!b.pageOk, at: now, error: b.error || null, pc: str(b.pc, 120), alerted: now });
      const outId = 'out_portal_' + Date.now().toString(36) + rand(4);
      await db.from('outbox').insert({ id: outId, ticket: '', status: 'queued', job: { outId, ticket: '', to, cc: '', replyAll: false, subject: '[Portal bridge] health check failed', html: `<p>The portal bridge on the Outlook PC reported a problem: <b>${String(b.error || 'unknown').replace(/</g, '&lt;')}</b>.</p><p>Signed in: ${!!b.loggedIn}. Page structure OK: ${!!b.pageOk}. Check the bridge PC: Chrome signed in to the portal, the page layout unchanged, and the portal account valid.</p>`, replyToMid: '', attachments: [], attachmentNames: [], attachmentCids: [], mailbox: c.mailbox || 'Chronic@sarwa.life', queuedBy: 'Portal bridge', queuedAt: now, internal: true } });
    }
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const who = await caller(req);
    if (!who) return json({ error: 'Please sign in again.' }, 401);
    const c = await config();
    switch (body.action) {
      case 'status': await sweep(c).catch(() => null); return json({ ok: true, ...(await statusOf(c)) });
      case 'sweep': { if (!isAdmin(who)) return json({ error: 'Admin only' }, 403); return json({ ok: true, sweep: await sweep(c, true) }); }

      // every signed-in app (about every 2 minutes) and the scheduler: send what is queued, take in new requests when due.
      // In browser mode Supabase cannot reach the portal, so the bridge PC does all of it; the server only waits.
      case 'tick': {
        if (c.mode === 'off') return json({ ok: true, off: true, dryRun: c.dryRun !== false });
        await sweep(c).catch(() => null);   // stuck / timed-out replies are handled even while the bridge PC is down
        if (!serverReaches(c)) return json({ ok: true, browser: true, dryRun: c.dryRun !== false, liveAll: (c as any).liveAll === true, liveRequests: (c as any).liveRequests || [] });
        const out = c.dryRun !== false ? { dryRun: true } : await pushOut(c);   // dry run pauses OUT only; requests still come IN
        let inn: unknown = null; try { inn = await syncIn(c, false); } catch (e) { inn = { error: errMsg(e) }; }
        return json({ ok: true, out, in: inn, dryRun: c.dryRun !== false });
      }
      case 'push': { if (c.mode === 'off') return json({ error: 'The portal connection is off' }, 400); if (!serverReaches(c)) return json({ ok: true, browser: true }); if (c.dryRun !== false) return json({ ok: true, dryRun: true }); return json({ ok: true, out: await pushOut(c) }); }

      case 'retry': case 'cancel': {
        const { data: row } = await db.from('portal_outbox').select('*').eq('id', String(body.id || '')).maybeSingle();
        if (!row) return json({ error: 'Unknown job' }, 404);
        if (!['error', 'dead', 'conflict'].includes(row.status)) return json({ error: 'This job is ' + row.status }, 400);
        const actor = who.kind === 'user' ? who.name : 'Portal token';
        if (body.action === 'cancel') {
          await db.from('portal_outbox').update({ status: 'cancelled' }).eq('id', row.id);
          await insertEv(actor, 'portal.status', row.ticket, { jobId: row.id, status: 'cancelled' });
          await log({ direction: 'out', action: 'cancel', request_id: row.request_id, ticket: row.ticket, actor, detail: { job: row.id } });
          return json({ ok: true });
        }
        const { error } = await db.from('portal_outbox').update({ status: 'queued', attempts: 0, next_try_at: new Date().toISOString(), waiting_since: new Date().toISOString(), http_code: null, error: null }).eq('id', row.id);
        if (error) return json({ error: /portal_outbox_one_open/.test(error.message) ? 'Another decision for this ticket is already on its way' : error.message }, 400);
        await insertEv(actor, 'portal.status', row.ticket, { jobId: row.id, status: 'requeued' });
        await log({ direction: 'out', action: 'retry', request_id: row.request_id, ticket: row.ticket, actor, detail: { job: row.id, was: row.status } });
        const out = serverReaches(c) && c.dryRun === false ? await pushOut(c) : null;   // browser mode: the bridge PC picks it up
        return json({ ok: true, out });
      }

      case 'log': {
        const q = db.from('portal_sync_log').select('*').order('at', { ascending: false }).limit(Math.max(1, Math.min(500, +body.limit || 100)));
        const { data, error } = body.request_id ? await q.eq('request_id', String(body.request_id)) : body.failed ? await q.eq('ok', false) : await q;
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, rows: data });
      }
    }

    // ---- browser bridge (local worker on the Outlook bridge PC); portal token only ----
    if (typeof body.action === 'string' && body.action.startsWith('bridge_')) {
      if (who.kind !== 'token') return json({ error: 'Bridge token required' }, 403);
      switch (body.action) {
        case 'bridge_config': return json({ ok: true, mode: c.mode, active: c.mode === 'browser', dryRun: c.dryRun !== false, liveAll: (c as any).liveAll === true, liveRequests: (c as any).liveRequests || [], intervalMin: c.intervalMin, group: c.group, since: c.since, portalUrl: 'https://sl-portal.sarwa.insurance' });
        case 'bridge_jobs': {
          // only the current bridge may take replies: an old copy (or the old in-page agent) must not claim and drop them
          if (!(+body.bv >= BRIDGE_MIN_VERSION)) { await log({ direction: 'system', action: 'old_bridge_refused', ok: false, error: 'bridge version ' + (body.bv || 'none'), detail: { pc: str(body.pc, 80) } }); return json({ error: `This bridge copy is too old (version ${body.bv || 'none'}, needs ${BRIDGE_MIN_VERSION}). Update it with Install-PortalBridgeTask.ps1.` }, 426); }
          return json({ ok: true, jobs: c.mode === 'browser' ? await bridgeJobs(+body.limit || 5, body.id ? String(body.id) : undefined) : [] });
        }
        case 'bridge_peek': await sweep(c).catch(() => null); return json({ ok: true, jobs: c.mode === 'browser' ? await bridgePeek(+body.limit || 5) : [] });
        case 'bridge_unconfirmed': return json({ ok: true, jobs: c.mode === 'browser' ? await bridgeUnconfirmed(+body.limit || 2) : [] });
        case 'bridge_job_result': return json(await bridgeJobResult(body));
        case 'bridge_ingest': return json({ ok: true, ...(await bridgeIngest(body.requests || [], body.backfill === true)) });
        case 'bridge_rules': { const out = []; for (const id of (body.request_ids || []).slice(0, 50)) { const { data: l } = await db.from('portal_links').select('ticket').eq('request_id', String(id)).maybeSingle(); if (l) out.push({ request_id: String(id), ticket: l.ticket, ...(await runRules(l.ticket, String(id))) }); } return json({ ok: true, results: out }); }
        case 'bridge_reconcile': return json({ ok: true, ...(await bridgeReconcile(body.open_request_ids || [])) });
        case 'bridge_history': return json({ ok: true, ...(await bridgeHistory(body.rows || [])) });
        case 'bridge_health': return json(await bridgeHealth(body));
      }
      return json({ error: 'Unknown bridge action' }, 400);
    }

    // ---- admin only ----
    if (!isAdmin(who)) return json({ error: 'Only an admin can change the portal connection.' }, 403);
    const actor = who.kind === 'user' ? who.name : 'Portal token';
    switch (body.action) {
      case 'set_config': {
        const old = (await readSecret('portal')) || {};
        const mode = ['off', 'mock', 'live', 'browser'].includes(body.mode) ? body.mode : old.mode || 'off';
        // automation level per decision type: 1 automatic (only after the admin approved that rule), 2 prepared + one click, 3 manual
        const lv = (body.levels && typeof body.levels === 'object') ? Object.fromEntries(Object.keys(DEFAULT_LEVELS).map((k) => [k, [1, 2, 3].includes(+body.levels[k]) ? +body.levels[k] : (old.levels || {})[k] ?? DEFAULT_LEVELS[k]])) : old.levels;
        if (lv && lv.medical_team !== 3) lv.medical_team = 3;   // Refer to medical team is always manual
        const liveRequests = Array.isArray(body.liveRequests) ? body.liveRequests : typeof body.liveRequests === 'string' ? body.liveRequests.split(/[\s,;]+/) : old.liveRequests || [];
        const next = { ...old, mode, levels: lv, dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : old.dryRun !== false,
          liveRequests: [...new Set(liveRequests.map((x: unknown) => String(x).trim()).filter((x: string) => /^\d{1,12}$/.test(x)))].slice(0, 200),
          liveAll: typeof body.liveAll === 'boolean' ? body.liveAll : old.liveAll === true,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : old.baseUrl || '', tokenUrl: typeof body.tokenUrl === 'string' ? body.tokenUrl.trim() : old.tokenUrl || '',
          clientId: typeof body.clientId === 'string' ? body.clientId.trim() : old.clientId || '', clientSecret: body.clientSecret ? String(body.clientSecret) : old.clientSecret || '',
          intervalMin: Math.max(1, Math.min(60, +body.intervalMin || old.intervalMin || 5)), since: typeof body.since === 'string' ? body.since : old.since || '',
          fastRetry: (mode === 'mock' || mode === 'browser') ? !!body.fastRetry : false,
          group: typeof body.group === 'string' ? body.group : old.group || '', alertTo: typeof body.alertTo === 'string' ? body.alertTo : old.alertTo || '', mailbox: typeof body.mailbox === 'string' && body.mailbox ? body.mailbox : old.mailbox || 'Chronic@sarwa.life' };
        if (mode === 'live' && !/^https:\/\//.test(next.baseUrl)) return json({ error: 'The portal address must start with https://' }, 400);
        if (mode === 'mock') await mockSetup();
        await writeSecret('portal', next, who.kind === 'user' ? who.id : undefined);
        TOK.v = '';
        await log({ direction: 'system', action: 'set_config', actor, detail: { mode, baseUrl: next.baseUrl, intervalMin: next.intervalMin, dryRun: next.dryRun, levels: next.levels, liveRequests: next.liveRequests, liveAll: next.liveAll } });
        return json({ ok: true, ...(await statusOf(await config())) });
      }
      case 'rules_run': { const { data: l } = await db.from('portal_links').select('ticket,request_id').eq('ticket', String(body.ticket || '')).maybeSingle(); if (!l) return json({ error: 'Not a portal ticket' }, 400); return json({ ok: true, ...(await runRules(l.ticket, l.request_id)) }); }
      case 'test_connection': {
        if (c.mode === 'off') return json({ error: 'The connection is off' }, 400);
        if (c.mode === 'browser') { const h = await getState('health'); return json({ ok: true, browser: true, health: h, note: 'In browser mode the Outlook bridge PC reaches the portal, not Supabase. Its last health check is shown here.' }); }
        TOK.v = ''; await token(c);
        const j = await apiJson(c, `/requests?changed_since=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&limit=1&offset=0`);
        await log({ direction: 'system', action: 'test_connection', actor, detail: { items: (j.items || []).length } });
        return json({ ok: true, signedIn: true, sample: (j.items || []).length });
      }
      case 'sync_now': { if (c.mode === 'off') return json({ error: 'The connection is off' }, 400); if (!serverReaches(c)) return json({ ok: true, browser: true, note: 'The Outlook bridge PC runs the sync in browser mode.' }); const out = await pushOut(c); const inn = await syncIn(c, true); return json({ ok: true, out, in: inn }); }
      case 'reset_cursor': { await setState('cursor', { since: typeof body.since === 'string' && body.since ? body.since : null }); await log({ direction: 'system', action: 'reset_cursor', actor, detail: { since: body.since || null } }); return json({ ok: true }); }
      case 'new_token': {   // for a scheduler (or the test script): shown once, only the SHA-256 is kept
        const tok = 'chp_' + [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
        await writeSecret('portal_token', { hash: await sha256(tok), created: new Date().toISOString() });
        return json({ ok: true, token: tok });
      }
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: errMsg(e) }, e instanceof HttpErr && e.status >= 400 && e.status < 600 ? 502 : 500);
  }
});
