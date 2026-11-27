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

// ---- CHR-000917 re-post: "Partially_Approved_Rejected" on the portal vs "Partially Approved Rejected" in the job ----
const K = load(bridge, ['mccStatusKey']);
ok(K.mccStatusKey('Partially_Approved_Rejected') === K.mccStatusKey('Partially Approved Rejected'), 'underscores and spaces are the same team status');
ok(K.mccStatusKey('Approved') !== K.mccStatusKey('Partially Approved Rejected'), 'different statuses stay different');
const sm = grab(bridge, 'submitMcc');
ok(/mccStatusKey\(l\['Team Action Status'\]\) === mccStatusKey\(job\.teamStatus\)/.test(sm), 'the Team Status submit compares statuses with mccStatusKey');
ok(/tl1\.filter\(mine\)\.length > before/.test(sm) && !/known\.has\(mccLineIdOf/.test(sm), 'confirmed by one more matching line (day-only dates make identical lines share an id)');
ok(/mcc_double_team_line/.test(srv), 'the server flags the same team decision twice on a Timeline');

// ---- CHR-001014: the signature phone became the member card; the subject's "-53809478" was skipped (28 Nov) ----
// synthetic numbers only (99xxxxxx / 5999xxxx), the shapes of the real cases
const C = load(app, ['normDigits', 'CARD_W', 'CARD_SRC', 'CARD_PHONE_BEFORE', 'CARD_NOT_BEFORE', 'CARD_YES_BEFORE', 'cardIsDate', 'cardCandidates', 'CARD_STATUS', 'sameName', 'memberVerdict', 'monthsSpan']);
const top = (parts, ctx) => (C.cardCandidates(parts, ctx)[0] || {}).no || '';
const sig = 'Regards,\nDr. Test\nMedical Officer\nT +20 2 99110008   Star M +201148555944\nM +201009593048';
ok(top([{ src: 'subject', text: 'NS-TESTCO-SOMEONE-59809478' }, { src: 'body', text: 'Please approve.\n' + sig }]) === '59809478', 'the subject ID after "-" wins over the signature phone');
ok(!C.cardCandidates([{ src: 'body', text: sig }]).some(c => c.no === '99110008'), 'an office phone in a signature is never a candidate');
ok(!C.cardCandidates([{ src: 'body', text: 'Tel: 25778724 / Mobile 01012345678' }]).length, '"Tel:" numbers are dropped');
ok(top([{ src: 'subject', text: 'FW: GR2892 - Test Alley - Chronic List - Policy 10303733' }]) === '', 'a policy number is not taken as the card');
ok(top([{ src: 'subject', text: 'TICKET/377056 #Testco 50048670# Chronic Renewal' }], { notMember: new Set(['50048670']) }) === '', 'a known contract number is never a card');
ok(top([{ src: 'subject', text: 'test delta || -10100144-1-10300140-1 || chronic || TEST NAME CN#59422481' }]) === '59422481', '"CN#" beats a policy-style number');
ok(top([{ src: 'subject', text: 'طلب علاج شهري رقم الكارنيه ٥٩٨٠٩٤٧٨' }]) === '59809478', 'Arabic digits and "رقم الكارنيه" are read');
ok(top([{ src: 'body', text: 'member id 14879295 please' }]) === '14879295', 'an ID that does not start with 5 is still accepted');
ok(top([{ src: 'body', text: 'date 20261127 and 27112026' }]) === '', 'dates are not cards');
ok(top([{ src: 'body', text: 'total 12345678 EGP' }]) === '', 'amounts are not cards');
const known = new Map([['59809478', { name: 'TEST MEMBER ONE', holder: 'Testco Metal', contract: '59990001' }]]);
const many = C.cardCandidates([{ src: 'body', text: 'card 59811111 or 59809478' }, { src: 'form', text: '59809478' }], { known });
ok(many[0].no === '59809478' && many.length === 2 && many[0].conf === 'high', 'several numbers: the one on the form and in the GlobeMed files ranks first');
ok(!C.cardCandidates([{ src: 'body', text: '59811111' }], { ignore: new Set(['59811111']) }).length, 'a number the team corrected away for this sender is ignored');
// verdicts
const ctx = { known, notMember: new Set(['59990001']) };
const vOf = (card, parts, x) => C.memberVerdict(card, C.cardCandidates(parts, ctx), ctx, x);
ok(vOf('59809478', [{ src: 'subject', text: 'X-59809478' }, { src: 'form', text: '59809478' }]).status === 'verified', 'subject + form + GlobeMed = Verified');
ok(vOf('59809478', [{ src: 'form', text: '59809478' }], { formName: 'Other Person Name' }).status === 'mismatch', 'a different name on the form = Mismatch');
ok(vOf('59809478', [{ src: 'form', text: '59809478' }], { formName: 'Test Member One' }).status === 'verified', 'same name = Verified');
ok(vOf('99110008', [{ src: 'subject', text: 'X-59809478' }, { src: 'body', text: '99110008' }]).status === 'mismatch', 'saved phone number while a known member is in the subject = Mismatch with the better one');
ok(vOf('59990001', []).status === 'mismatch', 'a contract number saved as the card = Mismatch');
ok(vOf('', []).status === 'notfound', 'no number anywhere = Not found');
ok(vOf('59809478', [{ src: 'subject', text: 'X-59809478' }]).status === 'review', 'one source and nothing confirming = Needs review');
ok(vOf('59809478', [{ src: 'subject', text: 'TESTCO METAL-59809478' }], { text: 'TESTCO METAL-59809478' }).status === 'verified', 'the company named in the request = Verified');
ok(vOf('59809478', [], { confirmed: 'Agent' }).status === 'verified', 'a person confirmed it = Verified');
// Till renewal date: whole months
ok(C.monthsSpan('2026-11-01', '2027-03-31') === 5 && C.monthsSpan('2026-11-18', '2027-03-17') === 4 && C.monthsSpan('2026-11-18', '2027-03-31') === 5, 'months until the renewal date');
const cv = grab(app, 'computeValidation');
ok(/till \? V\.renewalTo : addMonths\(from, months\)/.test(cv), '"Till renewal date" ends on the contract expiry');
ok(/if \(!cardOk\(CARD\) && !V\.mismatch\) return toast/.test(grab(app, 'validationDialog')), 'the validation cannot be saved without a verified card');
ok(/cardGate\(t, go\)/.test(grab(app, 'decisionDialog')) && /cardGate\(t, go\)/.test(grab(app, 'portalDecisionDialog')), 'Approved / Partial / Rejected need a verified card (email and Portal)');
ok(/Starting day must be/.test(grab(app, 'validationDialog')), 'a start on another day than the contract day is flagged');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
