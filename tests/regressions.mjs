// Regression tests for real failures (run: node tests/regressions.mjs). No network, no member data: synthetic texts only.
// The functions are taken from the app (index.html) and the bridge (tools/portal-bridge/bridge.mjs) as they are written there.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), bridge = fs.readFileSync(path.join(root, 'tools/portal-bridge/bridge.mjs'), 'utf8');
// the source of one top-level declaration: "const X = ...;" (one line) or "function X(...) { ... }" (to its closing brace)
function grab(src, name) {
  let i = src.search(new RegExp('^(?:async )?function ' + name + '\\b', 'm'));
  if (i >= 0) { let p = 0, k = src.indexOf('(', i); for (; k < src.length; k++) { if (src[k] === '(') p++; else if (src[k] === ')' && --p === 0) break; } let d = 0, j = src.indexOf('{', k); for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); }
  i = src.search(new RegExp('^const ' + name + '\\b', 'm')); if (i < 0) throw new Error('not found: ' + name);
  let d = 0, j = i; for (; j < src.length; j++) { const c = src[j]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ';' && d === 0) break; } return src.slice(i, j + 1);
}
const load = (src, names, extra = '') => new Function(extra + names.map((n) => grab(src, n)).join('\n') + '\nreturn {' + names.join(',') + '};')();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ', m); } };

// ---- CHR-000917 / CHR-000850: Call Center Team Comment over 1000 bytes (ORA-12899) ----
const A = load(app, ['MCC_COMMENT_MAX', 'portalBytes', 'MCC_BOILER', 'mccShorten', 'portalFinalConflict', 'confirmOtherTicketNo'], 'let __c = []; const confirm = (m) => { __c.push(m); return false; };\n');
const B = load(bridge, ['MCC_COMMENT_MAX', 'mccCommentBytes']);
// the real case: 903 characters, 13 new lines, 1287 UTF-8 bytes -> the portal counted 1300
const ar = 'دواء ', real = (ar.repeat(176) + 'x'.repeat(11) + '\n'.repeat(13)).slice(0, 903);
const utf8 = Buffer.byteLength(real, 'utf8'), nl = (real.match(/\n/g) || []).length;
ok(A.portalBytes(real) === utf8 + nl, 'app counts a new line as 2 bytes (CRLF)');
ok(B.mccCommentBytes(real) === A.portalBytes(real), 'bridge and app count the same');
ok(A.portalBytes('أ'.repeat(10) + '\n' + 'b') === 23, 'Arabic letter = 2 bytes, new line = 2, ASCII = 1');
ok(A.MCC_COMMENT_MAX === 1000 && B.MCC_COMMENT_MAX === 1000, 'the limit is 1000 bytes in both');
ok(A.portalBytes(real) > 1000, 'a 903-character Arabic comment is over the limit (as on the portal)');
const letter = ['السادة / شريكنا الموقر', 'تحية طيبة وبعد،،،', '',
  'بالإشارة إلى طلب الموافقة على الأدوية الشهرية المقدم للعضو / TEST MEMBER – رقم الكارت 99999999 (رقم التذكرة CHR-000001)، نحيط سيادتكم علماً بأنه بعد المراجعة الطبية تم اتخاذ القرار التالي:',
  '', 'أولاً: الأدوية المعتمدة', 'يمكن صرف الأدوية التالية بدءاً من 01/12/2026 وحتى 30/11/2027 وفقاً للجدول التالي:',
  '1 TESTMED A 10 mg 30 Tabs 1 × 1 يومياً', '2 TESTMED B 20 mg 30 Caps 1 × 1 يومياً', 'ثانياً: الأصناف غير المغطاة تأمينياً', 'TESTMED C: صنف غير مغطى تأمينياً', '', 'وتفضلوا بقبول فائق الاحترام', 'فريق الأدوية المزمنة'].join('\n');
const short = A.mccShorten(letter);
ok(!/السادة|تحية طيبة|بالإشارة|وتفضلوا|فريق الأدوية/.test(short), 'Shorten drops greeting, reference and closing');
ok(/TESTMED A/.test(short) && /TESTMED B/.test(short) && /غير مغطى/.test(short) && /الأدوية المعتمدة/.test(short), 'Shorten keeps the decision and every item');
ok(A.portalBytes(short) < A.portalBytes(letter) && A.portalBytes(short) <= 1000, 'Shorten brings the letter under 1000 bytes (' + A.portalBytes(letter) + ' -> ' + A.portalBytes(short) + ')');
// the bridge refuses before touching the portal
ok(/if \(bytes > MCC_COMMENT_MAX\) return \{ result: 'error'/.test(bridge) && bridge.indexOf('mccCommentBytes(job.message)') < bridge.indexOf("apex.item('P6_COMMENT')"), 'bridge checks the size before filling the Team Status form');

// ---- CHR-000898: a decision on a request already decided on the portal ----
ok(A.portalFinalConflict('the request is already Rejected on the portal'), 'recognises "already Rejected on the portal"');
ok(A.portalFinalConflict('Not posted: request 1 is already Partially approved on the portal – decided by X'), 'recognises the new message');
ok(!A.portalFinalConflict('status changed on the portal to Rejected') && !A.portalFinalConflict('portal refused the request page'), 'other refusals keep Try again');
ok(/if \(decision !== 'Message' && PORTAL_FINAL\.includes\(\+t\.portal\.statusCode\)\)/.test(grab(app, 'queuePortal')), 'the app checks a decided request BEFORE queuing');
const srv = fs.readFileSync(path.join(root, 'supabase/functions/portal/index.ts'), 'utf8');
ok(/async function conflictWhy/.test(srv) && /Try again cannot help/.test(srv), 'the server explains who decided and that Try again cannot help');
ok(/ORA-12899/.test(srv) && /Too long for the portal/.test(srv), 'the server turns ORA-12899 into words');
ok(/one alert per reply/.test(srv), 'one admin alert per failed reply');

// ---- a reply that names another ticket (CHR-000917's text named CHR-000908) ----
const t = { no: 'CHR-000917', mergedFrom: [], mergedInto: '' };
ok(A.confirmOtherTicketNo(t, 'رقم التذكرة CHR-000917') === true, 'own ticket number: no question');
ok(A.confirmOtherTicketNo(t, 'رقم التذكرة CHR-000908') === false, 'another ticket number: asks first (and stops when answered No)');
ok(A.confirmOtherTicketNo({ no: 'CHR-000917', mergedFrom: ['CHR-000908'] }, 'CHR-000908') === true, 'a merged ticket number is fine');

// ---- the same letter twice to the member (Message, then Approved with the same text: 5 times on 26 Nov) ----
const qp = grab(app, 'queuePortal'), cst = grab(app, 'confirmSameText');
ok(/return 'decision-only'/.test(cst) && /decision === 'Approved' && m\.decision === 'Message'/.test(cst), 'same text: "decision only" is offered for Approved after a Message');
ok(/if \(same === 'decision-only'\) text = ''/.test(qp) && qp.indexOf("same === 'decision-only'") < qp.indexOf('const html = textToHtml'), 'decision only posts no text (set before the job is built)');
// ---- 14 minutes of "login page not recognised" with no clue (26 Nov) ----
ok(/login page not recognised – \$\{what\}/.test(bridge) && /document\.title/.test(bridge), 'the bridge says what the portal showed instead of the sign-in form');
ok(/async function healthHtml/.test(srv) && /new_error_kind/.test(srv), 'daily health section + alert for a new kind of error');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
