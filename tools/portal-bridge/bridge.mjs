// Sarwa Chronic - portal bridge (no IT). Runs on the Outlook bridge PC, inside the Sarwa network.
// Supabase cannot reach the portal, so this worker drives the real portal screens in Chrome:
//   IN : Chronic Attach report + Request Timeline (page 172) + Broker Attachments (page 170) -> bridge_ingest
//   OUT: the agent's decision -> Actions (page 173) > Reply (page 168): Language, Status (the portal writes its template),
//        our text into the #comment# slot, files into the upload box, Save -> RE-READ the Request Timeline -> bridge_job_result.
//        A ticket closes / goes Pending only after that confirmation.
// Calibrated on TEST request 38218 (21 Nov 2026). Opening Reply / Broker Attachment / Sarwa Attachment was verified to
// change nothing (status, assignee and timeline unchanged); only Save on page 168 writes.
//
// Safety (enforced here):
//   - Writes need DRY_RUN=0 AND the request id in LIVE_WRITE_ALLOW. Otherwise: PREVIEW only - the form is opened, the
//     portal's real template is filled in, the exact final text is saved to previews\<job>.json, then Cancel. Nothing saved.
//   - Before Save the timeline is re-read: our reply already there (earlier attempt) -> confirmed, never sent twice.
//     A final status set by someone else -> conflict, never overwritten.
//   - One request at a time, pauses between actions, kill switch (Settings > Portal = Off) checked every cycle.
//   - Captcha / second factor / failed login -> stop + health alert; no retry loop.
//   - Credentials only in this process's environment (from Start-PortalBridge.ps1 / DPAPI). Never logged or sent anywhere.
//   - Never types a portal URL: APEX signs the user out for links without the session. Navigation is by clicking.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const SB = (env.SUPABASE_URL || '').replace(/\/$/, '');
const TOKEN = env.PORTAL_TOKEN || '';
const USER = env.PORTAL_USER || '', PASS = env.PORTAL_PASS || '';
const DATA = env.BRIDGE_DIR || join(env.LOCALAPPDATA || '.', 'ChronicPortalBridge');
const DRY = env.DRY_RUN !== '0';
const ALLOW = new Set((env.LIVE_WRITE_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean));
const TZ = env.PORTAL_TZ || '+02:00';
const HEADLESS = env.HEADLESS === '1';
const PORTAL = 'https://sl-portal.sarwa.insurance';
const LOGIN = PORTAL + '/ords/r/sl_ws/login-application/login';
const STATUS = { Assigned: 1, Processing: 2, Pending: 3, Closed: 4, Approved: 5, Partially_Approved_Pending: 6, 'Partially Approved Pending': 6, Partially_Approved_Rejected: 7, 'Partially Approved Rejected': 7, Rejected: 8, Reopened: 9 };
const FINAL = new Set([4, 5, 7, 8]);
const EXPECTED_HEADERS = ['Request Id', 'Individual Name', 'Chronic Status Name', 'Creation User', 'Cr Type', 'Creation Date'];
const MAX_FILE = 20 * 1048576;
mkdirSync(join(DATA, 'previews'), { recursive: true });
const MAP = JSON.parse(readFileSync(existsSync(join(DATA, 'reply-map.json')) ? join(DATA, 'reply-map.json') : new URL('./reply-map.json', import.meta.url), 'utf8'));
const F = MAP.form;
const STATE_FILE = join(DATA, 'state.json');      // per request: timeline fingerprint, attachment ids already sent, our timeline entries
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
const st = (id) => (state[id] ||= { tl: '', files: [], mine: [] });

class Blocked extends Error {}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const pause = (min = 1500, max = 3500) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function iso(dmy) {
  const m = String(dmy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  const [, d, mo, y, h = '00', mi = '00'] = m;
  return new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00${TZ}`).toISOString();
}
async function call(action, body = {}) {
  const r = await fetch(SB + '/functions/v1/portal', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': TOKEN }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${action}: ${j.error || r.status}`);
  return j;
}

// ---------------- session and navigation ----------------
async function frameWith(page, selector) { for (const f of page.frames()) { try { if (await f.locator(selector).count()) return f; } catch { } } return null; }
async function blockedOn(f) {
  const html = (await f.content()).toLowerCase();
  return /captcha|recaptcha|hcaptcha/.test(html) ? 'captcha' : /one[- ]time|otp|authenticator|verification code|two[- ]factor/.test(html) ? 'second factor' : '';
}
async function ensureLoggedIn(page) {
  if (await page.getByRole('link', { name: 'Claims' }).count().catch(() => 0)) return;
  if (await page.locator('#my_ir').count().catch(() => 0)) return;
  if (!(await frameWith(page, 'input[type=password]'))) await page.goto(LOGIN, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  if (await page.getByRole('link', { name: 'Claims' }).count().catch(() => 0)) return;
  const f = await frameWith(page, 'input[type=password]');
  if (!f) throw new Error('login page not recognised (page structure changed?)');
  const b = await blockedOn(f); if (b) throw new Blocked(`the login page asks for a ${b} - automation stopped`);
  if (!USER || !PASS) throw new Blocked('no portal account on this PC - run Set-PortalCredential.ps1');
  await f.locator('input[type=text], input:not([type])').first().fill(USER);
  await f.locator('input[type=password]').first().fill(PASS);
  await f.getByRole('button', { name: /sign in/i }).click();
  await page.waitForLoadState('networkidle').catch(() => { }); await page.waitForTimeout(2500);
  const f2 = await frameWith(page, 'input[type=password]');
  if (f2) { const b2 = await blockedOn(f2); throw b2 ? new Blocked(`a ${b2} appeared after sign-in - automation stopped`) : new Blocked('sign-in failed (wrong password or locked account) - not retried'); }
}
async function openChronicAttach(page) {
  await ensureLoggedIn(page);
  await closeDialogs(page);
  if (/\/chronic-attach/.test(page.url())) await page.reload({ waitUntil: 'networkidle' });
  else {
    if (!/medical-claims2009/.test(page.url())) { await page.getByRole('link', { name: 'Claims' }).first().click(); await page.waitForLoadState('networkidle'); await pause(); }
    const link = page.locator('a[href*="/chronic-attach"]').first();
    if (!(await link.count())) throw new Error('Chronic Attach link not found in the Claims menu (page structure changed?)');
    await link.click(); await page.waitForLoadState('networkidle');
  }
  if (await frameWith(page, 'input[type=password]')) { await ensureLoggedIn(page); return openChronicAttach(page); }   // session expired
  await page.locator('#my_ir').waitFor({ timeout: 30000 });
}
// APEX opens dialogs as iframes; find the one showing a given page number
async function frameForPage(page, pageId, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of page.frames()) { try { if (await f.$eval('#pFlowStepId', (e) => e.value) === pageId) return f; } catch { } }
    await page.waitForTimeout(400);
  }
  throw new Error(`portal page ${pageId} did not open (page structure changed?)`);
}
async function closeDialogs(page) {
  for (let i = 0; i < 5; i++) { const x = page.locator('.ui-dialog:visible .ui-dialog-titlebar-close'); if (!(await x.count())) break; await x.last().click(); await page.waitForTimeout(700); }
}
async function openDrawer(page, requestId) {
  await closeDialogs(page);
  const h = await page.evaluateHandle((id) => [...document.querySelectorAll('#my_ir a')].find((a) => new RegExp('p173_chronic_id=' + id + '(?!\\d)').test(a.getAttribute('href') || '')), String(requestId));
  const el = h.asElement(); if (!el) throw new Error('Actions link for request ' + requestId + ' not found');
  await el.click();
  const f = await frameForPage(page, MAP.drawer.page);
  const shown = await f.$eval('#P173_CHRONIC_ID', (e) => e.value);
  if (shown !== String(requestId)) throw new Error(`the Actions drawer opened for ${shown}, not ${requestId} - stopped`);
  return f;
}

// ---------------- reading ----------------
// APEX interactive report rows. The header cells repeated above each group are hidden copies with empty visible text,
// so cells are mapped by their `headers` attribute and names are read with textContent.
const IR_ROWS = (root) => {
  const name = {}; for (const el of root.querySelectorAll('[id]')) { const t = el.textContent.trim(); if (/^[CB]\d/.test(el.id) && t && !name[el.id]) name[el.id] = t; }
  const rows = [];
  for (const tr of root.querySelectorAll('.a-IRR-table tr')) {
    const tds = [...tr.querySelectorAll('td[headers]')]; if (!tds.length) continue;
    const o = {};
    for (const td of tds) {
      const [col, grp] = (td.getAttribute('headers') || '').split(/\s+/);
      if (name[col]) o[name[col]] = td.innerText.trim();
      if (grp && name[grp]) o._indiv = name[grp].replace(/^Individual Number:\s*/i, '');
      const a = td.querySelector('a[href*="get_blob"]'); if (a) { o._blob = a.href; o._fileId = (a.href.match(/[?&]k1=([^&]+)/) || [])[1] || ''; }
    }
    if (Object.keys(o).length) rows.push(o);
  }
  return rows;
};
async function readReport(page) {
  const out = [];
  for (let n = 0; n < 50; n++) {
    out.push(...(await page.locator('#my_ir').evaluate(IR_ROWS)).filter((r) => r['Request Id']));
    const next = page.locator('#my_ir .a-IRR-pagination button[aria-label*="Next"], #my_ir .a-IRR-button--paginationNext');
    if (!(await next.count()) || await next.first().isDisabled().catch(() => true)) break;
    await next.first().click(); await page.waitForLoadState('networkidle'); await pause();
  }
  return out;
}
async function reportCount(page) {
  const t = await page.locator('#my_ir .a-IRR-pagination').first().innerText().catch(() => '');
  const m = t.match(/(\d+)\s*-\s*(\d+)(?:\s*of\s*(\d+))?/); return m ? +(m[3] || m[2]) : null;
}
async function readTimeline(page, requestId) {
  await closeDialogs(page);
  await page.locator('#my_ir a', { hasText: new RegExp('^' + requestId + '$') }).first().click();   // Request Timeline (read only)
  const f = await frameForPage(page, '172');
  await f.locator('.a-IRR-table').first().waitFor({ timeout: 20000 });
  const rows = (await f.locator('body').evaluate(IR_ROWS)).filter((r) => r['Chronic Status Name'] || r['Creation Date']);
  await closeDialogs(page); await pause(600, 1200);
  return rows;
}
// Broker Attachments (page 170): the member's / broker's files, each with a download link carrying a stable file id (k1).
// Files not sent to Sarwa Chronic before are fetched inside the signed-in page and passed on as base64.
async function readAttachments(page, requestId) {
  const s = st(requestId); const out = [];
  const drawer = await openDrawer(page, requestId);
  await drawer.getByRole('button', { name: MAP.drawer.brokerAttachmentButton }).click();
  const f = await frameForPage(page, MAP.attachments.brokerPage);
  await f.locator('body').waitFor();
  for (const r of await f.locator('body').evaluate(IR_ROWS)) {
    if (!r._fileId) continue;
    const id = 'b-' + r._fileId, a = { id, file_name: r['File Name'] || ('file-' + r._fileId), source: 'Broker', uploaded_at: iso(r['Creation Date']) };
    if (!s.files.includes(id)) {
      const got = await f.evaluate(async (href) => { const res = await fetch(href, { credentials: 'include' }); const b = new Uint8Array(await res.arrayBuffer()); if (b.length > 20 * 1048576) return { size: b.length };
        let x = ''; for (let i = 0; i < b.length; i += 0x8000) x += String.fromCharCode(...b.subarray(i, i + 0x8000)); return { b64: btoa(x), type: res.headers.get('content-type') || '', size: b.length }; }, r._blob);
      if (got.b64 && got.size <= MAX_FILE) { a.content_base64 = got.b64; a.mime_type = got.type; }
      a.size = got.size;
    }
    out.push(a);
  }
  await closeDialogs(page); await pause(600, 1200);
  return out;
}

// Who wrote a timeline entry: proved on 38218 (21 Nov 2026) that "Creation User" is ALWAYS the requester's number, even
// on a reply saved by staff. Staff replies carry the portal's template text; the requester's own entries have no comment.
const STAFF_TEXT = /تحية طيبة من شركة ثروة|Greetings from Sarwa Life/i;
const tlId = (requestId, r) => 'tl-' + sha([requestId, r['Chronic Status Name'], norm(r['Chronic Comment']), norm(r['Extra Comment']), r['Creation User'], r['Creation Date']].join('|')).slice(0, 20);
function toRequest(row, tl, atts) {
  const id = row['Request Id']; const creator = row['Creation User'] || ''; const brokerMail = row['Broker Mail'] || '';
  const mine = new Set(st(id).mine);
  const timeline = tl.map((r) => {
    const tid = tlId(id, r);
    const actor = mine.has(tid) ? 'integration' : STAFF_TEXT.test(r['Chronic Comment'] || '') ? 'staff' : 'requester';
    // "Creation User" names the requester on every row, so it is passed on only for the requester's own entries
    return { id: tid, status_name: r['Chronic Status Name'], status_code: STATUS[r['Chronic Status Name']] ?? null, comment: r['Chronic Comment'] || '', extra_comment: r['Extra Comment'] || '', by: actor === 'requester' ? (r['Creation User'] || '') : (actor === 'integration' ? 'sarwa-chronic' : 'portal staff'), actor_type: actor, at: iso(r['Creation Date']) };
  });
  const dates = [iso(row['Creation Date']), ...timeline.map((t) => t.at), ...atts.map((a) => a.uploaded_at)].filter(Boolean).sort();
  return {
    request_id: id, individual_number: row._indiv, individual_name: row['Individual Name'], mobile: /^\d{8,15}$/.test(creator) ? creator : '', creation_user: creator,
    channel: row['Cr Type'], contract_no: row['Contract no'] || row['Contract No'] || '', policy_holder: row['Policy Holder'] || '', policy_holder_name: row['Policy Holder Name'] || '',
    broker: row['Broker'] || '', broker_mail: brokerMail, cc: [], status_name: row['Chronic Status Name'], status_code: STATUS[row['Chronic Status Name']] ?? 3,
    chronic_date: iso(row['Chronic Date']).slice(0, 10), assign_to: row['Assign To'] || '', creation_date: iso(row['Creation Date']), last_update: dates.pop() || '',
    timeline, attachments: atts,
  };
}

// ---------------- writing ----------------
// our text goes into the portal template's #comment# slot; the Approved template has none (a note goes above the closing line)
function compose(template, core) {
  if (!template) return core || '';
  if (template.includes('#comment#')) return template.replace('#comment#', core || '');
  if (!core) return template;
  const lines = template.split('\n'); lines.splice(lines.length - 1, 0, core, ''); return lines.join('\n');
}
const coreOf = (job) => norm(job.message) ? String(job.message).trim() : (job.missing || []).length ? job.missing.map((x) => '- ' + x).join('\n') : (job.reason || '');
function statusFor(job, currentCode) {
  const want = job.status_code != null ? String(job.status_code) : String(currentCode);   // Message keeps the current status
  return MAP.statusesTheFormAccepts.includes(want) ? want : '3';
}
// fill the Reply form; returns the exact text and files. Saves only when `save` is true, otherwise Cancel.
async function fillReply(page, job, currentCode, save) {
  const drawer = await openDrawer(page, job.request_id);
  await drawer.getByRole('button', { name: MAP.drawer.replyButton }).click();
  const f = await frameForPage(page, F.page);
  if (await f.$eval('#' + F.requestIdItem, (e) => e.value) !== String(job.request_id)) throw new Error('Reply form opened for another request - stopped');
  const lang = job.lang === 'EN' ? 'EN' : 'AR', status = statusFor(job, currentCode);
  await f.evaluate(([it, v]) => apex.item(it).setValue(v), [F.language, lang]); await page.waitForTimeout(1500);
  await f.evaluate(([it, v]) => apex.item(it).setValue(v), [F.status, status]);
  let template = '';
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(400); template = await f.$eval('#' + F.comment, (e) => e.value); if (template) break; }   // the portal writes its template
  const text = compose(template, coreOf(job));
  await f.evaluate(([it, v]) => apex.item(it).setValue(v), [F.comment, text]);
  const files = [];
  for (const x of job.files || []) { const r = await fetch(x.url); const p = join(DATA, 'previews', `${job.id}-${x.name}`); writeFileSync(p, Buffer.from(await r.arrayBuffer())); files.push(p); }
  if (files.length) { await f.locator(F.fileInput).first().setInputFiles(files); await page.waitForTimeout(1500 + 500 * files.length); }
  if (!save) { await f.getByRole('button', { name: F.cancelButton }).click(); await closeDialogs(page); return { status, lang, text, files: (job.files || []).map((x) => x.name), template }; }
  // Save exactly as the page's own Save button does (validated APEX submit). A plain click on the button did not always
  // fire on page 168 (seen on 38218), so the submit is called directly; the confirmation still comes from the Timeline.
  const submitted = await f.evaluate(() => { const a = (window).apex; if (!a || !a.submit) return false; a.submit({ request: 'SAVE', validate: true }); return true; });
  if (!submitted) await f.getByRole('button', { name: F.saveButton }).click();
  await page.waitForLoadState('networkidle').catch(() => { }); await pause(3000, 5000);
  return { status, lang, text, files: (job.files || []).map((x) => x.name), template };
}
function matchOurs(r, job, statusName, core) {
  if (STATUS[r['Chronic Status Name']] !== STATUS[statusName] && r['Chronic Status Name'] !== statusName) return false;
  return core ? norm(r['Chronic Comment']).includes(norm(core).slice(0, 40)) : true;
}
async function submitReply(page, job) {
  await openChronicAttach(page);
  const row = (await readReport(page)).find((r) => r['Request Id'] === String(job.request_id));
  if (!row) return { result: 'conflict', error: 'the request is no longer in the Chronic Attach list (closed on the portal?)' };
  const curCode = STATUS[row['Chronic Status Name']] ?? 3; const core = coreOf(job);
  const targetName = Object.keys(STATUS).find((k) => STATUS[k] === +statusFor(job, curCode) && !k.includes(' ')) || row['Chronic Status Name'];
  const before = await readTimeline(page, job.request_id);
  const already = before.find((r) => !st(job.request_id).mine.includes(tlId(job.request_id, r)) && job.attempt > 1 && matchOurs(r, job, targetName, core));
  if (already) return confirmed(job, already, row);                                         // an earlier attempt went through
  if (FINAL.has(curCode) && job.decision !== 'Message') return { result: 'conflict', error: `the request is already ${row['Chronic Status Name']} on the portal` };
  if (job.portal_status_now && row['Chronic Status Name'] !== job.portal_status_now && FINAL.has(curCode)) return { result: 'conflict', error: `status changed on the portal to ${row['Chronic Status Name']}` };
  const sent = await fillReply(page, job, curCode, true);
  for (let i = 0; i < 6; i++) {                                                             // confirm from the Request Timeline
    await openChronicAttach(page);
    const after = await readTimeline(page, job.request_id);
    const known = new Set(before.map((b) => tlId(job.request_id, b)));
    const hit = after.find((r) => !known.has(tlId(job.request_id, r)) && matchOurs(r, job, targetName, core));
    if (hit) { const row2 = (await readReport(page)).find((r) => r['Request Id'] === String(job.request_id)) || row; return confirmed(job, hit, row2, sent); }
    await pause(5000, 8000);
  }
  return { result: 'retry', error: 'saved, but the Request Timeline did not show the reply yet - it is checked again before any resend' };
}
function confirmed(job, entry, row, sent) {
  const tid = tlId(job.request_id, entry); const s = st(job.request_id);
  if (!s.mine.includes(tid)) s.mine.push(tid); saveState();
  const sName = entry['Chronic Status Name'] || row['Chronic Status Name'];
  return { result: 'sent', portal: { status_code: STATUS[sName] ?? null, status_name: sName, timeline_id: tid, last_update: iso(entry['Creation Date']) || new Date().toISOString(),
    delivered: row['Broker Mail'] ? { channel: 'email', to: row['Broker Mail'] } : { channel: 'whatsapp', to: row['Creation User'] }, text: sent ? sent.text.slice(0, 2000) : undefined } };
}
const canWrite = (job) => DRY ? 'DRY_RUN is on' : !ALLOW.has(String(job.request_id)) ? `request ${job.request_id} is not in LIVE_WRITE_ALLOW` : '';

// ---------------- one cycle ----------------
async function cycle(page, full) {
  const cfg = await call('bridge_config');
  if (!cfg.active) { log('link is Off in Settings > Portal - idle'); return; }
  await openChronicAttach(page);
  const heads = await page.$$eval('#my_ir .a-IRR-header', (h) => h.map((x) => x.textContent.trim()));
  const missing = EXPECTED_HEADERS.filter((h) => !heads.includes(h));
  if (missing.length) { await call('bridge_health', { ok: false, loggedIn: true, pageOk: false, error: 'report columns changed: missing ' + missing.join(', '), pc: env.COMPUTERNAME || '' }); return; }
  // IN: timeline every cycle; attachments when the request is new or its timeline changed (or on the hourly full pass)
  const rows = await readReport(page); const shown = await reportCount(page);
  const requests = [];
  for (const row of rows) {
    const id = row['Request Id']; const s = st(id);
    const tl = await readTimeline(page, id); const fp = sha(JSON.stringify(tl));
    const atts = (full || !s.tl || s.tl !== fp) ? await readAttachments(page, id) : s.files.map((fid) => ({ id: fid }));
    requests.push({ req: toRequest(row, tl, atts), fp });
    await pause();
  }
  if (requests.length) {
    const r = await call('bridge_ingest', { requests: requests.map((x) => x.req) });
    log('ingest', JSON.stringify({ seen: requests.length, created: r.created, updated: r.updated, same: r.same, errors: r.errors }));
    if (!(r.errors || []).length) { for (const x of requests) { const s = st(x.req.request_id); s.tl = x.fp; s.files = [...new Set([...s.files, ...x.req.attachments.map((a) => a.id)])]; } saveState(); }
  }
  const rec = await call('bridge_reconcile', { open_request_ids: rows.filter((r) => !FINAL.has(STATUS[r['Chronic Status Name']])).map((r) => r['Request Id']) });
  log('reconcile', JSON.stringify({ shown_on_report: shown, read: rows.length, missing: rec.missing_tickets, closed_elsewhere: rec.closed_on_portal_still_open_here }));
  // OUT
  for (const j of (await call('bridge_peek', { limit: 5 })).jobs || []) {
    const why = canWrite(j);
    if (why) {   // preview: open the form, let the portal write its template, record the exact text, Cancel - nothing saved
      const row = rows.find((r) => r['Request Id'] === String(j.request_id));
      let p; try { p = await fillReply(page, j, STATUS[row?.['Chronic Status Name']] ?? 3, false); } catch (e) { p = { error: String(e.message || e) }; }
      writeFileSync(join(DATA, 'previews', `${j.id}.json`), JSON.stringify({ job: j.id, ticket: j.ticket, request: j.request_id, decision: j.decision, ...p, not_submitted_because: why, at: new Date().toISOString() }, null, 2));
      log('preview only', j.id, j.request_id, '-', why);
      continue;
    }
    const claimed = ((await call('bridge_jobs', { limit: 1, id: j.id })).jobs || []).find((x) => x.id === j.id);
    if (!claimed) continue;
    let res;
    try { res = await submitReply(page, claimed); } catch (e) { res = e instanceof Blocked ? { result: 'error', error: e.message } : { result: 'retry', error: String(e.message || e).slice(0, 300) }; }
    await call('bridge_job_result', { id: claimed.id, ...res }); log('job', claimed.id, res.result, res.error || '');
    await pause(4000, 7000);
  }
  await call('bridge_health', { ok: true, loggedIn: true, pageOk: true, pc: env.COMPUTERNAME || '' });
}

async function main() {
  if (!SB || !TOKEN.startsWith('chp_')) { console.error('SUPABASE_URL and PORTAL_TOKEN are required (Start-PortalBridge.ps1 sets them)'); process.exit(2); }
  const once = process.argv.includes('--once'), minutes = Math.max(2, +(env.INTERVAL_MIN || 5));
  const ctx = await chromium.launchPersistentContext(join(DATA, 'chrome-profile'), { channel: 'chrome', headless: HEADLESS, acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  log(`portal bridge started - ${DRY ? 'DRY RUN (previews only, nothing saved)' : 'live writes for: ' + ([...ALLOW].join(',') || 'none')}`);
  for (let n = 0; ; n++) {
    try { await cycle(page, n % 12 === 0); }
    catch (e) {
      const msg = String(e.message || e).slice(0, 400); log('cycle failed:', msg);
      await call('bridge_health', { ok: false, loggedIn: !(e instanceof Blocked), pageOk: !/structure|not found|not recognised|did not open/.test(msg), error: msg, pc: env.COMPUTERNAME || '' }).catch(() => { });
      if (e instanceof Blocked) { log('stopped: needs a person (see the health alert)'); break; }
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, minutes * 60000));
  }
  await ctx.close();
}
main();
