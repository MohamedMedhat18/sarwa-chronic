// Sarwa Chronic – i-CARE helper (runs only on i-care.globemedegypt.com).
// i-CARE's Administrative Info always shows the patient last searched in Patient Information, and that search only works
// from inside i-CARE. So when Sarwa Chronic opens i-CARE as …/Index.cfm#sarwa=<member card no.>, this script runs i-CARE's
// own Patient Information search for that member (with the agent's own i-CARE sign-in), opens the member's Administrative
// Information in this tab and sends the details back to the Sarwa ticket. It never reads or stores passwords.
(() => {
  const APPS = ['https://mohamedmedhat18.github.io', 'http://localhost:8765'];
  const KEY = 'sarwaIcarePending', DONE = 'sarwaIcareDone';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function banner(html, kind) {
    let b = document.getElementById('sarwaHelperBox');
    if (!b) { b = document.createElement('div'); b.id = 'sarwaHelperBox'; (document.body || document.documentElement).appendChild(b); }
    b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;color:#fff;padding:11px 15px;border-radius:10px;font:13px/1.45 Arial,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);max-width:440px;max-height:80vh;overflow:auto;text-align:left;background:' + (kind === 'bad' ? '#9b1c1c' : '#0f5e57');
    b.innerHTML = html + '<div style="text-align:right;margin-top:4px"><a href="#" style="color:#fff;font-size:12px">Close</a></div>';
    b.querySelector('div:last-child a').onclick = e => { e.preventDefault(); b.remove(); };
    if (kind === 'ok') setTimeout(() => b && b.remove(), 10000);
  }
  const signedOut = () => !!document.querySelector('input[name=j_password]');
  function clientId() {   // the ColdFusion client id i-CARE adds to its own Patient Information request (taken from the page)
    for (const s of document.scripts) { const m = (s.textContent || '').match(/_cf_clientid\s*=\s*['"]([^'"]+)/); if (m) return m[1]; }
    for (const f of document.querySelectorAll('form[action*="_cf_clientid="]')) { const m = f.getAttribute('action').match(/_cf_clientid=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
    return '';
  }
  function tell(msg) { const op = window.opener; if (!op) return false; for (const o of APPS) { try { op.postMessage(msg, o); } catch (e) { } } return true; }
  function takeHash() {
    const m = location.hash.match(/sarwa=([\d,]+)/);
    if (!m) return;
    const ids = m[1].split(',').filter(x => /^\d{6,10}$/.test(x));
    if (ids.length) sessionStorage.setItem(KEY, JSON.stringify({ ids, at: Date.now() }));
    history.replaceState(null, '', location.pathname + location.search);
  }
  // i-CARE's Patient Information search for one member, then its Administrative Information
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isLogin = html => /j_password/i.test(html);
  async function check(id, cid) {
    // right after i-CARE's page loads, i-CARE answers with its sign-in form for a few seconds although the agent is signed
    // in – so retry for ~12 s before deciding the sign-in really expired
    let p = '';
    for (const wait of [0, 1000, 1500, 2000, 2500, 3000]) {
      if (wait) await sleep(wait);
      p = await (await fetch('/Assistance/Index.cfm?_cf_containerId=WorkArea&_cf_nodebug=true&_cf_nocache=true' + (cid ? '&_cf_clientid=' + encodeURIComponent(cid) : '') + '&_cf_rc=1',
        { method: 'POST', body: new URLSearchParams({ Contnbr: '', IndNbr: id, txtReference: '' }), credentials: 'same-origin' })).text();
      if (!isLogin(p)) break;
    }
    if (isLogin(p)) return { id, ok: false, signedOut: true, error: 'i-CARE sign-in expired' };
    const m = p.match(/AdministrativeInfo\.cfm\?indnbr=(\d+)&(?:amp;)?contnbr=(\d+)/i);
    if (!m) return { id, ok: false, error: 'Not found in i-CARE' };
    if (m[1] !== id) return { id, ok: false, error: 'i-CARE returned another member (' + m[1] + ')' };
    const url = '/assistance/AdministrativeInfo.cfm?indnbr=' + m[1] + '&contnbr=' + m[2];
    let a = '';
    for (const wait of [0, 1000, 2000]) { if (wait) await sleep(wait); a = await (await fetch(url, { credentials: 'same-origin' })).text(); if (/Adherent Name/i.test(a)) break; }
    const d = new DOMParser().parseFromString(a, 'text/html');
    const text = [...d.querySelectorAll('tr')].filter(tr => !tr.querySelector('table')).map(tr => [...tr.children].map(c => c.textContent.replace(/\s+/g, ' ').trim()).join('\t')).filter(x => x.trim()).join('\n');
    const ind = (text.match(/Individual Number:?\t\s*(\d+)/i) || [])[1] || '';
    if (ind !== id) return { id, ok: false, error: 'Administrative Info showed another member (' + ind + ')' };
    return { id, ok: true, url, contract: m[2], text, name: (text.match(/Adherent Name:?\t([^\n]*)/i) || [])[1] || '', mobile: (text.match(/Insured Mobile Number:?\t([^\n]*)/i) || [])[1] || '' };
  }
  let busy = false;
  async function run() {
    if (busy) return;
    let job = null; try { job = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { }
    if (!job || !Array.isArray(job.ids) || !job.ids.length || Date.now() - job.at > 15 * 60000) return;
    if (signedOut()) { banner('Sarwa: sign in to i-CARE – member ' + esc(job.ids.join(', ')) + ' opens right after.'); return; }
    busy = true; sessionStorage.removeItem(KEY);
    try {
      banner('Sarwa: opening member <b>' + esc(job.ids[0]) + '</b>&hellip;');
      if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r, { once: true }));
      await sleep(800);   // let i-CARE's own page finish its start-up requests first
      const cid = clientId(); const rows = [];
      for (let i = 0; i < job.ids.length; i++) {
        const id = job.ids[i];
        banner('Sarwa: opening member <b>' + esc(id) + '</b>&hellip;' + (job.ids.length > 1 ? ' (' + (i + 1) + ' of ' + job.ids.length + ')' : ''));
        let r; try { r = await check(id, cid); } catch (e) { r = { id, ok: false, error: e.message }; }
        if (r.signedOut) { sessionStorage.setItem(KEY, JSON.stringify({ ids: job.ids.slice(i), at: Date.now() })); banner('Sarwa: the i-CARE sign-in expired – sign in, the member opens right after.', 'bad'); return; }
        rows.push(r);
        tell({ sarwaIcare: 1, id: r.id, ok: r.ok, error: r.error, contract: r.contract, text: r.text, name: r.name, mobile: r.mobile });
      }
      const okRows = rows.filter(r => r.ok), last = okRows[okRows.length - 1];
      if (rows.length === 1 && !last) { banner('Sarwa: member <b>' + esc(rows[0].id) + '</b> – ' + esc(rows[0].error) + '.', 'bad'); return; }
      sessionStorage.setItem(DONE, JSON.stringify({ rows: rows.map(r => ({ id: r.id, ok: r.ok, name: r.name, mobile: r.mobile, error: r.error })), sent: !!window.opener, at: Date.now() }));
      if (last) location.replace(last.url);   // the (last) member's Administrative Information, in this tab
      else showDone();
    } catch (e) { banner('Sarwa: ' + esc(e.message), 'bad'); }
    finally { busy = false; }
  }
  function showDone() {
    let done = null; try { done = JSON.parse(sessionStorage.getItem(DONE) || 'null'); } catch (e) { }
    sessionStorage.removeItem(DONE);
    if (!done || Date.now() - done.at > 60000) return;
    const okN = done.rows.filter(r => r.ok).length;
    const list = done.rows.length > 1 ? '<table style="border-collapse:collapse;margin-top:6px;color:#fff">' + done.rows.map(r => '<tr><td style="padding:1px 10px 1px 0">' + esc(r.id) + '</td><td>' + (r.ok ? esc(r.name) + (r.mobile ? ' &middot; ' + esc(r.mobile) : '') : '<span style="color:#ffd2cc">' + esc(r.error) + '</span>') + '</td></tr>').join('') + '</table>' : '';
    const one = done.rows.length === 1 ? '&#10003; Sarwa: <b>' + esc(done.rows[0].name) + '</b> (' + esc(done.rows[0].id) + ')' + (done.rows[0].mobile ? ' &middot; ' + esc(done.rows[0].mobile) : '') : '<b>Sarwa: ' + okN + ' of ' + done.rows.length + ' members checked</b>';
    banner(one + list + '<div>' + (done.sent ? 'Saved to the Sarwa ticket' + (okN > 1 ? 's' : '') + '.' : 'Opened in i-CARE.') + '</div>', okN ? 'ok' : 'bad');
  }
  if (/AdministrativeInfo\.cfm/i.test(location.pathname)) { showDone(); return; }
  takeHash(); run();
  addEventListener('hashchange', () => { takeHash(); run(); });
})();
