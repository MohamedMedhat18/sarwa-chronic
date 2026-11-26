// Outlook bridge + AI reader + history sync for the Sarwa Chronic helpdesk.
// The PC with Outlook (on-prem Chronic mailbox) uploads new emails (received AND sent from Outlook) here and collects replies to send.
// The same PC runs the Claude AI reader and the GlobeMed chronic history sync, and the attachment check (Outlook vs tickets).
// Authenticated with a bridge token (only its SHA-256 hash is stored in the database).
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = 'chronic';
const READABLE = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;
const IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const DRUG_EYE_SINCE = '2026-11-15T11:25:00Z';
const MED_COLS = 'member,med_code,med_desc,member_name,policy_holder,relation,diseases,status,qty,qty_type,daily,monthly,cov_start,cov_end,provider,first_dist,last_dist,months';
const PAGE = 1000;   // the database returns at most 1000 rows per request: always read in pages
// the real type of an attachment: some mail programs label pictures 'application/octet-stream' (e.g. CHR-000129's .jpeg files);
// then the file name decides
const EXT_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
const realMime = (a: { mime?: string; name?: string; path?: string }) => { const m = String(a.mime || '').toLowerCase(); if (m && !/^application\/(octet-stream|x-?unknown|unknown|download|binary|force-download)$/.test(m)) return m; const e = String(a.name || a.path || '').toLowerCase().split('.').pop() || ''; return EXT_MIME[e] || m; };

async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
const safe = (s: string) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120);
// storage key for a file name (plain ASCII, extension kept - Arabic names become "file.pdf"; the real name stays in the ticket)
const safeKey = (n: string) => { const s = String(n || 'file'); const m = s.match(/(\.[A-Za-z0-9]{1,6})$/); const ext = m ? m[1].toLowerCase() : ''; const base = (m ? s.slice(0, -m[1].length) : s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|_+$/g, '').slice(-70); return (base || 'file') + ext; };
const evId = (ts: string) => ts.replace(/\D/g, '').slice(0, 17) + '_' + rand(6);
const str = (v: unknown, n: number) => String(v ?? '').slice(0, n);
// recipient lists reported by the Outlook PC: [{ type: to|cc|bcc, email, name }]
const recipList = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 150).filter((r) => r && typeof r === 'object')
  .map((r: Record<string, unknown>) => ({ type: r.type === 'cc' ? 'cc' : r.type === 'bcc' ? 'bcc' : 'to', email: str(r.email, 300).toLowerCase().trim(), name: str(r.name, 300) }));
// attachment list of an email as Outlook sees it: [{ name, size, type, hidden, inline }]
const outAtts = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 100).filter((a) => a && typeof a === 'object')
  .map((a: Record<string, unknown>) => ({ name: str(a.name, 300), size: Math.max(0, +(a.size as number) || 0), type: +(a.type as number) || 1, hidden: !!a.hidden, inline: !!a.inline }));

type Att = { name?: string; mime?: string; path?: string; cls?: string; size?: number };
type Ev = { t: string; type: string; ts: string; atts?: Att[]; text?: string; subject?: string; member?: string; memberName?: string; fromEmail?: string; status?: string; items?: { src?: unknown }[] };

async function historyOf(member: string) {
  if (!/^\d{6,10}$/.test(member)) return [];
  const { data } = await db.from('member_meds').select(MED_COLS).eq('member', member).order('last_dist', { ascending: false }).limit(60);
  return data || [];
}

async function readerList(limit: number, days: number, only?: string) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // read ALL events of the period page by page (a single request stops at 1000 rows and then the newest tickets were never seen)
  const data: Ev[] = [];
  for (let from = 0; from < 100000; from += PAGE) {
    let q = db.from('events').select('t,type,ts,atts:d->atts,text:d->>text,subject:d->>subject,member:d->>member,memberName:d->>memberName,fromEmail:d->>fromEmail,status:d->>status,items:d->data->items')
      .in('type', ['ticket.create', 'msg.in', 'att.add', 'ai.read', 'ai.request', 'validation', 'merge', 'update']).not('t', 'is', null).order('ts').order('id').range(from, from + PAGE - 1);
    if (only) q = q.eq('t', only); else q = q.gte('ts', since);
    const { data: page, error } = await q;
    if (error) throw new Error(error.message);
    data.push(...((page || []) as Ev[]));
    if (!page || page.length < PAGE) break;
  }
  type T0 = { no: string; subject: string; member: string; memberName: string; created: string; msgs: Ev[]; lastRead: string; readNoEye: boolean; lastReq: string; lastVal: string; lastIn: string; hasImage: boolean; closed: boolean };
  const T = new Map<string, T0>();
  for (const e of data) {
    if (e.type === 'ticket.create') { T.set(e.t, { no: e.t, subject: e.subject || '', member: e.member || '', memberName: e.memberName || '', created: e.ts, msgs: [], lastRead: '', readNoEye: false, lastReq: '', lastVal: '', lastIn: '', hasImage: false, closed: false }); continue; }
    const t = T.get(e.t); if (!t) continue;
    if (e.type === 'msg.in' || e.type === 'att.add') {   // att.add: an attachment recovered from Outlook later - read like a new file
      t.msgs.push(e);
      if ((e.atts || []).some((a) => a.cls === 'readable' && READABLE.test(realMime(a)))) t.lastIn = e.ts;
      if ((e.atts || []).some((a) => a.cls === 'readable' && IMAGE.test(realMime(a)))) t.hasImage = true;
    }
    else if (e.type === 'ai.read') { t.lastRead = e.ts; const it = Array.isArray(e.items) ? e.items : []; t.readNoEye = it.length > 0 && !it.some((x) => x && x.src) && e.ts < DRUG_EYE_SINCE; }
    else if (e.type === 'ai.request') t.lastReq = e.ts;
    else if (e.type === 'validation') t.lastVal = e.ts;
    else if (e.type === 'merge') t.closed = true;
    else if (e.type === 'update' && (e.status === 'Closed' || e.status === 'Resolved')) t.closed = true;
    else if (e.type === 'update' && e.status) t.closed = false;
    else if (e.type === 'update' && e.member) t.member = e.member;
  }
  const requested = (t: T0) => !!t.lastReq && t.lastReq > t.lastRead;
  const fresh = (t: T0) => !t.closed && t.lastIn > t.lastRead && t.lastIn > t.lastVal;
  const backfill = (t: T0) => !t.closed && !t.lastVal && t.readNoEye && t.hasImage;
  const rank = (t: T0) => requested(t) ? 3 : fresh(t) ? 2 : backfill(t) ? 1 : 0;
  const todo = [...T.values()]
    .filter((t) => t.lastIn && (only ? true : rank(t) > 0))
    .sort((a, b) => (rank(b) - rank(a)) || (a.lastIn < b.lastIn ? 1 : a.lastIn > b.lastIn ? -1 : 0))
    .slice(0, limit);
  const out = [];
  for (const t of todo) {
    const files: { path: string; mime: string; name: string }[] = [];
    for (const m of t.msgs) for (const a of m.atts || []) { const mime = realMime(a); if (a.cls === 'readable' && READABLE.test(mime) && a.path && (a.size || 0) <= 15 * 1048576 && files.length < 15) files.push({ path: a.path, mime, name: a.name || a.path.split('/').pop()! }); }
    const { data: su } = files.length ? await db.storage.from(BUCKET).createSignedUrls(files.map((f) => f.path), 1800) : { data: [] };
    out.push({
      ticket: t.no, subject: t.subject, member: t.member, memberName: t.memberName, created: t.created, alreadyRead: !!t.lastRead, requested: requested(t), drugEyeCatchUp: rank(t) === 1,
      emails: t.msgs.filter((m) => m.type === 'msg.in').map((m) => ({ at: m.ts, from: m.fromEmail || '', subject: m.subject || '', text: String(m.text || '').slice(0, 4000) })),
      files: files.map((f, i) => ({ ...f, url: (su || [])[i]?.signedUrl || '' })),
      history: await historyOf(t.member),
    });
  }
  return out;
}

// what the agents corrected / confirmed, plus the corrections that repeat, as ranked rules for the reader;
// also the team's own medicine decisions (not covered, acute, ...) with their wording, and examples of replies the team sent
async function learnings(n: number) {
  const { data } = await db.from('events').select('t,ts,d').eq('type', 'ai.learn').order('ts', { ascending: false }).limit(Math.min(n, PAGE));
  const recent: Record<string, unknown>[] = [];
  const names = new Map<string, number>(), decs = new Map<string, number>(), doses = new Map<string, number>(), classes = new Map<string, number>();
  const up = (s: unknown) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
  for (const e of data || []) for (const it of (e.d?.items || [])) {
    recent.push({ ticket: e.t, at: e.ts, ...it, src: undefined });
    const ch: string[] = Array.isArray(it.changed) ? it.changed : [];
    if (ch.includes('name') && it.read && it.correct) add(names, `"${up(it.read)}" is "${up(it.correct)}"` + (it.sender ? ` (sender ${it.sender})` : ''));
    if (ch.includes('cls')) add(classes, `"${up(it.correct)}" is class ${it.cls}`);
    if (ch.some((c) => ['dose', 'unit', 'times', 'per'].includes(c))) add(doses, `"${up(it.correct)}": the form meant ${it.dose} ${it.unit} x ${it.times} per ${it.per}`);
    if (it.aiDecision && it.finalDecision && it.aiDecision !== it.finalDecision) add(decs, `class ${it.cls || 'other'}: you said ${it.aiDecision}, agents decided ${it.finalDecision}`);
  }
  const { data: vals } = await db.from('events').select('t,ts,actor,result:d->result,diagnosis:d->>diagnosis').eq('type', 'validation').order('ts', { ascending: false }).limit(PAGE);
  const meds = new Map<string, { rule: string; count: number }>();
  for (const v of (vals || []) as Record<string, unknown>[]) for (const x of (Array.isArray(v.result) ? v.result as Record<string, unknown>[] : [])) {
    if (!x || !x.name || !['NOT_COVERED', 'NOT_COVERED_DX', 'ACUTE', 'ALTERNATIVE', 'NOT_JUSTIFIED'].includes(String(x.final))) continue;
    const key = up(x.name).split(' ').slice(0, 2).join(' ') + '|' + x.final;
    const cur = meds.get(key);
    if (cur) { cur.count++; continue; }
    const dx = x.final === 'NOT_COVERED_DX' || x.final === 'NOT_JUSTIFIED' ? ` (diagnosis: ${String(v.diagnosis || '').slice(0, 80)})` : '';
    meds.set(key, { rule: `"${up(x.name)}" -> ${x.final}${x.reason ? `, reason written by the team: "${String(x.reason).slice(0, 160)}"` : ''}${dx} [${v.t}]`, count: 1 });
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([rule, count]) => ({ rule, count }));
  const { data: outs } = await db.from('events').select('t,ts,actor,text:d->>text,html:d->>html,outlook:d->>outlook,auto:d->>auto').eq('type', 'msg.out').order('ts', { ascending: false }).limit(200);
  const strip = (h: string) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|tr|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const replies = ((outs || []) as Record<string, string>[]).filter((o) => o.auto !== 'true')
    .map((o) => ({ ticket: o.t, at: o.ts, by: o.actor, outlook: o.outlook === 'true', text: (o.text || strip(o.html)).split(/\n?(?:From:|-----Original Message|____________)/)[0].slice(0, 2500) }))
    .filter((r) => r.text.length > 60).slice(0, 40);
  return { recent: recent.slice(0, 300), rules: { names: top(names), classes: top(classes), doses: top(doses), decisions: top(decs), medicines: [...meds.values()].sort((a, b) => b.count - a.count).slice(0, 120) }, replies };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = req.headers.get('x-bridge-token') || '';
  if (!token.startsWith('chb_')) return json({ error: 'Missing bridge token' }, 401);
  const { data: tok } = await db.from('bridge_tokens').select('id').eq('token_hash', await sha256(token)).neq('label', 'setup').maybeSingle();
  if (!tok) return json({ error: 'Invalid bridge token' }, 401);
  db.from('bridge_tokens').update({ last_used: new Date().toISOString() }).eq('id', tok.id).then(() => {});

  try {
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'ping':
        return json({ ok: true });

      case 'upload': {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : new Date().toISOString().slice(0, 10);
        const path = `inbox/${day}/${safe(body.name) || rand(10) + '.msg'}`;
        const { data: ex } = await db.from('mail_inbox').select('id').eq('path', path).maybeSingle();
        if (ex) return json({ ok: true, exists: true, path });
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, path, signedUrl: data.signedUrl });
      }

      case 'mail_add': {
        if (!/^inbox\//.test(String(body.path || ''))) return json({ error: 'bad path' }, 400);
        const m = body.meta && typeof body.meta === 'object' ? body.meta : {};
        // toAddr / ccAddr: the real addresses ("Name <a@b.c>; ...") - Outlook's To / Cc text holds display names only
        // atts: the attachments as Outlook lists them - the app compares them with what it saved (attachment check)
        const meta: Record<string, unknown> = { conv: str(m.conv, 200), inReplyTo: str(m.inReplyTo, 1000), refs: str(m.refs, 4000), mid: str(m.mid, 1000), to: str(m.to, 2000), cc: str(m.cc, 2000), sender: str(m.sender, 300), folder: str(m.folder, 200), toAddr: str(m.toAddr, 6000), ccAddr: str(m.ccAddr, 6000), fromName: str(m.fromName, 300) };
        if (Array.isArray(m.atts)) meta.atts = outAtts(m.atts);
        const { error } = await db.from('mail_inbox').upsert({
          path: body.path, received_at: body.received_at || null, subject: str(body.subject, 500), from_email: str(body.from_email, 300),
          direction: body.direction === 'out' ? 'out' : 'in', meta,
        }, { onConflict: 'path', ignoreDuplicates: true });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case 'outbox_list': {
        const { data, error } = await db.from('outbox').select('id,ticket,job,created_at').eq('status', 'queued').order('created_at').limit(25);
        if (error) return json({ error: error.message }, 400);
        const out = [];
        for (const r of data || []) {
          const paths: string[] = (r.job?.attachments || []).filter(Boolean);
          let files: { path: string; name: string; url: string }[] = [];
          if (paths.length) {
            const { data: su } = await db.storage.from(BUCKET).createSignedUrls(paths, 900);
            files = (su || []).map((s, i) => ({ path: paths[i], name: (r.job?.attachmentNames || [])[i] || paths[i].split('/').pop()!, url: s.signedUrl || '' }));
          }
          out.push({ id: r.id, ticket: r.ticket, job: r.job, files, created_at: r.created_at });
        }
        return json({ ok: true, jobs: out });
      }

      case 'outbox_done': {
        const id = String(body.id || '');
        const status = ['sent', 'draft', 'error'].includes(body.status) ? body.status : 'error';
        const { data: row } = await db.from('outbox').select('id,ticket,status').eq('id', id).maybeSingle();
        if (!row) return json({ error: 'unknown outbox id' }, 404);
        if (row.status === 'queued') {
          await db.from('outbox').update({ status, error: body.error || null, sent_at: new Date().toISOString() }).eq('id', id);
          const ts = new Date().toISOString();
          const d: Record<string, unknown> = { outId: id, status, sentAt: ts, threaded: !!body.threaded };
          if (body.error) d.error = String(body.error).slice(0, 1000);
          if (body.mid) d.mid = str(body.mid, 1000);
          if (body.conv) d.conv = str(body.conv, 200);
          // post-send check: who really received it, who Reply All should have reached, and who is missing
          if (Array.isArray(body.recips)) d.recips = recipList(body.recips);
          if (Array.isArray(body.expected)) d.expected = recipList(body.expected);
          if (Array.isArray(body.missing)) d.missing = recipList(body.missing);
          await db.from('events').insert({ id: evId(ts), ts, actor: 'Outlook (' + safe(body.pc || 'bridge') + ')', pc: 'outlook-bridge', type: 'out.status', t: row.ticket, d });
        }
        return json({ ok: true });
      }

      // ---- attachment check: Outlook (the source) vs what each ticket holds ----
      case 'att_audit_list': {   // every incoming email of the period with the files its ticket holds (also files recovered later)
        const since = new Date(Date.now() - Math.max(1, Math.min(400, +body.days || 30)) * 86400000).toISOString();
        const rows: Record<string, unknown>[] = [];
        for (let from = 0; from < 200000; from += PAGE) {
          const { data: page, error } = await db.from('events').select('id,t,ts,type,key:d->>key,mid:d->>mid,msg:d->>msg,atts:d->atts,historical:d->>historical')
            .in('type', ['msg.in', 'att.add']).not('t', 'is', null).gte('ts', since).order('ts').order('id').range(from, from + PAGE - 1);
          if (error) return json({ error: error.message }, 400);
          rows.push(...(page || [])); if (!page || page.length < PAGE) break;
        }
        const msgs = new Map<string, { id: string; t: string; ts: string; key: string; mid: string; historical: boolean; files: { name: string; size: number; hidden: boolean; failed: boolean }[] }>();
        const fl = (a: Record<string, unknown>) => ({ name: str(a.name, 300), size: +(a.size as number) || 0, hidden: !!a.hidden || a.cls === 'ignore', failed: !!a.failed || !a.path });
        for (const r of rows) {
          const atts = (Array.isArray(r.atts) ? r.atts : []) as Record<string, unknown>[];
          if (r.type === 'msg.in') msgs.set(String(r.id), { id: String(r.id), t: String(r.t), ts: String(r.ts), key: String(r.key || ''), mid: String(r.mid || ''), historical: r.historical === 'true', files: atts.map(fl) });
          else { const m = msgs.get(String(r.msg || '')); if (m) m.files.push(...atts.map(fl)); }
        }
        return json({ ok: true, msgs: [...msgs.values()] });
      }

      case 'att_upload': {   // signed upload for a file recovered from Outlook, into the ticket's own folder
        const t = String(body.ticket || ''); if (!/^CHR-\d{6}$/.test(t)) return json({ error: 'bad ticket' }, 400);
        const path = `hd/files/${t}/${rand(5)}_${safeKey(body.name)}`;
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, path, signedUrl: data.signedUrl });
      }

      case 'att_add': {   // files recovered from Outlook, added to their email in the ticket (event att.add)
        const t = String(body.ticket || ''); if (!/^CHR-\d{6}$/.test(t)) return json({ error: 'bad ticket' }, 400);
        const msg = str(body.msg, 80); if (!msg) return json({ error: 'no email' }, 400);
        const atts = (Array.isArray(body.atts) ? body.atts : []).slice(0, 50).filter((a: Record<string, unknown>) => a && String(a.path || '').startsWith(`hd/files/${t}/`))
          .map((a: Record<string, unknown>) => ({ name: str(a.name, 300), mime: str(a.mime, 120), size: +(a.size as number) || 0, path: str(a.path, 400), cls: ['readable', 'unreadable', 'ignore'].includes(String(a.cls)) ? a.cls : 'unreadable', why: str(a.why, 200), inline: !!a.inline, hidden: !!a.hidden, via: 'recovered from Outlook' }));
        if (!atts.length) return json({ error: 'no files' }, 400);
        const ts = new Date().toISOString();
        const { error } = await db.from('events').insert({ id: evId(ts), ts, actor: 'Outlook (' + safe(body.pc || 'bridge') + ')', pc: 'outlook-bridge', type: 'att.add', t, d: { msg, mid: str(body.mid, 1000), atts, source: str(body.source, 60) || 'attachment check' } });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, n: atts.length });
      }

      case 'att_check': {   // an email whose files could not all be recovered: alert on the ticket (event att.check)
        const t = String(body.ticket || ''); if (!/^CHR-\d{6}$/.test(t)) return json({ error: 'bad ticket' }, 400);
        const ts = new Date().toISOString();
        const { error } = await db.from('events').insert({ id: evId(ts), ts, actor: 'Outlook (' + safe(body.pc || 'bridge') + ')', pc: 'outlook-bridge', type: 'att.check', t, d: { msg: str(body.msg, 80), mid: str(body.mid, 1000), outlook: outAtts(body.outlook), missing: outAtts(body.missing), why: str(body.why, 300) } });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case 'reader_list': {
        const limit = Math.max(1, Math.min(10, +body.limit || 5));
        const tickets = await readerList(limit, Math.max(1, Math.min(60, +body.days || 14)), /^CHR-\d{6}$/.test(body.ticket || '') ? body.ticket : undefined);
        const L = tickets.length ? await learnings(2000) : { recent: [], rules: {}, replies: [] };
        return json({ ok: true, tickets, learnings: L.recent, rules: L.rules, replies: L.replies });
      }

      case 'catalog_list': { // GlobeMed medicine names (as dispensed) for the reader
        const out: { med_desc: string; members: number }[] = [];
        for (let from = 0; from < 20000; from += 1000) {
          const { data, error } = await db.from('med_catalog').select('med_desc,members').order('members', { ascending: false }).range(from, from + 999);
          if (error) return json({ error: error.message }, 400);
          out.push(...(data || [])); if (!data || data.length < 1000) break;
        }
        return json({ ok: true, medicines: out });
      }

      case 'reader_history': {
        return json({ ok: true, history: await historyOf(String(body.member || '')) });
      }

      case 'reader_save': {
        const t = String(body.ticket || '');
        if (!/^CHR-\d{6}$/.test(t)) return json({ error: 'bad ticket' }, 400);
        const data = body.data && typeof body.data === 'object' ? body.data : null;
        if (!data && !body.error) return json({ error: 'no data' }, 400);
        const ts = new Date().toISOString();
        const d = { reader: 'Claude AI reader', files: +body.files || 0, data, error: body.error ? String(body.error).slice(0, 500) : '', notes: String(body.notes || '').slice(0, 2000) };
        const { error } = await db.from('events').insert({ id: evId(ts), ts, actor: 'Claude (AI reader)', pc: 'ai-reader', type: 'ai.read', t, d });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case 'history_upsert': {
        const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
        const clean = rows.filter((r: Record<string, unknown>) => r && /^\d{4,12}$/.test(String(r.member || '')) && r.med_code).map((r: Record<string, unknown>) => ({ ...r, updated_at: new Date().toISOString() }));
        if (!clean.length) return json({ ok: true, n: 0 });
        const { error } = await db.from('member_meds').upsert(clean, { onConflict: 'member,med_code' });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, n: clean.length });
      }

      case 'history_stats': {
        // an exact count of ~300,000 lines can pass the 8-second limit: use the planner's estimate
        const { count } = await db.from('member_meds').select('member', { count: 'estimated', head: true });
        return json({ ok: true, rows: count || 0 });
      }

      case 'catalog_refresh': {
        // two separate requests: each request through the API may take at most 8 seconds
        const { data, error } = await db.rpc('refresh_med_catalog');
        if (error) return json({ error: error.message }, 400);
        const { data: holders, error: e2 } = await db.rpc('refresh_holder_days');
        if (e2) return json({ ok: true, medicines: data, holdersError: e2.message });
        return json({ ok: true, medicines: data, holders });
      }
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
