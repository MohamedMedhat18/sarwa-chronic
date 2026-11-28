// i-CARE parsing for the i-CARE reader (icare-bridge.mjs). Pure functions, no network, no member data stored.
// Layouts studied read-only on the live i-CARE on 28 Nov 2026:
//  - Administrative Info (assistance/AdministrativeInfo.cfm): label / value table rows + Dependants, Exclusions / Limitations on
//    Diseases, Medical Questionnaire, Adherent / Contract Special Notes.
//  - Eligibility Details → GlobeMed report server PDF "COVERAGE DESCRIPTION – HEALTH CARE BENEFIT DETAILS" (Oracle Reports:
//    ASCII85 + Flate streams, Identity-H fonts with ToUnicode maps). The limits table is read by position (columns by header x).
//  - Notice of Insurance Coverage (eligibility/cov_desc.cfm): class of cover rows (In-Hospital, Out-Patient, … Covered / Not Covered).
import zlib from 'node:zlib';

// ---------------- Administrative Info ----------------
const ADMIN_LABELS = [['Risk Carrier', 'riskCarrier'], ['Holder Name', 'holder'], ['Adherent Name', 'name'], ['Individual Number', 'individual'], ['Insured Mobile Number', 'mobile'],
  ['Adherent Class', 'cls'], ['Contract Number', 'contract'], ['Contract Type', 'contractType'], ['Date of Birth', 'dob'], ['Relation', 'relation'], ['Gender', 'gender'], ['Marital Status', 'marital'],
  ['GlobeMed Baby', 'baby'], ['Starting Date', 'start'], [/^Contract Expi\w* Date$/i, 'expiry'], ['U/W Flag', 'uw'], ['Questionnaire Date', 'questionnaire'], ['GR', 'gr'], ['GR Date', 'grDate'],
  ['Blacklisting Date', 'blacklistDate'], ['Blacklisting Reason', 'blacklistReason']];
const keyOf = (label) => { const l = String(label || '').replace(/\s*:\s*$/, '').trim(); for (const [k, v] of ADMIN_LABELS) if (k instanceof RegExp ? k.test(l) : k.toLowerCase() === l.toLowerCase()) return v; return null; };
// rows: the page's table rows (no nested tables) as arrays of cell texts
export function parseAdmin(rows) {
  const admin = {}, out = { admin, dependants: [], exclusions: [], notes: '', missing: [] };
  let sect = '', head = null;
  for (const r0 of rows) {
    const r = r0.map((c) => String(c || '').replace(/\s+/g, ' ').trim()); const joined = r.join(' ').trim(); if (!joined) continue;
    if (/^Dependants$/i.test(joined)) { sect = 'dep'; head = null; continue; }
    if (/^Exclusions \/ Limitations on Diseases$/i.test(joined)) { sect = 'exc'; head = null; continue; }
    if (/^Medical Questionnaire$/i.test(joined)) { sect = 'q'; head = null; continue; }
    if (/^(Adherent|Contract) Special Notes$/i.test(joined)) { sect = 'notes'; head = null; continue; }
    if (sect === 'dep' || sect === 'exc') {
      if (!head) { head = r; continue; }
      if (r.length >= 2) out[sect === 'dep' ? 'dependants' : 'exclusions'].push(Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
      continue;
    }
    if (sect === 'notes') { if (!/^No Notes available/i.test(joined)) out.notes = (out.notes + ' ' + joined).trim().slice(0, 600); continue; }
    if (sect === 'q') continue;
    for (let i = 0; i < r.length; i++) { const k = keyOf(r[i]); if (k && !(k in admin)) { admin[k] = (r[i + 1] && !keyOf(r[i + 1])) ? r[i + 1] : ''; i++; } }
  }
  admin.individual = String(admin.individual || '').replace(/\D/g, '');
  for (const k of ['name', 'individual', 'contract', 'expiry']) if (!admin[k]) out.missing.push(k);
  return out;
}
// Notice of Insurance Coverage: "I. IN-Hospital Coverage | Covered"
export function parseClasses(rows) {
  const out = [];
  for (const r of rows) { const a = String(r[0] || '').trim(), b = String(r[1] || '').trim(); const m = a.match(/^[IVX]+\.\s*(.+?)$/); if (m && /covered/i.test(b)) out.push({ name: m[1].replace(/\s+/g, ' ').trim(), covered: /not covered/i.test(b) ? 'Not covered' : 'Covered' }); }
  return out;
}

// ---------------- PDF (text items with positions) ----------------
function a85(buf) {
  const s = buf.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, ''); const out = []; let g = [];
  for (const ch of s) {
    if (ch === 'z' && !g.length) { out.push(0, 0, 0, 0); continue; }
    g.push(ch.charCodeAt(0) - 33); if (g.length === 5) { let n = 0; for (const v of g) n = n * 85 + v; out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); g = []; }
  }
  if (g.length) { const k = g.length; while (g.length < 5) g.push(84); let n = 0; for (const v of g) n = n * 85 + v; out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, k - 1)); }
  return Buffer.from(out);
}
function pdfObjects(buf) {
  const s = buf.toString('latin1'); const objs = new Map(); const re = /(\d+)\s+0\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    const end = s.indexOf('endobj', m.index); if (end < 0) break;
    const body = s.slice(m.index + m[0].length, end); const si = body.search(/stream\r?\n/);
    if (si < 0) { objs.set(+m[1], { dict: body, data: null }); continue; }
    const dict = body.slice(0, si); const st = m.index + m[0].length + si + body.slice(si).match(/stream\r?\n/)[0].length;
    let d = buf.subarray(st, s.indexOf('endstream', st));
    for (const f of ((dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [, ''])[1].match(/\/\w+/g) || [])) {
      try { if (f === '/ASCII85Decode') d = a85(d); else if (f === '/FlateDecode') d = zlib.inflateSync(d, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { d = null; break; }
    }
    objs.set(+m[1], { dict, data: d });
  }
  return objs;
}
function toUnicode(text) {
  const map = new Map(); const uni = (h) => String.fromCodePoint(...(h.match(/.{4}/g) || []).map((x) => parseInt(x, 16)));
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(p[1], 16), uni(p[2]));
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) { const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16), st = parseInt(p[3], 16); for (let c = lo; c <= hi && c - lo < 5000; c++) map.set(c, String.fromCodePoint(st + c - lo)); }
  return map;
}
// every text piece with its page and position (x, y from the bottom-left, like the PDF)
export function pdfItems(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
  const objs = pdfObjects(buf); const fonts = new Map();
  for (const [n, o] of objs) { const tu = o.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/); const t = tu && objs.get(+tu[1]); if (t && t.data) fonts.set(n, toUnicode(t.data.toString('latin1'))); }
  const items = []; let page = 0;
  const pages = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict)).sort((a, b) => a[0] - b[0]);
  for (const [, o] of pages) {
    page++;
    let res = o.dict; const rr = o.dict.match(/\/Resources\s+(\d+)\s+0\s+R/); if (rr && objs.get(+rr[1])) res = objs.get(+rr[1]).dict;
    let fd = (res.match(/\/Font\s*<<([^>]*)>>/) || [, ''])[1]; const fr = res.match(/\/Font\s+(\d+)\s+0\s+R/); if (fr && objs.get(+fr[1])) fd = objs.get(+fr[1]).dict;
    const names = new Map([...fd.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)].map((x) => [x[1], fonts.get(+x[2])]));
    for (const r of ((o.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/) || [, ''])[1].matchAll(/(\d+)\s+0\s+R/g))) {
      const c = objs.get(+r[1]); if (!c || !c.data) continue; const t = c.data.toString('latin1');
      let cur = null, lx = 0, ly = 0;
      const dec = (h) => { h = h.replace(/\s/g, ''); let s2 = ''; for (let i = 0; i < h.length; i += 4) s2 += (cur && cur.get(parseInt(h.slice(i, i + 4), 16))) || ''; return s2; };
      const tok = /\/(\w+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\[((?:<[^>]*>|[^\]])*)\]\s*TJ|([-\d.]+)\s+([-\d.]+)\s+T[dD]|[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s+Tm|\bBT\b/g; let k;
      while ((k = tok.exec(t))) {
        if (k[1]) { cur = names.get(k[1]) || null; continue; }
        if (k[0] === 'BT') { lx = 0; ly = 0; continue; }
        if (k[4] != null) { lx += +k[4]; ly += +k[5]; continue; }
        if (k[6] != null) { lx = +k[6]; ly = +k[7]; continue; }
        let s2 = ''; if (k[2] != null) s2 = dec(k[2]); else if (k[3] != null) for (const p of k[3].matchAll(/<([0-9A-Fa-f\s]*)>|(-?[\d.]+)/g)) s2 += p[1] != null ? dec(p[1]) : (+p[2] < -200 ? ' ' : '');
        if (s2.trim()) { const last = items[items.length - 1]; if (last && last.page === page && Math.abs(last.y - ly) < 0.5 && Math.abs(last.x - lx) < 0.5) last.s += s2; else items.push({ page, x: Math.round(lx * 10) / 10, y: Math.round(ly * 10) / 10, s: s2 }); }
      }
    }
  }
  return items;
}
// the page's text as lines (top to bottom, left to right)
export function pdfLines(items) {
  const by = new Map(); for (const it of items) { const k = it.page + ':' + Math.round(it.y); (by.get(k) || by.set(k, []).get(k)).push(it); }
  return [...by.entries()].sort((a, b) => { const [pa, ya] = a[0].split(':').map(Number), [pb, yb] = b[0].split(':').map(Number); return pa - pb || yb - ya; }).map(([, v]) => v.sort((a, b) => a.x - b.x).map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim());
}
const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : null; };
// the coverage report → { cover, limits, problems }
export function parseCoverage(items) {
  const lines = pdfLines(items); const text = lines.join('\n'); const problems = [];
  const g = (re) => ((text.match(re) || [])[1] || '').trim();
  const cover = {
    holder: g(/Policy Holder\s*:\s*([^\n]+)/i), effective: g(/Effective Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i), expiry: g(/Expiry Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i),
    beneficiary: g(/Beneficiary Number\s*:\s*(\d+)/i), eligibility: g(/Beneficiary Eligibility Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i), cls: g(/Class of Coverage\s*:\s*([^\n]+)/i),
    sheet: g(/Technical Sheet Name\s*:\s*([^\n]+)/i), annualMax: g(/maximum limitation by Beneficiary per year is ([\d,.]+\s*\w*)/i), printed: g(/Printed On:\s*(\w+ \d{1,2}, \d{4})/i) || g(/^(\w+ \d{1,2}, \d{4})$/m),
    // restrictions as printed ("Inside copayment 20% no add on DRC", "Reimbursement Penalty 20%Outside")
    benefits: [...new Set(items.map((it) => it.s.trim()).filter((s) => /^•/.test(s)).map((s) => s.replace(/^•\s*/, '').trim()).filter((s) => s && !/^\*|maximum limitation|- Egypt$|COVID/i.test(s)))].slice(0, 30),
    conditions: [...new Set(lines.flatMap((l) => l.split(/•/)).map((l) => l.trim()).filter((l) => /-\s*Egypt$|COVID/i.test(l)))].slice(0, 20),
  };
  if (!/COVERAGE DESCRIPTION/i.test(text)) problems.push('not the coverage report');
  // limits table: the header row Level / Description / Curr / Financial Limit / Used / Balance (same page, same height)
  const H = ['Level', 'Description', 'Curr', 'Financial Limit', 'Used', 'Balance'];
  const heads = items.filter((it) => H.includes(it.s.trim()));
  let hdr = null;
  for (const lv of heads.filter((h) => h.s.trim() === 'Level')) { const row = H.map((h) => heads.find((x) => x.s.trim() === h && x.page === lv.page && Math.abs(x.y - lv.y) < 3)); if (row.every(Boolean)) { hdr = row; break; } }
  const limits = [];
  if (!hdr) { problems.push('limits table not found'); return { cover, limits, problems, lines }; }
  const page = hdr[0].page, hy = hdr[0].y, xs = hdr.map((h) => h.x);
  const colOf = (x) => { let c = -1; for (let i = 0; i < xs.length; i++) if (x >= xs[i] - 4) c = i; return c; };
  // rows end at the next section title / the page footer
  const body = items.filter((it) => it.page === page && it.y < hy - 2 && !H.includes(it.s.trim()));
  const stop = body.filter((it) => /^\d+-\s|Please refer|Pool limitation|GlobeMed offers/i.test(it.s)).reduce((m, it) => Math.max(m, it.y), -Infinity);
  const cells = body.filter((it) => it.y > stop && colOf(it.x) >= 0);
  const anchors = cells.filter((it) => colOf(it.x) === 3 && num(it.s) != null).sort((a, b) => b.y - a.y);
  if (!anchors.length) problems.push('no limit rows');
  const rows = anchors.map((a) => ({ y: a.y, c: [[], [], [], [], [], []] }));
  // a row starts at its limit amount and continues below it ("Disease Related" / "Condition", the red "Pool DRC" under the
  // description): each piece belongs to the nearest row at or above it
  for (const it of cells) {
    if (!rows.length) break;
    const above = rows.filter((r) => r.y >= it.y - 3); let best = above.length ? above[above.length - 1] : rows[0];
    if (!above.length) for (const r of rows) if (Math.abs(r.y - it.y) < Math.abs(best.y - it.y)) best = r;
    if (Math.abs(best.y - it.y) < 30) best.c[colOf(it.x)].push(it);
  }
  for (const r of rows) {
    const t = (i) => r.c[i].sort((a, b) => b.y - a.y || a.x - b.x).map((x) => x.s.trim()).join(' ').replace(/\s+/g, ' ').trim();
    const desc = t(1), used = t(4);
    const pool = (desc.match(/\bPool\b.*$/i) || [''])[0];
    limits.push({ level: t(0), desc: desc.replace(/\s*\bPool\b.*$/i, '').trim(), pool, curr: t(2), limit: num(t(3)), used: /per transaction/i.test(used) ? null : num(used), balance: num(t(5)), perTransaction: /per transaction/i.test(used) });
  }
  for (const l of limits) if (l.limit == null || !l.level) problems.push('a limit row could not be read');
  return { cover, limits, problems, lines };
}
