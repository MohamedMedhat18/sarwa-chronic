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
import { fileURLToPath } from 'node:url';

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
const READER = fileURLToPath(new URL('./portal-reader.js', import.meta.url));   // in-page reader (no clicks)
mkdirSync(join(DATA, 'previews'), { recursive: true });
const MAP = JSON.parse(readFileSync(existsSync(join(DATA, 'reply-map.json')) ? join(DATA, 'reply-map.json') : new URL('./reply-map.json', import.meta.url), 'utf8'));
const F = MAP.form;
const STATE_FILE = join(DATA, 'state.json');      // per request: timeline fingerprint, attachment ids already sent, our timeline entries
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')) : {};   // tolerate a BOM (file edited in PowerShell)
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
// what the person would SEE: a captcha widget, or a code prompt in the visible text. (The page source always contains the
// "Forgot Password?" reset dialog named send-otp - seen 21 Nov 2026 - so the source must not be scanned.)
async function blockedOn(f) {
  if (await f.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, [data-sitekey]').count().catch(() => 0)) return 'captcha';
  const text = (await f.locator('body').innerText().catch(() => '')).toLowerCase();
  return /one[- ]time (password|code)|verification code|authenticator|two[- ]factor|enter (the )?(otp|code)|رمز التحقق/.test(text) ? 'second factor' : '';
}
// the sign-in page is shown inside a frame of the portal home ("/"); after signing in continue at that frame's address
async function leaveLoginFrame(page) {
  if (await page.getByRole('link', { name: 'Claims' }).count().catch(() => 0)) return;
  for (const fr of page.frames()) {
    if (fr === page.mainFrame()) continue;
    if (await fr.getByRole('link', { name: 'Claims' }).count().catch(() => 0) || /home-page|medical-claims/.test(fr.url())) { await page.goto(fr.url(), { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000); return; }
  }
}
// seen on the live portal (21 Nov 2026): after a while APEX shows "Your session has ended" with a "Sign In Again" button
async function sessionEnded(page) {
  const box = page.getByText('Your session has ended', { exact: false });
  if (!(await box.count().catch(() => 0)) || !(await box.first().isVisible().catch(() => false))) return false;
  log('portal session ended - signing in again');
  await page.getByRole('button', { name: /sign in again/i }).first().click().catch(() => { });
  await page.waitForLoadState('domcontentloaded').catch(() => { }); await page.waitForTimeout(2500);
  return true;
}
async function ensureLoggedIn(page) {
  if (await sessionEnded(page)) await page.goto(LOGIN, { waitUntil: 'domcontentloaded' }).catch(() => { });
  await leaveLoginFrame(page);
  if (await page.getByRole('link', { name: 'Claims' }).count().catch(() => 0) && !(await sessionEnded(page))) return;
  if (await page.locator('#my_ir').count().catch(() => 0)) return;
  if (!(await frameWith(page, 'input[type=password]'))) await page.goto(LOGIN, { waitUntil: 'domcontentloaded' });
  // the sign-in page loads inside a frame of the portal home and can take a while: wait for the form or the signed-in menu
  let f = null;
  for (let i = 0; i < 40 && !f; i++) {
    await page.waitForTimeout(500);
    await leaveLoginFrame(page);
    if (await page.getByRole('link', { name: 'Claims' }).count().catch(() => 0)) return;
    f = await frameWith(page, 'input[type=password]');
  }
  if (!f) throw new Error('login page not recognised (page structure changed?)');
  const b = await blockedOn(f); if (b) throw new Blocked(`the login page asks for a ${b} - automation stopped`);
  if (!USER || !PASS) throw new Blocked('no portal account on this PC - run Set-PortalCredential.ps1');
  await f.locator('input[type=text], input:not([type])').first().fill(USER);
  await f.locator('input[type=password]').first().fill(PASS);
  await f.getByRole('button', { name: /sign in/i }).click();
  await page.waitForLoadState('networkidle').catch(() => { }); await page.waitForTimeout(2500);
  const f2 = await frameWith(page, 'input[type=password]');
  if (f2) { const b2 = await blockedOn(f2); throw b2 ? new Blocked(`a ${b2} appeared after sign-in - automation stopped`) : new Blocked('sign-in failed (wrong password or locked account) - not retried'); }
  for (const fr of page.frames()) { const b3 = await blockedOn(fr); if (b3) throw new Blocked(`a ${b3} appeared after sign-in - automation stopped`); }
  await leaveLoginFrame(page);
}
async function openChronicAttach(page, { reload = false } = {}) {
  await ensureLoggedIn(page);
  await closeDialogs(page);
  // already on the page: refresh only the report region (a full page reload re-renders tiles, menus and every tab)
  if (!reload && /\/chronic-attach/.test(page.url()) && await page.locator('#my_ir').count().catch(() => 0)) {
    const ok = await page.evaluate(() => { try { apex.region('my_ir').refresh(); return true; } catch { return false; } }).catch(() => false);
    if (ok && await waitReport(page, 30)) return;
  }
  if (/\/chronic-attach/.test(page.url())) await page.reload({ waitUntil: 'networkidle' });
  else {
    if (!/medical-claims2009/.test(page.url())) { await page.getByRole('link', { name: 'Claims' }).first().click(); await page.waitForLoadState('networkidle'); await pause(); }
    const link = page.locator('a[href*="/chronic-attach"]').first();
    if (!(await link.count())) throw new Error('Chronic Attach link not found in the Claims menu (page structure changed?)');
    // the menu entry may sit in a collapsed side menu (not clickable); its address carries the session, so open it directly
    if (await link.isVisible().catch(() => false)) await link.click();
    else await page.goto(new URL(await link.getAttribute('href'), page.url()).href, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => { });
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
  // the close button can be covered or outside the view (seen 21 Nov 2026): short click, then Escape, then jQuery UI close
  for (let i = 0; i < 5; i++) {
    const x = page.locator('.ui-dialog:visible .ui-dialog-titlebar-close'); if (!(await x.count().catch(() => 0))) break;
    try { await x.last().click({ timeout: 3000 }); }
    catch {
      await page.keyboard.press('Escape').catch(() => { });
      await page.evaluate(() => { try { window.$('.ui-dialog-content').each(function () { try { if (window.$(this).dialog('isOpen')) window.$(this).dialog('close'); } catch { } }); } catch { } }).catch(() => { });
    }
    await page.waitForTimeout(700);
  }
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
// Request Timeline through the in-page reader (GET of the signed dialog address - no click on the report link)
async function readTimeline(page, requestId) {
  if (!(await page.evaluate(() => !!window.SarwaPortalReader).catch(() => false))) await page.addScriptTag({ path: READER });
  return await page.evaluate((x) => window.SarwaPortalReader.timeline(x), String(requestId));
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
  // saved when the Reply form closes (instead of a fixed 3-5 s wait); a validation error keeps it open
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    const open = page.frames().some((fr) => { try { return fr.url().includes('chronis-status') || fr.url().includes('p168'); } catch { return false; } });
    if (!open) break;
    const err = await f.locator('.t-Alert--danger, .a-Notification--error, .apex-page-error').first().textContent({ timeout: 200 }).catch(() => '');
    if (norm(err)) throw new Error('the portal refused the reply: ' + norm(err).slice(0, 200));
  }
  return { status, lang, text, files: (job.files || []).map((x) => x.name), template };
}
function matchOurs(r, job, statusName, core) {
  if (STATUS[r['Chronic Status Name']] !== STATUS[statusName] && r['Chronic Status Name'] !== statusName) return false;
  return core ? norm(r['Chronic Comment']).includes(norm(core).slice(0, 40)) : true;
}
// wait for the report's result itself (rows, or the portal's "no data found") - not for a spinner class
async function waitReport(page, secs = 90) {
  for (let i = 0; i < secs; i++) {
    await page.waitForTimeout(1000);
    const s8 = await page.evaluate(() => ({ busy: !!document.querySelector('.u-Processing, .u-Processing-spinner, .a-IRR-loading, .apex_wait_overlay'), rows: document.querySelectorAll('#my_ir .a-IRR-table td[headers]').length, none: !!document.querySelector('#my_ir .a-IRR-noDataMsg, #my_ir .nodatafound') })).catch(() => ({ busy: true }));
    if (!s8.busy && (s8.rows || s8.none)) return true;
  }
  return false;
}
async function cardOf(id) {   // member card number from Sarwa Chronic (function portal-info, bridge token)
  const r = await fetch(SB + '/functions/v1/portal-info', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': TOKEN }, body: JSON.stringify({ request_ids: [String(id)] }) }).catch(() => null);
  return r && r.ok ? ((await r.json().catch(() => ({}))).members || {})[String(id)] || '' : '';
}
// the request on the Pending list, or - when it already left it (a final decision moves it off) - with the card filter
async function findAnywhere(page, id, card) {
  await openChronicAttach(page); await resetReport(page);
  let row = (await readReport(page)).find((r) => r['Request Id'] === String(id));
  if (row || !card) return row || null;
  await page.evaluate((c) => { apex.item('P165_INDIVIDUAL_NUM').setValue(c); apex.item('P165_STATUS').setValue(''); }, String(card));
  await page.locator('#B500203752390221333').click();
  await waitReport(page);
  row = (await readReport(page)).find((r) => r['Request Id'] === String(id));
  return row || null;
}
async function submitReply(page, job) {
  const id = String(job.request_id); const T = { start: Date.now() }; const mark = (k) => { T[k] = Date.now(); };
  try {
    let row = await findAnywhere(page, id, '');
    let card = row ? (row['Individual Number'] || row._indiv || '') : await cardOf(id);
    if (!row) row = await findAnywhere(page, id, card);
    mark('found');
    if (!row) return { result: 'conflict', error: 'the request was not found on the portal (Chronic Attach, all statuses)' };
    card = card || row['Individual Number'] || row._indiv || '';
    const curCode = STATUS[row['Chronic Status Name']] ?? 3; const core = coreOf(job);
    const targetName = Object.keys(STATUS).find((k) => STATUS[k] === +statusFor(job, curCode) && !k.includes(' ')) || row['Chronic Status Name'];
    if (!(await page.evaluate(() => !!window.SarwaPortalReader).catch(() => false))) await page.addScriptTag({ path: READER });
    const tlUrl = await page.evaluate((x) => window.SarwaPortalReader.timelineUrl(x), id);   // kept: confirm with one GET
    const before = await page.evaluate((u) => window.SarwaPortalReader.timelineAt(u), tlUrl);
    mark('timeline');
    // an earlier attempt of THIS job already went through (retry, or the request is already in the target final status)
    const already = before.find((r) => !st(id).mine.includes(tlId(id, r)) && (job.attempt > 1 || FINAL.has(curCode)) && matchOurs(r, job, targetName, core));
    if (already) return confirmed(job, already, row);
    if (FINAL.has(curCode) && job.decision !== 'Message') return { result: 'conflict', error: `the request is already ${row['Chronic Status Name']} on the portal` };
    if (job.portal_status_now && row['Chronic Status Name'] !== job.portal_status_now && FINAL.has(curCode)) return { result: 'conflict', error: `status changed on the portal to ${row['Chronic Status Name']}` };
    const sent = await fillReply(page, job, curCode, true);
    mark('saved');
    const known = new Set(before.map((b) => tlId(id, b)));
    // confirm: the same Timeline address, fetched again (1 GET, no report refresh) - quick retries, then one slow check
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(i < 3 ? 1500 : 3000);
      const after = await page.evaluate((u) => window.SarwaPortalReader ? window.SarwaPortalReader.timelineAt(u) : null, tlUrl).catch(() => null);
      if (!after) { await page.addScriptTag({ path: READER }).catch(() => { }); continue; }
      const hit = after.find((r) => !known.has(tlId(id, r)) && matchOurs(r, job, targetName, core));
      if (hit) { mark('confirmed'); timing(job, T); return confirmed(job, hit, row, sent); }
    }
    const row2 = await findAnywhere(page, id, card);
    if (row2) { const hit = (await readTimeline(page, id)).find((r) => !known.has(tlId(id, r)) && matchOurs(r, job, targetName, core)); if (hit) { mark('confirmed'); timing(job, T); return confirmed(job, hit, row2, sent); } }
    timing(job, T);
    return { result: 'retry', error: 'saved, but the Request Timeline did not show the reply yet - it is checked again before any resend' };
  } finally {
    await resetReport(page).catch(() => { });
  }
}
// one line per reply with the time of each stage (seconds): find on the portal, read Timeline, fill + save, confirm
function timing(job, T) {
  const s = (a, b) => (T[a] && T[b] ? ((T[b] - T[a]) / 1000).toFixed(1) : '-');
  log('timing', job.id, JSON.stringify({ find: s('start', 'found'), timeline: s('found', 'timeline'), fill_save: s('timeline', 'saved'), confirm: s('saved', 'confirmed'), total: ((Date.now() - T.start) / 1000).toFixed(1), queued_s: job.queued_s ?? null }));
}
function confirmed(job, entry, row, sent) {
  const tid = tlId(job.request_id, entry); const s = st(job.request_id);
  if (!s.mine.includes(tid)) s.mine.push(tid); saveState();
  const sName = entry['Chronic Status Name'] || row['Chronic Status Name'];
  return { result: 'sent', portal: { status_code: STATUS[sName] ?? null, status_name: sName, timeline_id: tid, last_update: iso(entry['Creation Date']) || new Date().toISOString(),
    delivered: row['Broker Mail'] ? { channel: 'email', to: row['Broker Mail'] } : { channel: 'whatsapp', to: row['Creation User'] }, text: sent ? sent.text.slice(0, 2000) : undefined } };
}
// Portal history row (every status) - same shape as the one-time import of 21 Nov 2026
const ddmmyyyy = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const histRow = (r, statusName) => ({ request_id: r['Request Id'], individual_number: r['Individual Number'] || r._indiv || '', individual_name: r['Individual Name'] || '',
  policy_holder: r['Policy Holder Name'] || r['Policy Holder'] || '', contract_no: r['Contract No'] || r['Contract no'] || '', channel: r['Cr Type'] || '', creation_user: r['Creation User'] || '',
  broker: r['Broker'] || '', broker_mail: r['Broker Mail'] || '', status_name: statusName || r['Chronic Status Name'] || '', status_code: STATUS[statusName || r['Chronic Status Name']] ?? null,
  chronic_date: ddmmyyyy(r['Chronic Date']), creation_date: iso(r['Creation Date']) || null, assign_to: r['Assign To'] || '' });
// two gates: this PC (DRY_RUN / LIVE_WRITE_ALLOW, '*' = every request the server allows) AND the server (Settings > Portal:
// dry run off + live list / live for all - bridge_jobs hands out nothing else)
const canWrite = (job) => DRY ? 'DRY_RUN is on' : !(ALLOW.has('*') || ALLOW.has(String(job.request_id))) ? `request ${job.request_id} is not in LIVE_WRITE_ALLOW` : '';

// ---------------- one cycle ----------------
async function cycle(page, full) {
  const t0 = Date.now();
  await openChronicAttach(page);
  await resetReport(page);   // no search / filter left over (an empty report has no column headers)
  const heads = await page.$$eval('#my_ir .a-IRR-header', (h) => h.map((x) => x.textContent.trim()));
  if (!heads.length && await page.locator('#my_ir .a-IRR-noDataMsg, #my_ir .nodatafound').count().catch(() => 0)) { log('no Pending requests on the portal'); await call('bridge_health', { ok: true, loggedIn: true, pageOk: true, pc: env.COMPUTERNAME || '' }); return; }
  const missing = EXPECTED_HEADERS.filter((h) => !heads.includes(h));
  if (missing.length) { await call('bridge_health', { ok: false, loggedIn: true, pageOk: false, error: 'report columns changed: missing ' + missing.join(', '), pc: env.COMPUTERNAME || '' }); return; }
  // IN: timeline every cycle; attachments when the request is new or its timeline changed (or on the hourly full pass)
  const rows = await readReport(page); const shown = await reportCount(page);
  const requests = [];
  // read every request with the in-page reader (plain GETs of the signed dialog URLs - no clicks, nothing submitted):
  // timeline + Broker and Sarwa attachments; files already sent are listed but not downloaded again
  await page.addScriptTag({ path: READER });
  // new requests first (they must reach Sarwa Chronic fast); a known request is re-read in full only when its timeline
  // changed, or on the full pass (files added without a timeline entry are caught there)
  const fpOf = (list) => sha(JSON.stringify(list.map((e) => [e.status, norm(e.comment), norm(e.extra)])));
  const order = [...rows].sort((a, b) => (state[a['Request Id']] ? 1 : 0) - (state[b['Request Id']] ? 1 : 0));
  let skipped = 0, lastOut = Date.now();
  for (const row of order) {
    if (Date.now() - lastOut > OUT_POLL_MS) {   // a reply pressed meanwhile goes first, then reading continues
      lastOut = Date.now();
      if (await outboundNow(page)) { await openChronicAttach(page); await page.addScriptTag({ path: READER }); }
    }
    const id = row['Request Id']; const known = !!state[id] && !!state[id].tlq; const s = st(id);
    if (known && !full) {
      const raw = await page.evaluate((x) => window.SarwaPortalReader.timeline(x), id);
      if (fpOf(raw.map((e) => ({ status: e['Chronic Status Name'], comment: e['Chronic Comment'], extra: e['Extra Comment'] }))) === s.tlq) { skipped++; await pause(200, 500); continue; }
    }
    const r = await page.evaluate(({ id, skip, mine }) => window.SarwaPortalReader.readRequest(id, { skip, mine }), { id, skip: s.files, mine: s.mine });
    const fp = fpOf(r.req.timeline.map((t) => ({ status: t.status_name, comment: t.comment, extra: t.extra_comment })));
    // send each request on its own: a new one is a ticket within seconds, not after the whole list
    const res = await call('bridge_ingest', { requests: [r.req] });
    if (!(res.errors || []).length) { s.tlq = fp; s.files = [...new Set([...s.files, ...r.req.attachments.filter((a) => a.content_base64 || s.files.includes(a.id)).map((a) => a.id)])]; saveState(); }
    requests.push({ id, created: res.created || 0, updated: res.updated || 0, same: res.same || 0, error: (res.errors || [])[0] || '' });
    if (res.created) log('NEW ticket for request', id);
    await pause(400, 900);
  }
  log('ingest', JSON.stringify({ seen: rows.length, read: requests.length, unchanged: skipped, created: requests.reduce((a, x) => a + x.created, 0), updated: requests.reduce((a, x) => a + x.updated, 0), errors: requests.filter((x) => x.error).map((x) => x.id + ': ' + x.error) }));
  for (let i = 0; i < rows.length; i += 1000) await call('bridge_history', { rows: rows.slice(i, i + 1000).map((r) => histRow(r)) }).catch((e) => log('history:', e.message));
  const rec = await call('bridge_reconcile', { open_request_ids: rows.filter((r) => !FINAL.has(STATUS[r['Chronic Status Name']])).map((r) => r['Request Id']) });
  log('reconcile', JSON.stringify({ shown_on_report: shown, read: rows.length, missing: rec.missing_tickets, closed_elsewhere: rec.closed_on_portal_still_open_here }));
  log('cycle', full ? 'full' : 'changed', `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await outboundNow(page);
  // requests that left the list (decided / changed directly on the portal): look each one up and send its current state
  // in - the server marks the ticket "Changed on the portal" and never overwrites. At most 5 per cycle, each every 30 min.
  state._lookup ||= {};
  const gone = (rec.closed_on_portal_still_open_here || []).filter((x) => /^\d+$/.test(x)).slice(0, 2);   // ~15 s each: 2 per cycle
  let cards = {};
  if (gone.length) {
    const r = await fetch(SB + '/functions/v1/portal-info', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': TOKEN }, body: JSON.stringify({ request_ids: gone }) }).catch(() => null);
    cards = (r && r.ok ? (await r.json().catch(() => ({}))).members : null) || {};
  }
  for (const id of gone) {
    state._miss ||= {};
    const wait = (state._miss[id] || 0) >= 2 ? 6 * 3600000 : 30 * 60000;   // not found twice -> look again only every 6 h
    if (Date.now() - (state._lookup[id] || 0) < wait) continue;
    state._lookup[id] = Date.now(); saveState();
    try { const out = await lookupRequest(page, id, cards[id]); state._miss[id] = /^not found/.test(out) ? (state._miss[id] || 0) + 1 : 0; saveState(); log('changed on the portal?', id, out.slice(0, 120)); }
    catch (e) { log('lookup failed', id, String(e.message || e).slice(0, 200)); if (e instanceof Blocked) throw e; }
  }
  await call('bridge_health', { ok: true, loggedIn: true, pageOk: true, pc: env.COMPUTERNAME || '' });
}
// find one request with the portal's card filter (Individual Number) over ALL statuses - a member has only a few requests,
// so the report answers in seconds (a text search over all ~18,000 requests never finished). The card number comes from
// Sarwa Chronic (function portal-info, bridge token). Status Filter / card filter are always put back afterwards.
async function lookupRequest(page, id, card) {
  if (!card) return 'not found on the portal (no card number known for this request)';
  await openChronicAttach(page);
  const waitResult = async () => {
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(1000);
      const s8 = await page.evaluate(() => ({ busy: !!document.querySelector('.u-Processing, .u-Processing-spinner, .a-IRR-loading, .apex_wait_overlay'), rows: document.querySelectorAll('#my_ir .a-IRR-table td[headers]').length, none: !!document.querySelector('#my_ir .a-IRR-noDataMsg, #my_ir .nodatafound') })).catch(() => ({ busy: true }));
      if (!s8.busy && (s8.rows || s8.none)) return true;
    }
    return false;
  };
  try {
    await resetReport(page);
    await page.evaluate((c) => { apex.item('P165_INDIVIDUAL_NUM').setValue(c); apex.item('P165_STATUS').setValue(''); }, String(card));
    await page.locator('#B500203752390221333').click();
    await waitResult();
    await page.addScriptTag({ path: READER });
    const found = await page.evaluate((x) => window.SarwaPortalReader.reportRows().some((r) => r['Request Id'] === String(x)), id);
    if (!found) await page.screenshot({ path: join(DATA, 'previews', `lookup-${id}.png`), fullPage: true }).catch(() => { });   // evidence for the admin
    if (!found) return 'not found on the portal ' + JSON.stringify(await page.evaluate((x) => ({ otherReports: [...document.querySelectorAll('.a-IRR, .t-Report, .a-GV')].map((r) => { const reg = r.closest('[id^="R"], [id$="_ir"]') || r; const tab = reg.closest('.t-TabsRegion-items > div, [role=tabpanel]'); return { id: (reg.id || '').slice(0, 40), tab: tab ? (document.querySelector('[aria-controls="' + tab.id + '"]') || {}).textContent?.trim() : '', rows: r.querySelectorAll('tr').length, hasId: r.textContent.includes(x) }; }).slice(0, 8), tabLinks: [...document.querySelectorAll('.t-Tabs a, [role=tab]')].map((a) => a.textContent.trim() + '>' + (a.getAttribute('aria-controls') || a.getAttribute('href') || '').slice(0, 40)).slice(0, 6), status: apex.item('P165_STATUS').getValue(), search: !!document.querySelector('#my_ir_search_field'), filters: [...document.querySelectorAll('#my_ir .a-IRR-controls-item')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).slice(0, 3), pag: (document.querySelector('#my_ir .a-IRR-pagination') || {}).textContent?.replace(/\s+/g, ' ').trim(), rows: window.SarwaPortalReader.reportRows().length, tabs: [...document.querySelectorAll('a,button')].map((e) => e.textContent.trim()).filter((t) => /^Chronic Attach/.test(t)).slice(0, 4) }), String(id)).catch((e) => ({ err: String(e) })));
    const s = st(id);
    const r = await page.evaluate(({ id, skip, mine }) => window.SarwaPortalReader.readRequest(id, { skip, mine }), { id, skip: s.files, mine: s.mine });
    const res = await call('bridge_ingest', { requests: [r.req] });
    if (!(res.errors || []).length) { s.files = [...new Set([...s.files, ...r.req.attachments.filter((a) => a.content_base64 || s.files.includes(a.id)).map((a) => a.id)])]; saveState(); }
    const q = r.req;   // full row for the history (every column, so nothing is blanked by the upsert)
    await call('bridge_history', { rows: [{ request_id: q.request_id, individual_number: q.individual_number, individual_name: q.individual_name, policy_holder: q.policy_holder_name || q.policy_holder, contract_no: q.contract_no, channel: q.channel, creation_user: q.creation_user, broker: q.broker, broker_mail: q.broker_mail, status_name: q.status_name, status_code: q.status_code, chronic_date: q.chronic_date || null, creation_date: q.creation_date || null, assign_to: q.assign_to }] }).catch(() => { });
    return 'now ' + r.req.status_name + ((res.errors || []).length ? ' - error ' + res.errors[0] : res.updated ? ' - ticket updated' : ' - no change');
  } finally {
    await resetReport(page).catch(() => { });
  }
}
// the report back to its normal view: every search / filter removed, Status Filter = Pending
async function resetReport(page) {
  for (let i = 0; i < 6; i++) {
    const n = await page.evaluate(() => { const b = [...document.querySelectorAll('#my_ir button, #my_ir a')].filter((x) => /Remove Filter/i.test(x.getAttribute('title') || x.getAttribute('aria-label') || '')); if (b[0]) b[0].click(); return b.length; }).catch(() => 0);
    if (!n) break;
    await page.waitForLoadState('networkidle').catch(() => { }); await page.waitForTimeout(1500);
  }
  await page.fill('#my_ir_search_field', '').catch(() => { });
  const cur = await page.evaluate(() => [apex.item('P165_STATUS').getValue(), apex.item('P165_INDIVIDUAL_NUM').getValue()]).catch(() => ['3', '']);
  if (cur[0] !== '3' || cur[1]) {
    await page.evaluate(() => { apex.item('P165_INDIVIDUAL_NUM').setValue(''); apex.item('P165_STATUS').setValue('3'); }).catch(() => { });
    await page.locator('#B500203752390221333').click().catch(() => { });
    await page.waitForLoadState('networkidle').catch(() => { }); await page.waitForTimeout(2500);
  }
}

// ---------------- read-only re-check of replies marked "conflict" (admin approved, 22 Nov 2026) ----------------
// For each job: find the request (Pending list or card filter), read its Request Timeline, and look for an entry that matches
// the reply (same target status; our text if there was one; on or after the day it was queued). Opens no form, submits
// nothing; writes recheck-result.json for the admin. Input: JSON [{ id, request_id, target, core, created }].
async function recheck(page, file) {
  const jobs = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const out = [];
  for (const j of jobs) {
    try {
      const card = await cardOf(j.request_id);
      const row = await findAnywhere(page, j.request_id, card);
      if (!row) { out.push({ job: j.id, request: j.request_id, found: false }); continue; }
      const tl = await readTimeline(page, j.request_id);
      const day = String(j.created || '').slice(0, 10);
      // the Timeline shows the portal's (Cairo) date, often without a time: compare that day, not a UTC conversion
      const dayOf = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '9999'; };
      const cands = tl.filter((e) => (STATUS[e['Chronic Status Name']] === STATUS[j.target]) && (!norm(j.core) || norm(e['Chronic Comment']).includes(norm(j.core).slice(0, 40))) && (!day || dayOf(e['Creation Date']) >= day));
      const m = cands[cands.length - 1];
      out.push({ job: j.id, request: j.request_id, found: true, status_now: row['Chronic Status Name'], matches: cands.length,
        match: m ? { timeline_id: tlId(j.request_id, m), status: m['Chronic Status Name'], at: iso(m['Creation Date']), comment_start: norm(m['Chronic Comment']).slice(0, 60) } : null,
        delivered: row['Broker Mail'] ? 'email' : 'whatsapp' });
    } catch (e) { out.push({ job: j.id, request: j.request_id, error: String(e.message || e).slice(0, 200) }); }
    await resetReport(page).catch(() => { });
  }
  writeFileSync(join(DATA, 'recheck-result.json'), JSON.stringify(out, null, 2));
  log('recheck', JSON.stringify(out.map((x) => [x.job, x.found, x.status_now, x.matches])));
}
// ---------------- scheduler: replies first, new requests fast, the rest in between ----------------
const OUT_POLL_MS = 8000;           // replies waiting? (one cheap call)
const NEW_EVERY_MS = 30000;         // new requests: report refresh, only unknown ids are read
const CHANGED_EVERY_MS = 120000;    // known requests: timeline check (+ reconcile, history, lookups)
const FULL_EVERY_MS = 10 * 60000;   // full pass: files too
const firstSeen = {};               // job id -> when the bridge first saw it queued (queue-age alert)
async function outboundNow(page) {
  const jobs = (await call('bridge_peek', { limit: 5 })).jobs || [];
  for (const j of jobs) {
    firstSeen[j.id] ||= Date.now();
    const why = canWrite(j);
    if (why) {   // preview only (this PC is in dry run / not allowed): nothing saved
      let p; try { p = await fillReply(page, j, 3, false); } catch (e) { p = { error: String(e.message || e) }; }
      writeFileSync(join(DATA, 'previews', `${j.id}.json`), JSON.stringify({ job: j.id, ticket: j.ticket, request: j.request_id, decision: j.decision, ...p, not_submitted_because: why, at: new Date().toISOString() }, null, 2));
      log('preview only', j.id, j.request_id, '-', why); continue;
    }
    const claimed = ((await call('bridge_jobs', { limit: 1, id: j.id })).jobs || []).find((x) => x.id === j.id);
    if (!claimed) continue;
    claimed.queued_s = ((Date.now() - firstSeen[j.id]) / 1000).toFixed(1);
    let res;
    try { res = await submitReply(page, claimed); } catch (e) { res = e instanceof Blocked ? { result: 'error', error: e.message } : { result: 'retry', error: String(e.message || e).slice(0, 300) }; }
    await call('bridge_job_result', { id: claimed.id, ...res }); log('job', claimed.id, res.result, res.error || '');
    delete firstSeen[j.id];
    await pause(1500, 3000);
  }
  // queue-age guard: a reply waiting more than 10 minutes means the bridge cannot get through - alert the admins
  const oldest = Object.values(firstSeen).length ? Math.min(...Object.values(firstSeen)) : 0;
  if (oldest && Date.now() - oldest > 10 * 60000) await call('bridge_health', { ok: false, loggedIn: true, pageOk: true, error: 'a reply has been waiting for the portal for more than 10 minutes', pc: env.COMPUTERNAME || '' }).catch(() => { });
  return jobs.length;
}
// new requests only: report refresh + read the ids the bridge has never seen (seconds, no timeline checks)
async function newRequestsNow(page) {
  await openChronicAttach(page); await resetReport(page);
  const rows = await readReport(page); const fresh = rows.filter((r) => !(state[r['Request Id']] && state[r['Request Id']].tlq));
  if (!fresh.length) return 0;
  await page.addScriptTag({ path: READER });
  for (const row of fresh) {
    const id = row['Request Id']; const s = st(id); const t0 = Date.now();
    const r = await page.evaluate(({ id, skip, mine }) => window.SarwaPortalReader.readRequest(id, { skip, mine }), { id, skip: s.files, mine: s.mine });
    const res = await call('bridge_ingest', { requests: [r.req] });
    if (!(res.errors || []).length) { s.tlq = sha(JSON.stringify(r.req.timeline.map((t) => [t.status_name, norm(t.comment), norm(t.extra_comment)]))); s.files = [...new Set([...s.files, ...r.req.attachments.filter((a) => a.content_base64).map((a) => a.id)])]; saveState(); }
    log(res.created ? 'NEW ticket for request' : 'read request', id, `(${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.req.attachments.length} file(s))`);
    if (await outboundNow(page)) { await openChronicAttach(page); await page.addScriptTag({ path: READER }); }   // replies first
  }
  return fresh.length;
}
async function main() {
  if (!SB || !TOKEN.startsWith('chp_')) { console.error('SUPABASE_URL and PORTAL_TOKEN are required (Start-PortalBridge.ps1 sets them)'); process.exit(2); }
  const once = process.argv.includes('--once');
  const ctx = await chromium.launchPersistentContext(join(DATA, 'chrome-profile'), { channel: 'chrome', headless: HEADLESS, acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  // headless: no images / fonts / media (not needed to read or fill forms); file downloads are fetch() calls and still work
  if (HEADLESS) await ctx.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  const page = ctx.pages()[0] || await ctx.newPage();
  log(`portal bridge started - ${DRY ? 'DRY RUN (previews only, nothing saved)' : 'live writes for: ' + ([...ALLOW].join(',') || 'none')}`);
  if (process.argv.includes('--recheck')) { await recheck(page, process.argv[process.argv.indexOf('--recheck') + 1]); await ctx.close(); return; }
  let lastNew = 0, lastChanged = 0, lastFull = 0, active = true, lastCfg = 0;
  for (;;) {
    try {
      if (Date.now() - lastCfg > 60000) { active = !!(await call('bridge_config')).active; lastCfg = Date.now(); if (!active) log('link is Off in Settings > Portal - idle'); }
      if (active) {
        await outboundNow(page);
        if (Date.now() - lastChanged > CHANGED_EVERY_MS || once) {
          const full = Date.now() - lastFull > FULL_EVERY_MS; lastChanged = lastNew = Date.now(); if (full) lastFull = Date.now();
          await cycle(page, full);   // timeline checks, reconcile, history, lookups (replies are checked in between)
        } else if (Date.now() - lastNew > NEW_EVERY_MS) { lastNew = Date.now(); await newRequestsNow(page); }
      }
    } catch (e) {
      const msg = String(e.message || e).slice(0, 400); log('cycle failed:', msg);
      await call('bridge_health', { ok: false, loggedIn: !(e instanceof Blocked), pageOk: !/structure|not found|not recognised|did not open/.test(msg), error: msg, pc: env.COMPUTERNAME || '' }).catch(() => { });
      if (e instanceof Blocked) { log('stopped: needs a person (see the health alert)'); break; }
      await new Promise((r) => setTimeout(r, 30000));
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, OUT_POLL_MS));
  }
  await ctx.close();
}
main();
