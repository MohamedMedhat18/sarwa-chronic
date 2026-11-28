// Sarwa Chronic – i-CARE reader (28 Nov 2026). Runs on the Chronic PC next to the portal bridge, in its OWN Chrome profile and
// process, so an i-CARE problem never touches the portal bridge.
// READ-ONLY: it signs in, types the card number in Patient Information and presses its search button (the way a person does it),
// reads Administrative Info, the Notice of Insurance Coverage and the coverage report (limits), and sends them to Sarwa Chronic,
// which writes them on the ticket. It never opens a form that changes anything in i-CARE.
//   - one member at a time, 10 s between members; jobs come from the app (verified / confirmed card, open ticket, nothing fresh)
//   - signed out → signs in again (once per job); sign-in refused / no account → stops for an hour + health alert
//   - a page without its usual labels → "layout changed" alert; nothing guessed, the ticket says "Not available" with the reason
//   - member data is never written to the log; the log names tickets and reasons only
//   - the account comes from Set-IcareCredential.ps1 (Windows DPAPI) through Start-IcareBridge.ps1, only in this process's memory
import { chromium } from 'playwright';
import { join } from 'node:path';
import { parseAdmin, parseClasses, pdfItems, parseCoverage } from './icare-parse.mjs';

const env = process.env;
const SB = (env.SUPABASE_URL || '').replace(/\/$/, '');
const TOKEN = env.PORTAL_TOKEN || '';
const USER = env.ICARE_USER || '', PASS = env.ICARE_PASS || '';
const DATA = env.BRIDGE_DIR || join(env.LOCALAPPDATA || '.', 'ChronicPortalBridge');
const HEADLESS = env.HEADLESS !== '0';
const ICARE = 'https://i-care.globemedegypt.com:8034';
const REPORTS = /^https:\/\/i-gemereports\.globemedegypt\.com(:443)?\/reports\/rwservlet\?/;
const GAP_MS = 10000, POLL_MS = 20000, PC = env.COMPUTERNAME || '';
const DUMP = process.argv.includes('--test') && process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : '';

class Blocked extends Error {}     // needs a person: no account, sign-in refused
class Layout extends Error {}      // a page without its usual labels
class SignedOut extends Error {}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const safe = (s) => norm(s).replace(/\d{6,}/g, '#').slice(0, 200);   // reasons only – never member numbers in logs / server errors

async function call(action, body = {}) {
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(SB + '/functions/v1/portal', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': TOKEN }, body: JSON.stringify({ action, pc: PC, ...body }), signal: AbortSignal.timeout(60000) }); }
    catch (e) { if (i < 3) { await sleep([2000, 5000, 10000][i]); continue; } throw new Error(`${action}: ${e.message || e} (Sarwa Chronic not reachable)`); }
    if (r.status >= 500 && i < 3) { await sleep([2000, 5000, 10000][i]); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`${action}: ${j.error || r.status}`);
    return j;
  }
}
let hState = '', hAt = 0, done = 0;
async function health(state, detail = '') {
  if (state === hState && Date.now() - hAt < 60000) return;
  hState = state; hAt = Date.now();
  await call('icare_health', { state, detail: safe(detail), done }).catch((e) => log('health not sent:', safe(e.message)));
}

const signedIn = async (page) => (await page.locator('a', { hasText: 'Log Out' }).count().catch(() => 0)) > 0;
async function login(page) {
  if (!USER || !PASS) throw new Blocked('no i-CARE account on this PC – run Set-IcareCredential.ps1');
  await page.goto(ICARE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await signedIn(page)) return;
  const pw = page.locator('input[type=password]').first();
  try { await pw.waitFor({ timeout: 30000 }); } catch { throw new Layout('the i-CARE sign-in page did not show its form'); }
  await page.locator('input[type=text], input:not([type])').first().fill(USER);
  await pw.fill(PASS); await pw.press('Enter');
  for (let i = 0; i < 25; i++) { await sleep(1000); if (await signedIn(page)) { log('signed in to i-CARE'); return; } }
  const said = norm(await page.locator('body').innerText().catch(() => '')).slice(0, 160);
  throw new Blocked('i-CARE did not accept the sign-in' + (said ? ' – the page says: ' + safe(said) : ''));
}
// rows of a page inside the signed-in i-CARE (same origin, the page's own session); null = signed out
const rowsOf = (page, url) => page.evaluate(async (u) => {
  const t = await (await fetch(u, { credentials: 'same-origin' })).text();
  if (/j_password|type=["']?password/i.test(t)) return null;
  const d = new DOMParser().parseFromString(t, 'text/html');
  return [...d.querySelectorAll('tr')].filter((tr) => !tr.querySelector('table')).map((tr) => [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
}, url);

// Patient Information: card number → the result area (HTML) with the member's links; null = not found
async function search(page, member) {
  if (!(await signedIn(page))) throw new SignedOut('signed out');
  await page.evaluate(() => window.ColdFusion.navigate('../Assistance/Index.cfm', 'WorkArea'));
  try { await page.locator('#IndNbr').waitFor({ timeout: 30000 }); } catch { if (await page.locator('input[type=password]').count()) throw new SignedOut('signed out'); throw new Layout('Patient Information did not open (no card number field)'); }
  await page.fill('#Contnbr', ''); await page.fill('#txtReference', ''); await page.fill('#IndNbr', member);
  await page.click('#btnPatientInfo');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const html = await page.locator('#WorkArea').innerHTML().catch(() => '');
    if (/AdministrativeInfo\.cfm\?indnbr=/i.test(html)) return html;
    if (await page.locator('input[type=password]').count()) throw new SignedOut('signed out');
    if (i >= 4 && /no (record|data|result|patient)|not found|does not exist|invalid/i.test(html.replace(/<[^>]+>/g, ' '))) return null;
  }
  return null;
}

async function readMember(page, member) {
  const html = await search(page, member);
  if (!html) return { status: 'notfound', error: 'i-CARE Patient Information has no Administrative Info for this card number' };
  const m = html.match(/AdministrativeInfo\.cfm\?indnbr=(\d+)&(?:amp;)?contnbr=(\d+)/i);
  if (!m || m[1] !== member) return { status: 'notfound', error: 'i-CARE returned another member for this card number' };
  const rows = await rowsOf(page, '/assistance/AdministrativeInfo.cfm?indnbr=' + m[1] + '&contnbr=' + m[2]);
  if (!rows) throw new SignedOut('signed out');
  const A = parseAdmin(rows);
  if (A.missing.includes('name') || A.missing.includes('individual')) throw new Layout('Administrative Info: the usual labels (Adherent Name, Individual Number) are missing');
  if (A.admin.individual !== member) return { status: 'notfound', error: 'Administrative Info showed another member' };
  // Notice of Insurance Coverage: class of cover (In-Hospital / Out-Patient / Dental / Optical / Pharmacy)
  let classes = [];
  const cu = (html.match(/eligibility\/cov_desc\.cfm\?[^'"]+/i) || [])[0];
  if (cu) { const r2 = await rowsOf(page, '/' + cu.replace(/&amp;/g, '&')); if (r2) classes = parseClasses(r2); }
  // coverage report (limits): asked for right after the search (the report link is short-lived), checked to be this member
  let cov = null, limitsNote = '';
  for (let k = 0; k < 2 && !cov; k++) {
    if (k) await search(page, member);
    const rep = await page.evaluate(async () => { const t = await (await fetch('/assistance/DynamicCoverageDesc.cfm', { credentials: 'same-origin' })).text(); return (t.match(/location\.href\s*=\s*"([^"]+)"/) || [])[1] || ''; });
    if (!REPORTS.test(rep)) { limitsNote = 'i-CARE gave no coverage report link'; continue; }
    const res = await fetch(rep, { signal: AbortSignal.timeout(90000) });
    const buf = Buffer.from(await res.arrayBuffer());
    let C, IT; try { IT = pdfItems(buf); C = parseCoverage(IT); } catch (e) { limitsNote = 'the coverage report could not be read (' + safe(e.message) + ')'; continue; }
    // --dump <file> (test mode only): the limits area of the report (positions + text, the pages from the limits header on) for layout checks
    if (DUMP) { const h = IT.find((x) => x.s.trim() === 'Level'); const { writeFileSync } = await import('node:fs'); writeFileSync(DUMP, JSON.stringify(h ? IT.filter((x) => x.page > h.page || (x.page === h.page && x.y <= h.y + 3)).filter((x) => !/Beneficiary|Contract:/.test(x.s)) : [])); }
    if (C.cover.beneficiary !== member) { limitsNote = C.cover.beneficiary ? 'the coverage report showed another member' : 'the coverage report came back empty'; continue; }
    if (C.problems.length) { limitsNote = 'coverage report: ' + C.problems.join('; '); if (C.problems.includes('limits table not found')) await health('layout_changed', 'coverage report: the limits table (Level / Description / Financial Limit / Used / Balance) was not found'); }
    cov = C;
  }
  return { status: 'done', admin: A.admin, dependants: A.dependants, exclusions: A.exclusions, notes: A.notes, limits: cov ? cov.limits : [], cover: cov ? { ...cov.cover, classes } : { classes }, limitsNote: cov ? limitsNote : (limitsNote || 'limits not available'), fetchedAt: new Date().toISOString() };
}

let beat = Date.now();
setInterval(() => { if (Date.now() - beat > 8 * 60000) { log('watchdog: no progress for 8 min – restarting'); process.exit(3); } }, 30000);
async function main() {
  if (!SB || !TOKEN.startsWith('chp_')) { console.error('SUPABASE_URL and PORTAL_TOKEN are required (Start-IcareBridge.ps1 sets them)'); process.exit(2); }
  const test = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1] : '';
  const ctx = await chromium.launchPersistentContext(join(DATA, 'icare-profile'), { channel: 'chrome', headless: HEADLESS, viewport: { width: 1300, height: 900 } });
  if (HEADLESS) await ctx.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await login(page);
    if (test) {   // read-only test of one card number: prints what was found (field names, counts, limits) – nothing is sent
      const r = await readMember(page, String(test).replace(/\D/g, ''));
      const a = r.admin || {};
      console.log(JSON.stringify({ status: r.status, error: r.error, fields: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v ? (/date|start|expiry|dob/i.test(k) ? v : '[' + String(v).length + ' chars]') : '(empty)'])), dependants: (r.dependants || []).length, exclusions: (r.exclusions || []).length, limits: r.limits, cover: r.cover && { effective: r.cover.effective, expiry: r.cover.expiry, eligibility: r.cover.eligibility, classes: r.cover.classes, benefits: (r.cover.benefits || []).length }, limitsNote: r.limitsNote }, null, 1));
      await ctx.close(); return;
    }
    await health('ok', 'signed in');
    for (;;) {
      beat = Date.now();
      let jobs = [];
      try { const j = await call('icare_next', { limit: 1 }); jobs = j.jobs || []; if (j.off) { await health('ok', 'switched off in Sarwa Chronic'); await sleep(60000); continue; } }
      catch (e) { log('queue not reachable:', safe(e.message)); await sleep(60000); continue; }
      if (!jobs.length) { await health('ok', 'idle'); await sleep(POLL_MS); continue; }
      for (const job of jobs) {
        beat = Date.now(); let r;
        for (let k = 0; ; k++) {
          try { r = await readMember(page, job.member); break; }
          catch (e) {
            if (e instanceof SignedOut && k === 0) { log(job.ticket, 'signed out – signing in again'); await login(page); continue; }
            if (e instanceof Layout) { await health('layout_changed', e.message); r = { status: 'error', error: e.message }; break; }
            throw e;
          }
        }
        await call('icare_result', { id: job.id, ticket: job.ticket, member: job.member, ...r, error: r.error ? safe(r.error) : '' });
        done++; log(job.ticket, r.status, r.status === 'done' ? (r.limits.length + ' limit(s)' + (r.limitsNote ? ' – ' + r.limitsNote : '')) : safe(r.error));
        if (r.status !== 'error' || hState !== 'layout_changed') await health('ok', 'working');
        await sleep(GAP_MS);
      }
    }
  } catch (e) {
    const msg = safe(e.message || e);
    if (e instanceof Blocked) { await health(/no i-CARE account/.test(msg) ? 'no_account' : 'login_failed', msg); log('stopped: needs a person –', msg); await ctx.close().catch(() => { }); process.exit(10); }
    if (e instanceof Layout) { await health('layout_changed', msg); log('stopped:', msg); await ctx.close().catch(() => { }); process.exit(10); }
    await health('unreachable', msg); log('failed:', msg); await ctx.close().catch(() => { }); process.exit(4);
  }
}
main().then(() => process.exit(0), (e) => { log('crashed:', safe(e && e.stack || e)); process.exit(5); });
