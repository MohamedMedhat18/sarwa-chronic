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

// ---- CHR-001014: the signature phone became the member card; the subject's "-<card no.>" was skipped (28 Nov) ----
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
ok(top([{ src: 'subject', text: 'RE: Testco approval -59874285 Some Name' }]) === '59874285', '"approval -<card>" is still a card (CHR-000154)');
ok(top([{ src: 'body', text: 'Approval No. 12345678' }]) === '' && top([{ src: 'body', text: 'رقم الطلب 12345678' }]) === '', '"Approval No." / "رقم الطلب" numbers are not cards');
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

// ---- first monthly treatment in a contract: starting day 01 + edge cases (28 Nov 2026) ----
const S = load(app, ['pad', 'dmy', 'daysIn', 'isoOf', 'cycleStart', 'startSuggest']);
const ex = S.startSuggest({ day: 1, first: true, req: '2026-12-10', exp: '2027-01-05', eff: '2026-01-06' });
ok(ex.start === '2026-12-01' && ex.notes.some(n => /starting day must be 01/.test(n)) && !ex.warns.length, 'your example: expiry 05/01/2027, request 10/12/2026 → 01/12/2026, "starting day must be 01"');
ok(S.startSuggest({ day: 18, req: '2026-11-20', eff: '2026-02-18', exp: '2027-02-18' }).start === '2026-11-18', 'existing standard day 18 → current cycle 18/11');
ok(S.startSuggest({ day: 1, first: true, req: '2026-02-20', eff: '2026-02-18', exp: '2027-02-17' }).start === '2026-03-01', 'contract starts mid-month → the next 1st (never before the contract)');
ok(S.startSuggest({ day: 1, req: '2026-06-20', eff: '2026-01-01', elig: '2026-06-15', exp: '2026-12-31' }).start === '2026-07-01', 'member joined mid-year → the first cycle after the eligibility date');
const last = S.startSuggest({ day: 1, req: '2027-01-02', eff: '2026-01-06', exp: '2027-01-05' });
ok(last.start === '2027-01-01' && last.warns.some(w => /ends 05\/01\/2027/.test(w)), 'last month before expiry → warning, the renewal adds the next cycle');
ok(S.startSuggest({ day: 1, req: '2026-12-10' }).warns.some(w => /not known/.test(w)), 'unknown contract dates → warning, nothing guessed');
ok(S.startSuggest({ day: 1, req: '2027-02-10', exp: '2027-01-05', eff: '2026-01-06' }).warns.some(w => /before this start/.test(w)), 'a start after the expiry → no approval without the renewal');
ok(S.startSuggest({ day: 31, req: '2026-11-30', eff: '2026-01-01', exp: '2027-01-01' }).start === '2026-11-30', 'day 31 in a 30-day month = its last day (30/11)');
const CD = load(app, ['contractDay'], "const DB = { settings: { contractDays: { '1111': 5 } } }; const CARDS = { contracts: new Map([['2222', { start_day: 18, day_share: 0.9, members: 1 }]]) }; const holderDay = h => h === 'Old Holder' ? { day: 10, manual: false } : null;\n");
ok(CD.contractDay('3333', 'New Holder').firstTime && CD.contractDay('3333', 'New Holder').day === 1, 'no monthly treatment in the contract or holder → first one on 01');
ok(CD.contractDay('2222', 'New Holder').day === 18 && !CD.contractDay('2222', '').firstTime, 'one member already on day 18 → 18 for everyone after');
ok(CD.contractDay('3333', 'Old Holder').day === 10, 'new contract number of a holder with earlier treatment (renewal) → the holder day');
ok(CD.contractDay('1111', 'Old Holder').day === 5 && CD.contractDay('1111', '').manual, 'a day set by the team wins');
ok(/Starting day of the monthly dispensing/.test(grab(app, 'decisionEmail')), 'the reply names the starting day');

// ---- i-CARE reader (28 Nov 2026): parsers on synthetic copies of the real layouts (positions real, member data replaced) ----
const P = await import(new URL('../tools/portal-bridge/icare-parse.mjs', import.meta.url));
const covItems = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/icare-coverage-items.json'), 'utf8'));
const cov = P.parseCoverage(covItems);
ok(!cov.problems.length && cov.limits.length === 3, 'coverage report: 3 limit rows, no problem');
const [aml, drc, dv] = cov.limits;
ok(aml.level === 'AML' && aml.limit === 70000 && aml.used === 12345.678 && aml.balance === 57654.322, 'AML: limit, used and balance in the right columns');
ok(drc.level === 'Disease Related Condition' && drc.desc === 'Exception cases - Egypt' && drc.pool === 'Pool DRC' && drc.limit === 150000 && drc.balance === 88500, 'DRC pool row: two-line level, the red "Pool DRC" kept with its own row');
ok(dv.desc === 'Doctors Visit' && dv.perTransaction && dv.limit === 300 && dv.used === null, 'Doctors Visit: per transaction');
ok(cov.cover.beneficiary === '59999999' && cov.cover.effective === '01/04/2026' && cov.cover.expiry === '01/04/2027' && cov.cover.eligibility === '01/04/2026', 'coverage report: beneficiary, contract dates, eligibility');
ok(cov.cover.conditions.includes('Chronic related conditions - Egypt') && cov.cover.benefits.some(b => /copayment/i.test(b)), 'coverage report: disease conditions and restrictions');
// a limits table with many rows (synthetic: the same columns, 12 rows)
const lvl = covItems.find(i => i.s.trim() === 'Level'); const hdr = covItems.filter(i => i.page === lvl.page && Math.abs(i.y - lvl.y) < 3 && ['Level', 'Description', 'Curr', 'Financial Limit', 'Used', 'Balance'].includes(i.s.trim()));
const X = Object.fromEntries(hdr.map(h => [h.s.trim(), h.x])), Y = hdr[0].y, pg = hdr[0].page;
const manyRows = [...hdr]; for (let i = 0; i < 12; i++) { const y = Y - 20 - i * 14; manyRows.push({ page: pg, x: X.Level, y, s: 'Sub Category' }, { page: pg, x: X.Description, y, s: 'Test item ' + i }, { page: pg, x: X.Curr, y, s: 'EGP' }, { page: pg, x: X['Financial Limit'] + 10, y, s: (1000 + i) + '.000' }, { page: pg, x: X.Used + 10, y, s: (100 + i) + '.000' }, { page: pg, x: X.Balance + 10, y, s: (900) + '.000' }); }
manyRows.push({ page: pg, x: 40, y: 200, s: 'COVERAGE DESCRIPTION' }, { page: pg, x: 40, y: 190, s: '- Beneficiary Number: 59999999' });
const mr = P.parseCoverage(manyRows);
ok(mr.limits.length === 12 && mr.limits[11].desc === 'Test item 11' && mr.limits[11].limit === 1011 && mr.limits.every(l => l.balance === 900), 'a limits table with 12 rows: every row, every column');
// a level printed once for a group of rows (first run: "Disease Related Condition" over 3 conditions) – the rows below take it
const grp = [...hdr]; ['Disease Related Condition', '', ''].forEach((lv, i) => { const y = Y - 20 - i * 14; if (lv) grp.push({ page: pg, x: X.Level, y, s: lv }); grp.push({ page: pg, x: X.Description, y, s: 'Condition ' + i }, { page: pg, x: X.Curr, y, s: 'EGP' }, { page: pg, x: X['Financial Limit'] + 10, y, s: '1000.000' }, { page: pg, x: X.Used + 10, y, s: '10.000' }, { page: pg, x: X.Balance + 10, y, s: '990.000' }); });
grp.push({ page: pg, x: 40, y: 200, s: 'COVERAGE DESCRIPTION' });
const gr = P.parseCoverage(grp);
ok(gr.limits.length === 3 && gr.limits.every(l => l.level === 'Disease Related Condition') && !gr.problems.length, 'a level printed once for a group: every row of the group gets it, no "could not be read"');
// first run: a grouped report (two-line group level, a four-line description, pool, per transaction) – limits area only
const gItems = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/icare-limits-grouped.json'), 'utf8')); gItems.push({ page: 1, x: 40, y: 700, s: 'COVERAGE DESCRIPTION' });
const gp = P.parseCoverage(gItems);
ok(!gp.problems.length && gp.limits.length === 8 && gp.limits.filter(l => l.level === 'Disease Related Condition').length === 3, 'grouped report: 8 rows, a two-line group level on all 3 rows of its group');
ok(/Medical \/ Legal abortion \/ Miscarriage$/.test(gp.limits[4].desc) && gp.limits[5].pool === 'Pool DRC' && gp.limits[7].perTransaction && gp.limits[7].curr === 'EGP', 'grouped report: every line of a long description, the pool on its own row, no page number in Curr');
// the table goes on to the next page: rows there are read, the next page's header block (member name) is not
const cont = gItems.map(x => ({ ...x })); for (const x of cont) if (x.y < 140 && x.y > 100) { x.page = 2; x.y += 400; }
cont.push({ page: 2, x: 120, y: 651, s: 'TEST MEMBER NAME' }, { page: 2, x: 52, y: 651, s: 'Beneficiary :' }, { page: 2, x: 120, y: 669, s: 'TESTCO' }, { page: 2, x: 52, y: 669, s: 'Contract:' }, { page: 1, x: 297, y: 65, s: '1 / 2' });
const cp = P.parseCoverage(cont);
ok(cp.limits.length === 8 && cp.limits[7].desc === 'Doctors Visit' && !cp.limits.some(l => /TEST MEMBER|TESTCO/.test(l.desc + l.level)), 'a table that goes on to the next page: its rows are read, the page header (member name) is not');
// "Combined POOL DRC Limitation for: …" is a description, not the pool marker (CHR-001032, first run)
const pl = gItems.map(x => ({ ...x })); const cmb = pl.find(x => x.s.trim() === 'Combined DRC Limitation for:'); cmb.s = 'Combined POOL DRC Limitation';
const plr = P.parseCoverage(pl).limits[4];
ok(/^Combined POOL DRC Limitation • Normal delivery/.test(plr.desc) && plr.pool === '', 'a description with the word POOL stays whole; only the separate "Pool DRC" label is the pool');
// the report that comes back empty (the i-CARE link expired / another session): no table, no beneficiary → nothing saved
const empty = P.parseCoverage([{ page: 1, x: 300, y: 740, s: 'COVERAGE DESCRIPTION' }, { page: 1, x: 40, y: 700, s: 'Contract:' }]);
ok(empty.problems.includes('limits table not found') && empty.cover.beneficiary === '', 'empty report: "limits table not found", no beneficiary');
ok(/C\.cover\.beneficiary !== member/.test(fs.readFileSync(path.join(root, 'tools/portal-bridge/icare-bridge.mjs'), 'utf8')), 'the reader checks the report belongs to the member (else retries / "Not available")');
const adm = P.parseAdmin(JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/icare-admin-rows.json'), 'utf8')));
ok(!adm.missing.length && adm.admin.name === 'TEST MEMBER ONE' && adm.admin.individual === '59999999' && adm.admin.contract === '59990001' && adm.admin.expiry === '01/04/2027' && adm.admin.start === '01/04/2026' && adm.admin.gr === 'No', 'Administrative Info: every label ("Contract Expiey Date" spelling included)');
ok(adm.dependants.length === 1 && adm.dependants[0]['Adherent Eligibility Date'] === '01/04/2026 - Active' && adm.exclusions.length === 1 && adm.exclusions[0]['Max per Year'] === '5000' && adm.notes === '', 'Administrative Info: dependants, exclusions, no notes');
ok(P.parseAdmin([['Something else', 'x']]).missing.includes('name'), 'a page without the usual labels → "layout changed", nothing guessed');
const rd = fs.readFileSync(path.join(root, 'tools/portal-bridge/icare-bridge.mjs'), 'utf8');
ok(/SignedOut && k === 0\) \{ log\(job\.ticket, 'signed out – signing in again'\); await login\(page\)/.test(rd), 'signed out → signs in again once per job');
ok(/throw new Blocked\('i-CARE did not accept the sign-in'/.test(rd) && /process\.exit\(10\)/.test(rd), 'sign-in refused → stop + health alert (no retry loop)');
ok(/AbortSignal\.timeout\(90000\)/.test(rd) && /health\('unreachable'/.test(rd), 'a timeout → "unreachable" health, the job is given out again later');
ok(/const safe = \(s\) => norm\(s\)\.replace\(\/\\d\{6,\}\/g, '#'\)/.test(rd) && !/console\.log\([^)]*admin\.name/.test(rd), 'no member numbers or names in the reader log');
ok(/if \(admin\.individual !== member\) return \{ error: 'the details belong to another member/.test(srv) && /icare_config'\)\)\.off === true/.test(srv), 'server: saves only the asked member; kill switch');

// ---- limits (28 Nov 2026): the chronic limit is ONE combined line for chronic + pre-existing; dental / sight / other DRC lines
// are not chronic; no combined line = up to AML (CHR-001044 / CHR-001063 showed dental / sight lines as "Chronic") ----
const LM = load(app, ['esc', 'limitKind', 'LIMIT_LABEL', 'limitName', 'chronicLimit', 'limitLevel', 'fmtEgp', 'limitStatus', 'limitCoverage', 'limitReplyHtml', 'confirmLimitContradiction'], "let __asked = []; const confirm = m => { __asked.push(m); return false; }; const fmtDate = x => String(x || ''); const __get = () => __asked;\n");
const L = (level, desc, limit, used, balance, perTransaction) => ({ level, desc, limit, used, balance, perTransaction: !!perTransaction });
const ex30 = [L('AML', 'Annual Maximum Limit', 120000, 6717.272, 113282.728), L('Sub Category', 'Dental', 500, 0, 500), L('Disease Related Condition', 'Combined DRC Limitation for: • Chronic related conditions - Egypt • Pre-existing conditions - Egypt', 30000, 5791.912, 24208.088), L('Disease Related Condition', 'Dental related conditions', 500, 0, 500), L('Sub Category', 'Doctors Visit', 300, null, null, true)];
const c30 = LM.chronicLimit(ex30);
ok(c30.kind === 'combined' && c30.limit === 30000 && c30.effective === 24208.088 && LM.limitKind(ex30[3]) === 'dental_drc', 'the 30,000 report: the combined line is the chronic limit (24,208.088 left); "Dental related conditions" is dental');
ok(/^Chronic & Pre-existing limit – • Chronic related conditions/.test(LM.limitName(ex30[2])) && LM.limitName(ex30[3]) === 'Dental – related conditions', 'names: "Chronic & Pre-existing limit – …", "Dental – related conditions"');
const ex125 = [L('AML', 'Annual Maximum Limit', 125000, 88694.1, 36305.9), L('Sub Category', 'Dental', 1500, 0, 1500), L('Sub Category', 'Optical', 950, 0, 950), L('Disease Related Condition', 'Dental related conditions', 1500, 0, 1500), L('Disease Related Condition', 'Sight related conditions', 950, 0, 950), L('Sub Category', 'Doctors Visit', 300, null, null, true)];
const c125 = LM.chronicLimit(ex125), s125 = LM.limitStatus({ limits: ex125 });
ok(c125.kind === 'aml' && c125.effective === 36305.9 && s125.some(([k, x]) => /covered up to AML, balance = AML balance \(36,305\.9\)/.test(x)), 'the 125,000 report (CHR-001044): no combined line → "covered up to AML", balance 36,305.9');
ok(!s125.some(([, x]) => /Chronic.*(almost|used:)|DRC/i.test(x)) && LM.limitName(ex125[4]) === 'Optical – related conditions', 'CHR-001044: no "Chronic (DRC) almost used" for the dental / sight lines any more');
const ex1063 = [L('AML', 'Annual Maximum Limit', 100000, 20000, 80000), L('Disease Related Condition', 'Dental related conditions', 1000, 0, 1000), L('Disease Related Condition', 'Sight related conditions', 400, 92, 308)];
ok(LM.chronicLimit(ex1063).kind === 'aml' && LM.chronicLimit(ex1063).effective === 80000, 'CHR-001063: dental / sight DRC lines are not the chronic limit → up to AML');
ok(LM.limitKind(L('Disease Related Condition', 'Exception cases - Egypt', 1, 0, 1)) === 'exception_drc' && LM.limitKind(L('Disease Related Condition', 'Congenital related conditions', 1, 0, 1)) === 'congenital_drc' && LM.limitKind(L('Disease Related Condition', 'Combined DRC Limitation for: • Normal delivery • Complications of pregnancy', 1, 0, 1)) === 'maternity_drc', 'exception / congenital / maternity lines are named and not chronic');
ok(LM.limitKind(L('Disease Related Condition', 'Combined POOL DRC Limitation for: • Chronic related conditions • Pre-existing conditions', 1, 0, 1)) === 'chronic' && LM.limitKind(L('Disease Related Condition', 'Chronic related conditions - Egypt', 1, 0, 1)) === 'chronic_only' && LM.chronicLimit([L('Disease Related Condition', 'Chronic related conditions - Egypt', 9, 0, 9)]).check, '"Combined POOL DRC … Chronic … Pre-existing" is chronic; a chronic-only line is used with a "check" mark');
ok(LM.limitKind(L('Disease Related Condition', 'Something new', 1, 0, 1)) === 'other_drc' && /needs review/.test(LM.LIMIT_LABEL.other_drc) && LM.limitStatus({ limits: [L('AML', 'Annual Maximum Limit', 10, 0, 10), L('Disease Related Condition', 'Something new', 1, 0, 1)] }).some(([, x]) => /could not be classified/.test(x)), 'an unknown DRC line → "Other DRC line (needs review)", never used for decisions');
const capped = LM.chronicLimit([L('AML', 'Annual Maximum Limit', 100000, 95000, 5000), ex30[2]]);
ok(capped.effective === 5000 && capped.cappedByAml, 'the chronic balance is capped by the AML balance');
// exhausted / thresholds
const amlEx = [L('AML', 'Annual Maximum Limit', 70000, 70000, 0), ex30[2]];
ok(LM.limitStatus({ limits: amlEx }).some(([k, x]) => k === 'bad' && /المخصص المالي السنوي تم استنفاذه/.test(x)) && LM.chronicLimit(amlEx).effective === 0, 'AML exhausted → red note "المخصص المالي السنوي تم استنفاذه", nothing usable for chronic');
const chEx = [L('AML', 'Annual Maximum Limit', 70000, 10000, 60000), L('Disease Related Condition', 'Combined DRC Limitation for: • Chronic related conditions • Pre-existing conditions', 30000, 30000, 0)];
ok(LM.limitStatus({ limits: chEx }).some(([k, x]) => k === 'bad' && /المخصص المالي الخاص بالأمراض المزمنة والسابقة عن التعاقد تم استنفاذه/.test(x)), 'chronic limit exhausted → red note with the team wording');
ok(LM.limitLevel(1000, 150) === 'amber' && LM.limitLevel(1000, 250) === 'ok' && LM.limitLevel(1000, 100) === 'red' && LM.limitLevel(1000, 0) === 'exhausted' && LM.limitLevel(1000, 500) === 'ok', 'levels: 80% used amber, 90% red, 100% exhausted');
ok(LM.limitCoverage({ effective: 1000 }, 400, 3).level === 'partial' && LM.limitCoverage({ effective: 1000 }, 400, 3).months === 2 && LM.limitCoverage({ effective: 300 }, 400, 3).level === 'short' && LM.limitCoverage({ effective: 0 }, 400, 3).level === 'exhausted' && LM.limitCoverage({ effective: 5000 }, 400, 3).level === 'ok', 'partial balance: about 2 of 3 months; less than a month; exhausted; enough');
// replies (the team's own Arabic wording) and the contradiction check
const tk = { no: 'CHR-000001', member: '59999999', memberName: 'TEST MEMBER', icare: { limits: amlEx, fetchedAt: 'x' } };
ok(/المخصص المالي السنوي تم استنفاذه ولذلك نعتذر عن التغطية التأمينية/.test(LM.limitReplyHtml(tk, 'aml', 'AR')) && /annual financial limit has been fully used/.test(LM.limitReplyHtml(tk, 'aml', 'EN')), 'AML exhausted reply: Arabic (exact wording) and English');
ok(/المخصص المالي الخاص بالأمراض المزمنة والسابقة عن التعاقد تم استنفاذه/.test(LM.limitReplyHtml(tk, 'chronic', 'AR')) && /chronic and pre-existing conditions has been fully used/.test(LM.limitReplyHtml(tk, 'chronic', 'EN')) && /من 01\/12\/2026 حتى 28\/02\/2027.*1,500/.test(LM.limitReplyHtml(tk, 'partial', 'AR', { from: '01/12/2026', to: '28/02/2027', amount: 1500 })), 'chronic exhausted and partial replies, with the amount and period filled in');
ok(LM.confirmLimitContradiction(tk, 'يمكن صرف الأدوية التالية', '') === false, 'an approving reply while the limit is exhausted is asked about first');
ok(LM.confirmLimitContradiction(tk, LM.limitReplyHtml(tk, 'aml', 'AR').replace(/<[^>]+>/g, ' '), '') === true && LM.confirmLimitContradiction(tk, 'any text', 'Approved') === false && LM.confirmLimitContradiction({ ...tk, icare: { limits: ex30 } }, 'approved', 'Approved') === true, 'the exhausted reply itself, or a balance left, is not asked about');
// app and server classify the same way
const srvLK = new Function(grab(srv, 'limitKind').replace(/: any/g, '') + '\n' + grab(srv, 'chronicLimit').replace(/: any/g, '') + '\nreturn { limitKind, chronicLimit };')();
const samples = [...ex30, ...ex125, ...ex1063, ...chEx, L('Disease Related Condition', 'Exception cases - Egypt', 1, 0, 1), L('Disease Related Condition', 'Combined POOL DRC Limitation for: • Normal delivery', 1, 0, 1)];
ok(samples.every(s => srvLK.limitKind(s) === LM.limitKind(s)) && srvLK.chronicLimit(ex30).effective === c30.effective && srvLK.chronicLimit(ex125).kind === 'aml', 'the server (monthly report) and the app classify every line the same way');
ok(/if \(!confirmLimitContradiction\(t, msg\.value, d\)\)/.test(app) && /!confirmLimitContradiction\(t, htmlToPlain\(body\)/.test(app), 'the check runs before Email / Info Desk replies and Portal decisions');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
