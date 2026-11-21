// Sarwa portal agent - runs INSIDE a signed-in Chronic Attach page (page 165), next to portal-reader.js.
// OUT: takes the reply jobs the server hands out (only with dry run OFF and only for requests on the live list), fills the
//      portal's own Reply form (page 168: Language -> Status -> the portal writes its template -> our text in #comment# ->
//      files in the upload box), saves it, and reports "sent" ONLY after the new entry is seen in the Request Timeline.
//      The portal then sends the WhatsApp message (member) or the email (broker) itself.
// IN:  every few minutes: new / changed requests with timeline and files -> Sarwa Chronic (bridge_ingest), history, reconcile.
// Safety: a request decided by someone else is not overwritten (conflict); an earlier attempt that went through is
// detected before any resend; Off in Settings > Portal stops everything; the token is kept in memory only.
(function () {
  if (!window.SarwaPortalReader) throw new Error('load portal-reader.js first');
  const R = window.SarwaPortalReader;
  const STATUS = { Assigned: 1, Processing: 2, Pending: 3, Closed: 4, Approved: 5, Partially_Approved_Pending: 6, 'Partially Approved Pending': 6, Partially_Approved_Rejected: 7, 'Partially Approved Rejected': 7, Rejected: 8, Reopened: 9 };
  const NAME = { 3: 'Pending', 5: 'Approved', 6: 'Partially_Approved_Pending', 7: 'Partially_Approved_Rejected', 8: 'Rejected' };
  const FINAL = new Set([4, 5, 7, 8]);
  const ACCEPTED = ['3', '5', '6', '7', '8'];
  const SEARCH_BTN = 'B500203752390221333';   // page 165 "Search" (refreshes the report with the Status Filter)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const S = { sb: '', token: '', timer: null, busy: false, last: {}, log: [] };
  const say = (...a) => { const line = new Date().toISOString().slice(11, 19) + ' ' + a.join(' '); S.log.push(line); if (S.log.length > 200) S.log.shift(); console.log('[portal agent]', ...a); };
  const store = () => { try { return JSON.parse(localStorage.getItem('sarwaPortalAgent') || '{}'); } catch { return {}; } };   // file ids / our timeline ids only - no secrets
  const save = (s) => { try { localStorage.setItem('sarwaPortalAgent', JSON.stringify(s)); } catch { } };
  async function call(action, body = {}) {
    const r = await fetch(S.sb, { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': S.token }, body: JSON.stringify({ action, ...body }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(action + ': ' + (j.error || r.status)); return j;
  }
  // ---------- page helpers ----------
  const allDocs = () => { const out = [document]; for (let i = 0; i < out.length; i++) for (const f of out[i].querySelectorAll('iframe')) { try { if (f.contentDocument) out.push(f.contentDocument); } catch { } } return out; };
  async function docForPage(pageId, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { for (const d of allDocs()) if (d.querySelector('#pFlowStepId')?.value === pageId && d.readyState === 'complete' && d.defaultView.apex) return d; await sleep(400); } throw new Error('portal page ' + pageId + ' did not open'); }
  const pageOpen = (pageId) => allDocs().some((d) => d.querySelector('#pFlowStepId')?.value === pageId);
  async function closeDialogs() { for (let i = 0; i < 6; i++) { const xs = [...document.querySelectorAll('.ui-dialog .ui-dialog-titlebar-close')].filter((x) => x.offsetParent); if (!xs.length) break; xs[xs.length - 1].click(); await sleep(800); } }
  const sig = () => (document.querySelector('#my_ir .a-IRR-pagination')?.innerText || '') + '|' + document.querySelectorAll('#my_ir td[headers]').length + '|' + (document.querySelector('#my_ir td[headers]')?.textContent || '');
  async function refreshReport(statusCode) {
    if (/Your session has ended/.test(document.body.innerText)) throw new Error('portal session ended');
    const before = sig();
    if (statusCode != null && apex.item('P165_STATUS').getValue() !== String(statusCode)) apex.item('P165_STATUS').setValue(String(statusCode));
    document.getElementById(SEARCH_BTN).click();
    const t0 = Date.now(); while (Date.now() - t0 < 60000) { await sleep(1200); if (!document.querySelector('.u-Processing') && sig() !== before) break; }
    await sleep(800);
  }
  const rowOf = (id) => R.reportRows().find((r) => r['Request Id'] === String(id));
  async function findRow(id, statusName) {
    let row = rowOf(id); if (row) return row;
    const code = STATUS[statusName]; if (code) { await refreshReport(code); row = rowOf(id); }
    if (!row) for (const c of [3, 6, 9, 1, 2]) { await refreshReport(c); row = rowOf(id); if (row) break; }
    return row;
  }
  const tlIdOf = async (row, entry) => (await R.toRequest(row, [entry], [])).timeline[0].id;
  // ---------- the Reply form ----------
  const coreOf = (job) => norm(job.message) ? String(job.message).trim() : (job.missing || []).length ? job.missing.map((x) => '- ' + x).join('\n') : (job.reason || '');
  function compose(template, core) {
    if (!template) return core || '';
    if (template.includes('#comment#')) return template.replace('#comment#', core || '');
    if (!core) return template;
    const lines = template.split('\n'); lines.splice(lines.length - 1, 0, core, ''); return lines.join('\n');
  }
  const statusFor = (job, cur) => { const want = job.status_code != null ? String(job.status_code) : String(cur); return ACCEPTED.includes(want) ? want : '3'; };
  async function openReply(id) {
    await closeDialogs();
    const a = [...document.querySelectorAll('#my_ir a')].find((x) => new RegExp('p173_chronic_id=' + id + '(?!\\d)').test(x.getAttribute('href') || ''));
    if (!a) throw new Error('request ' + id + ' is not on the report');
    a.click();
    const dr = await docForPage('173');
    if (dr.querySelector('#P173_CHRONIC_ID')?.value !== String(id)) throw new Error('the Actions drawer opened for another request - stopped');
    const btn = [...dr.querySelectorAll('button, a')].find((b) => b.textContent.trim() === 'Reply'); if (!btn) throw new Error('Reply button not found (page structure changed?)');
    btn.click();
    const f = await docForPage('168');
    if (f.querySelector('#P168_CHRONIC_ID')?.value !== String(id)) throw new Error('the Reply form opened for another request - stopped');
    return f;
  }
  async function fill(f, job, cur) {
    const w = f.defaultView; const lang = job.lang === 'EN' ? 'EN' : 'AR'; const status = statusFor(job, cur);
    w.apex.item('P168_LANGUAGE').setValue(lang); await sleep(1500);
    w.apex.item('P168_STATUS').setValue(status);
    let template = ''; for (let i = 0; i < 30 && !template; i++) { await sleep(400); template = f.querySelector('#P168_COMMENT').value; }   // the portal writes its own template
    if (!template) throw new Error('the portal did not fill its reply template');
    const text = compose(template, coreOf(job)); w.apex.item('P168_COMMENT').setValue(text);
    const names = [];
    if ((job.files || []).length) {
      const input = f.querySelector('.dropzone input[type=file], input[type=file]'); if (!input) throw new Error('upload box not found');
      const dt = new w.DataTransfer();
      for (const x of job.files) { const r = await fetch(x.url); const b = await r.blob(); dt.items.add(new w.File([b], x.name, { type: b.type || 'application/octet-stream' })); names.push(x.name); }
      input.files = dt.files; input.dispatchEvent(new w.Event('change', { bubbles: true }));
      await sleep(1500 + 600 * names.length);
    }
    const inBox = f.querySelectorAll('.dz-preview, .dz-file-preview').length;
    return { status, statusName: NAME[status], lang, text, template, files: names, filesInBox: inBox };
  }
  async function cancel(f) { const b = [...f.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); await sleep(800); await closeDialogs(); }
  async function saveForm(f) {
    const w = f.defaultView;
    w.apex.submit({ request: 'SAVE', validate: true });   // what the page's own Save button does (a plain click did not always fire)
    const t0 = Date.now(); while (Date.now() - t0 < 30000) { await sleep(1000); if (!pageOpen('168')) return; const err = f.querySelector('.t-Alert--danger, .a-Notification--error, .apex-page-error'); if (err && err.textContent.trim()) throw new Error('the portal refused: ' + norm(err.textContent).slice(0, 200)); }
    throw new Error('the Reply form did not close after Save');
  }
  // preview only: open, fill, read back, Cancel - nothing saved
  async function preview(job) {
    const row = await findRow(job.request_id, job.portal_status_now); if (!row) throw new Error('request not found on the report');
    const f = await openReply(String(job.request_id)); try { return await fill(f, job, STATUS[row['Chronic Status Name']] ?? 3); } finally { await cancel(f); }
  }
  async function submit(job) {
    const id = String(job.request_id); const st = store(); st.mine = st.mine || {};
    const row = await findRow(id, job.portal_status_now);
    if (!row) return { result: 'conflict', error: 'the request is not on the Chronic Attach report any more (closed on the portal?)' };
    const cur = STATUS[row['Chronic Status Name']] ?? 3; const core = coreOf(job); const target = statusFor(job, cur);
    const before = await R.timeline(id); const known = new Set(); for (const e of before) known.add(await tlIdOf(row, e));
    const match = (e) => (STATUS[e['Chronic Status Name']] === +target) && (!norm(core) || norm(e['Chronic Comment']).includes(norm(core).slice(0, 40)));
    if (job.attempt > 1) { for (const e of before) if (match(e) && !(st.mine[id] || []).includes(await tlIdOf(row, e))) return await confirmed(job, row, e, null); }   // an earlier attempt went through
    if (FINAL.has(cur) && job.decision !== 'Message') return { result: 'conflict', error: 'the request is already ' + row['Chronic Status Name'] + ' on the portal' };
    if (job.portal_status_now && row['Chronic Status Name'] !== job.portal_status_now && FINAL.has(cur)) return { result: 'conflict', error: 'status changed on the portal to ' + row['Chronic Status Name'] };
    const f = await openReply(id); const sent = await fill(f, job, cur);
    if (job.files && job.files.length && sent.filesInBox < job.files.length) { await cancel(f); return { result: 'retry', error: 'the upload box took ' + sent.filesInBox + ' of ' + job.files.length + ' files' }; }
    await saveForm(f); await closeDialogs();
    for (let i = 0; i < 6; i++) {   // confirm from the Request Timeline
      await sleep(4000); await refreshReport();
      const row2 = (await findRow(id, NAME[target])) || row;
      for (const e of await R.timeline(id)) { const tid = await tlIdOf(row2, e); if (!known.has(tid) && match(e)) return await confirmed(job, row2, e, sent); }
    }
    return { result: 'retry', error: 'saved, but the Request Timeline did not show the reply yet - checked again before any resend' };
  }
  async function confirmed(job, row, e, sent) {
    const id = String(job.request_id); const tid = await tlIdOf(row, e); const st = store(); st.mine = st.mine || {};
    st.mine[id] = [...new Set([...(st.mine[id] || []), tid])]; save(st);
    const sName = e['Chronic Status Name'];
    const at = (await R.toRequest(row, [e], [])).timeline[0].at || new Date().toISOString();
    return { result: 'sent', portal: { status_code: STATUS[sName] ?? null, status_name: sName, timeline_id: tid, last_update: at,
      delivered: row['Broker Mail'] ? { channel: 'email', to: row['Broker Mail'] } : { channel: 'whatsapp', to: row['Creation User'] }, text: sent ? sent.text.slice(0, 2000) : undefined } };
  }
  // ---------- cycles ----------
  async function outbound(cfg) {
    if (cfg.dryRun) return;
    for (const j of (await call('bridge_peek', { limit: 5 })).jobs || []) {
      const claimed = ((await call('bridge_jobs', { limit: 1, id: j.id })).jobs || []).find((x) => x.id === j.id);
      if (!claimed) continue;   // not on the live list
      let res; try { res = await submit(claimed); } catch (e) { res = { result: /session ended/.test(e.message) ? 'error' : 'retry', error: String(e.message || e).slice(0, 300) }; await closeDialogs(); }
      await call('bridge_job_result', { id: claimed.id, ...res }); say('job', claimed.id, claimed.request_id, res.result, res.error || '');
      if (res.result === 'sent') { const row = rowOf(claimed.request_id); if (row) await call('bridge_history', { rows: [{ ...R.historyRow(row), status_name: res.portal.status_name, status_code: res.portal.status_code }] }).catch(() => { }); }
      await sleep(5000);
    }
  }
  async function inbound(full) {
    const st = store(); st.files = st.files || {}; st.fp = st.fp || {}; st.mine = st.mine || {};
    if (apex.item('P165_STATUS').getValue() !== '3') await refreshReport(3); else await refreshReport();
    const rows = R.reportRows(); let created = 0, updated = 0;
    for (const row of rows) {
      const id = row['Request Id'];
      const tl = await R.timeline(id); const fp = JSON.stringify(tl.map((e) => [e['Chronic Status Name'], e['Creation Date'], norm(e['Chronic Comment'])]));
      if (!full && st.fp[id] === fp) continue;
      const r = await R.readRequest(id, { skip: st.files[id] || [], mine: st.mine[id] || [] });
      const res = await call('bridge_ingest', { requests: [r.req] });
      if (!(res.errors || []).length) { st.files[id] = [...new Set([...(st.files[id] || []), ...r.req.attachments.filter((a) => a.content_base64 || (st.files[id] || []).includes(a.id)).map((a) => a.id)])]; st.fp[id] = fp; save(st); }
      created += res.created || 0; updated += res.updated || 0;
      await sleep(1200);
    }
    await call('bridge_history', { rows: rows.map(R.historyRow) }).catch(() => { });
    const rec = await call('bridge_reconcile', { open_request_ids: rows.map((r) => r['Request Id']) });
    say('in', 'rows=' + rows.length, 'new=' + created, 'updated=' + updated, 'missing=' + (rec.missing_tickets || []).length);
  }
  async function tick(n) {
    if (S.busy) return; S.busy = true;
    try {
      const cfg = await call('bridge_config'); S.last.cfg = cfg;
      if (!cfg.active) { say('link is Off in Settings > Portal - idle'); return; }
      await outbound(cfg);
      if (n % S.inEvery === 0) await inbound(n % (S.inEvery * 3) === 0);
      await call('bridge_health', { ok: true, loggedIn: true, pageOk: true, pc: 'portal tab' });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300); say('cycle failed:', msg);
      await call('bridge_health', { ok: false, loggedIn: !/session ended/.test(msg), pageOk: !/structure|not found|did not open/.test(msg), error: msg, pc: 'portal tab' }).catch(() => { });
      if (/session ended/.test(msg)) stop();
    } finally { S.busy = false; }
  }
  function start({ sb, token, everySec = 30, inboundMin = 5 }) {
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/portal$/.test(sb) || !/^chp_[0-9a-f]{64}$/.test(token)) throw new Error('bad settings');
    S.sb = sb; S.token = token; S.inEvery = Math.max(1, Math.round(inboundMin * 60 / everySec)); let n = 0;
    stop(); S.timer = setInterval(() => tick(++n), everySec * 1000); tick(0); say('started');
  }
  function stop() { if (S.timer) clearInterval(S.timer); S.timer = null; }
  window.SarwaPortalAgent = { version: 1, start, stop, preview, submit, status: () => ({ running: !!S.timer, busy: S.busy, cfg: S.last.cfg, log: S.log.slice(-30) }) };
})();
