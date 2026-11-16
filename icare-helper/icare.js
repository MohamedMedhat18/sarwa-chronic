// Sarwa Chronic – i-CARE helper (runs only on i-care.globemedegypt.com). Never reads or stores passwords.
// Sarwa Chronic opens the member's own link: …/assistance/AdministrativeInfo.cfm?indnbr=<member>&contnbr=<contract>#sarwa=<member>.
// i-CARE fills that page with the patient last searched in its Patient Information (its session), whatever the link says. So on
// that page this helper compares the member shown with indnbr; if they differ it runs i-CARE's own Patient Information search for
// indnbr (with the agent's own sign-in) and reloads the same link – then the page shows that member. The details go back to the
// Sarwa ticket: to the Sarwa tab that opened i-CARE (same browser) or through the Sarwa server with the ticket's one-time link.
(() => {
  const APPS = ['https://mohamedmedhat18.github.io', 'http://localhost:8765'];
  const SERVER = 'https://dqjkmhorcusaynbmjcxx.supabase.co/functions/v1/icare';
  const KEY = 'sarwaIcarePending', DONE = 'sarwaIcareDone';
  const onAdmin = /AdministrativeInfo\.cfm/i.test(location.pathname);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function banner(html, kind) {
    let b = document.getElementById('sarwaHelperBox');
    if (!b) { b = document.createElement('div'); b.id = 'sarwaHelperBox'; (document.body || document.documentElement).appendChild(b); }
    b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;color:#fff;padding:11px 15px;border-radius:10px;font:13px/1.45 Arial,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);max-width:440px;max-height:80vh;overflow:auto;text-align:left;background:' + (kind === 'bad' ? '#9b1c1c' : '#0f5e57');
    b.innerHTML = html + '<div style="text-align:right;margin-top:4px"><a href="#" style="color:#fff;font-size:12px">Close</a></div>';
    b.querySelector('div:last-child a').onclick = e => { e.preventDefault(); b.remove(); };
    if (kind === 'ok') setTimeout(() => b && b.remove(), 9000);
  }
  const signedOut = () => !!document.querySelector('input[name=j_password]');
  const isLogin = html => /j_password/i.test(html);
  function clientId() {
    for (const s of document.scripts) { const m = (s.textContent || '').match(/_cf_clientid\s*=\s*['"]([^'"]+)/); if (m) return m[1]; }
    for (const f of document.querySelectorAll('form[action*="_cf_clientid="]')) { const m = f.getAttribute('action').match(/_cf_clientid=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
    return '';
  }
  const tableText = doc => [...doc.querySelectorAll('tr')].filter(tr => !tr.querySelector('table')).map(tr => [...tr.children].map(c => c.textContent.replace(/\s+/g, ' ').trim()).join('\t')).filter(x => x.trim()).join('\n');
  const fieldOf = (text, label) => (text.match(new RegExp(label + ':?\\t\\s*([^\\n]*)', 'i')) || [])[1] || '';
  function tell(msg) { const op = window.opener; if (!op || op.closed) return false; for (const o of APPS) { try { op.postMessage(msg, o); } catch (e) { } } return true; }
  async function send(msg, tk) {
    if (tell(msg)) return true;
    if (!tk) return false;
    try {
      const r = await fetch(SERVER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', token: tk, id: msg.id, ok: msg.ok, error: msg.error, text: msg.text, contract: msg.contract, name: msg.name, mobile: msg.mobile }) });
      const j = await r.json().catch(() => ({})); return r.ok && j.ok;
    } catch (e) { return false; }
  }
  const getJob = () => { try { const j = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return j && Array.isArray(j.ids) && j.ids.length && Date.now() - j.at < 15 * 60000 ? j : null; } catch (e) { return null; } };
  function takeHash() {
    const m = location.hash.match(/sarwa=([\d,]+)(?:&tk=([\w,-]+))?/);
    if (!m) return;
    const all = m[1].split(','), tks = (m[2] || '').split(',');
    const ids = [], keep = []; all.forEach((x, i) => { if (/^\d{6,10}$/.test(x)) { ids.push(x); keep.push(tks[i] || ''); } });
    if (ids.length) sessionStorage.setItem(KEY, JSON.stringify({ ids, tks: keep, at: Date.now() }));
    history.replaceState(null, '', location.pathname + location.search);
  }
  // i-CARE's own Patient Information search (right after a page load i-CARE answers "signed out" for a few seconds: retry)
  async function search(id) {
    const cid = clientId(); let p = '';
    for (const wait of [0, 1000, 1500, 2000, 2500, 3000]) {
      if (wait) await sleep(wait);
      p = await (await fetch('/Assistance/Index.cfm?_cf_containerId=WorkArea&_cf_nodebug=true&_cf_nocache=true' + (cid ? '&_cf_clientid=' + encodeURIComponent(cid) : '') + '&_cf_rc=1',
        { method: 'POST', body: new URLSearchParams({ Contnbr: '', IndNbr: id, txtReference: '' }), credentials: 'same-origin' })).text();
      if (!isLogin(p)) break;
    }
    if (isLogin(p)) return { signedOut: true };
    const m = p.match(/AdministrativeInfo\.cfm\?indnbr=(\d+)&(?:amp;)?contnbr=(\d+)/i);
    if (!m) return { error: 'Not found in i-CARE' };
    if (m[1] !== id) return { error: 'i-CARE returned another member (' + m[1] + ')' };
    return { url: '/assistance/AdministrativeInfo.cfm?indnbr=' + m[1] + '&contnbr=' + m[2], contract: m[2] };
  }
  async function adminText(url) {
    let a = '';
    for (const wait of [0, 1000, 2000]) { if (wait) await sleep(wait); a = await (await fetch(url, { credentials: 'same-origin' })).text(); if (/Adherent Name/i.test(a)) break; }
    return tableText(new DOMParser().parseFromString(a, 'text/html'));
  }
  const closedMsg = 'Sarwa: i-CARE closed this session (signed in elsewhere with the same account, or timed out). Sign in – the member opens right after.';

  // ---------- on the member's Administrative Information link ----------
  async function onAdminPage() {
    takeHash();
    const want = (new URLSearchParams(location.search).get('indnbr') || '').replace(/\D/g, '');
    if (!/^\d{6,10}$/.test(want)) return;
    const job = getJob(); const mine = job && job.ids.length === 1 && job.ids[0] === want ? job : null;
    if (signedOut()) { if (mine) banner('Sarwa: sign in to i-CARE – member <b>' + esc(want) + '</b> opens right after.'); return; }
    const text = tableText(document); const shown = fieldOf(text, 'Individual Number').replace(/\D/g, '');
    if (shown === want) {   // the right member is on the page
      sessionStorage.removeItem('sarwaFixTry');
      if (!mine) return;
      sessionStorage.removeItem(KEY);
      const contract = (new URLSearchParams(location.search).get('contnbr') || '').replace(/\D/g, '') || fieldOf(text, 'Contract Number').replace(/\D/g, '');
      const name = fieldOf(text, 'Adherent Name'), mobile = fieldOf(text, 'Insured Mobile Number');
      const sent = await send({ sarwaIcare: 1, id: want, ok: true, contract, text, name, mobile }, (mine.tks || [])[0]);
      banner('&#10003; Sarwa: <b>' + esc(name) + '</b> (' + esc(want) + ')' + (mobile ? ' &middot; ' + esc(mobile) : '') + '<br>' + (sent ? 'Saved to the Sarwa ticket.' : 'Opened in i-CARE.'), 'ok');
      return;
    }
    // another member (or none) is shown: run i-CARE's search for the member of the link, then reload the same link
    if (sessionStorage.getItem('sarwaFixTry') === want) { sessionStorage.removeItem('sarwaFixTry'); banner('Sarwa: i-CARE still shows another member (' + esc(shown || 'none') + ') – press Open i-CARE again.', 'bad'); return; }
    banner('Sarwa: i-CARE showed ' + (shown ? 'member ' + esc(shown) : 'no member') + ' – opening <b>' + esc(want) + '</b>&hellip;');
    const r = await search(want);
    if (r.signedOut) { if (!mine) sessionStorage.setItem(KEY, JSON.stringify({ ids: [want], tks: [''], at: Date.now() })); banner(closedMsg, 'bad'); return; }
    if (r.error) { if (mine) { sessionStorage.removeItem(KEY); await send({ sarwaIcare: 1, id: want, ok: false, error: r.error }, (mine.tks || [])[0]); } banner('Sarwa: member <b>' + esc(want) + '</b> &ndash; ' + esc(r.error) + '.', 'bad'); return; }
    if (!mine) sessionStorage.setItem(KEY, JSON.stringify({ ids: [want], tks: [''], at: Date.now() }));
    sessionStorage.setItem('sarwaFixTry', want);
    location.replace(location.pathname + location.search);
  }

  // ---------- on any other i-CARE page (after signing in, or opened with several members) ----------
  let busy = false;
  async function onOtherPage() {
    if (busy) return;
    const job = getJob(); if (!job) return;
    if (signedOut()) { banner('Sarwa: sign in to i-CARE – member <b>' + esc(job.ids.join(', ')) + '</b> opens right after.<br><span style="opacity:.85">i-CARE allows one session per account: if someone else signed in with the same account, this one was closed.</span>'); return; }
    busy = true;
    try {
      banner('Sarwa: opening member <b>' + esc(job.ids[0]) + '</b>&hellip;');
      if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r, { once: true }));
      await sleep(800);
      if (job.ids.length === 1) {   // one member: search, then land on its Administrative Information (which sends the details)
        const r = await search(job.ids[0]);
        if (r.signedOut) { banner(closedMsg, 'bad'); return; }
        if (r.error) { sessionStorage.removeItem(KEY); await send({ sarwaIcare: 1, id: job.ids[0], ok: false, error: r.error }, (job.tks || [])[0]); banner('Sarwa: member <b>' + esc(job.ids[0]) + '</b> &ndash; ' + esc(r.error) + '.', 'bad'); return; }
        sessionStorage.setItem('sarwaFixTry', job.ids[0]);
        location.replace(r.url); return;
      }
      // several members ("Check all"): check each one and send it, then show the last one's Administrative Information
      sessionStorage.removeItem(KEY);
      const rows = []; let lastUrl = '';
      for (let i = 0; i < job.ids.length; i++) {
        const id = job.ids[i];
        banner('Sarwa: checking member <b>' + esc(id) + '</b>&hellip; (' + (i + 1) + ' of ' + job.ids.length + ')');
        let row = { id, ok: false };
        try {
          const r = await search(id);
          if (r.signedOut) { sessionStorage.setItem(KEY, JSON.stringify({ ids: job.ids.slice(i), tks: (job.tks || []).slice(i), at: Date.now() })); banner(closedMsg, 'bad'); return; }
          if (r.error) row.error = r.error;
          else {
            const text = await adminText(r.url);
            if (fieldOf(text, 'Individual Number').replace(/\D/g, '') !== id) row.error = 'Administrative Info showed another member';
            else { row = { id, ok: true, contract: r.contract, text, name: fieldOf(text, 'Adherent Name'), mobile: fieldOf(text, 'Insured Mobile Number') }; lastUrl = r.url; }
          }
        } catch (e) { row.error = e.message; }
        row.sent = await send({ sarwaIcare: 1, id: row.id, ok: row.ok, error: row.error, contract: row.contract, text: row.text, name: row.name, mobile: row.mobile }, (job.tks || [])[i]);
        rows.push(row);
      }
      const okN = rows.filter(r => r.ok).length;
      sessionStorage.setItem(DONE, JSON.stringify({ rows: rows.map(r => ({ id: r.id, ok: r.ok, name: r.name, mobile: r.mobile, error: r.error })), sent: rows.some(r => r.sent), at: Date.now() }));
      if (lastUrl) location.replace(lastUrl); else showDone();
      if (!okN) return;
    } catch (e) { banner('Sarwa: ' + esc(e.message), 'bad'); }
    finally { busy = false; }
  }
  function showDone() {
    let done = null; try { done = JSON.parse(sessionStorage.getItem(DONE) || 'null'); } catch (e) { }
    sessionStorage.removeItem(DONE);
    if (!done || Date.now() - done.at > 60000) return false;
    const okN = done.rows.filter(r => r.ok).length;
    const list = '<table style="border-collapse:collapse;margin-top:6px;color:#fff">' + done.rows.map(r => '<tr><td style="padding:1px 10px 1px 0">' + esc(r.id) + '</td><td>' + (r.ok ? esc(r.name) + (r.mobile ? ' &middot; ' + esc(r.mobile) : '') : '<span style="color:#ffd2cc">' + esc(r.error) + '</span>') + '</td></tr>').join('') + '</table>';
    banner('<b>Sarwa: ' + okN + ' of ' + done.rows.length + ' members checked</b>' + list + '<div>' + (done.sent ? 'Saved to the Sarwa tickets.' : '') + '</div>', okN ? 'ok' : 'bad');
    return true;
  }
  if (onAdmin) { if (!showDone()) onAdminPage(); return; }
  takeHash(); onOtherPage();
  addEventListener('hashchange', () => { takeHash(); onOtherPage(); });
})();
