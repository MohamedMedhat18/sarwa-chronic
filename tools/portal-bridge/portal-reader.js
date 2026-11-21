// Sarwa portal reader - runs INSIDE the signed-in Chronic Attach page (page 165), read only, no clicks.
// Used by bridge.mjs (page.addScriptTag + page.evaluate) and for one-off imports / backfills.
//
// How it reads (verified on the live portal 21 Nov 2026):
//  - every report row carries signed APEX dialog URLs (cs + dialogCs) for the Request Timeline (page 172) and the
//    Actions drawer (page 173). The drawer page carries signed URLs for Broker Attachments (170) and Sarwa Attachments (166).
//  - those pages are plain GETs in the user's session; opening them changes nothing on the request.
//  - the file links are RELATIVE (apex_util.get_blob?...&k1=<file id>&ck=...) and must be resolved against the page's
//    <base href="/ords/">. Resolved against the page URL they return a small "page isn't available" HTML page instead.
// Nothing here submits a form or clicks Reply / Broker Attachment / Sarwa Attachment.
(function () {
  const STATUS = { Assigned: 1, Processing: 2, Pending: 3, Closed: 4, Approved: 5, Partially_Approved_Pending: 6, 'Partially Approved Pending': 6, Partially_Approved_Rejected: 7, 'Partially Approved Rejected': 7, Rejected: 8, Reopened: 9 };
  const STAFF_TEXT = /تحية طيبة من شركة ثروة|Greetings from Sarwa Life/i;   // the portal's own reply templates (AR / EN)
  const MAX_FILE = 20 * 1048576;
  const TZ = '+02:00';
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const iso = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/); if (!m) return ''; const [, d, mo, y, h = '00', mi = '00'] = m; return new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00${TZ}`).toISOString(); };
  const day = (s) => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // APEX interactive report rows: header cells repeat per control-break group with empty visible text, so cells are
  // mapped through their `headers` attribute and names are read with textContent.
  function irRows(root) {
    const name = {}; for (const el of root.querySelectorAll('[id]')) { const t = el.textContent.trim(); if (/^[CB]\d/.test(el.id) && t && !name[el.id]) name[el.id] = t; }
    const rows = [];
    for (const tr of root.querySelectorAll('.a-IRR-table tr, table tr')) {
      const tds = [...tr.querySelectorAll('td[headers]')]; if (!tds.length) continue;
      const o = {};
      for (const td of tds) {
        const [col, grp] = (td.getAttribute('headers') || '').split(/\s+/);
        if (name[col]) o[name[col]] = td.textContent.trim();
        if (grp && name[grp]) o._indiv = name[grp].replace(/^Individual Number:\s*/i, '');
        const a = td.querySelector('a[href*="get_blob"]'); if (a) { o._blob = a.getAttribute('href'); o._fileId = (o._blob.match(/[?&]k1=([^&]+)/) || [])[1] || ''; }
      }
      if (Object.keys(o).length) rows.push(o);
    }
    return rows;
  }
  const dialogUrl = (js) => { const m = String(js || '').match(/dialog\('([^']+)'/); return m ? JSON.parse('"' + m[1] + '"') : ''; };
  async function getDoc(url) {
    const r = await fetch(url, { credentials: 'include' }); const html = await r.text();
    if (/Your session has ended|input type="password"/i.test(html)) throw new Error('portal session ended');
    if (/unexpected internal application error/i.test(html)) throw new Error('portal refused the page (checksum)');
    return new DOMParser().parseFromString(html, 'text/html');
  }
  const reportRows = () => irRows(document.querySelector('#my_ir')).filter((r) => /^\d+$/.test(r['Request Id'] || ''));
  const rowLink = (id, re) => [...document.querySelectorAll('#my_ir a')].find((a) => re.test(a.getAttribute('href') || '') && (re.source.includes('p173') || a.textContent.trim() === String(id)));
  async function timeline(id) {
    const a = rowLink(id, new RegExp('p172_chronic_id=' + id + '(?!\\d)'));
    if (!a) throw new Error('timeline link not found for ' + id);
    return irRows((await getDoc(dialogUrl(a.getAttribute('href')))).body).filter((r) => r['Chronic Status Name'] || r['Creation Date']);
  }
  // files: { skip: Set of attachment ids already stored (not downloaded again) }
  async function files(id, skip = new Set()) {
    const a = rowLink(id, new RegExp('p173_chronic_id=' + id + '(?!\\d)'));
    if (!a) throw new Error('actions link not found for ' + id);
    const drawer = await getDoc(dialogUrl(a.getAttribute('href')));
    if ((drawer.querySelector('#P173_CHRONIC_ID') || {}).value !== String(id)) throw new Error('drawer opened for another request');
    const out = []; const seen = { broker: 0, sarwa: 0 };
    for (const [src, label] of [['Broker', /^Broker Attachment$/], ['Sarwa', /^Sarwa Attachment$/]]) {
      const btn = [...drawer.querySelectorAll('button, a')].find((b) => label.test(b.textContent.trim()));
      if (!btn) throw new Error(src + ' Attachment button not found (page structure changed?)');
      const page = await getDoc(dialogUrl(btn.getAttribute('onclick') || btn.getAttribute('href')));
      const base = new URL((page.querySelector('base') || {}).getAttribute?.('href') || '/ords/', location.origin);
      for (const r of irRows(page.body).filter((x) => x._blob)) {
        seen[src.toLowerCase()]++;
        const att = { id: (src === 'Broker' ? 'b-' : 's-') + r._fileId, file_name: r['File Name'] || ('file-' + r._fileId), source: src, uploaded_at: iso(r['Creation Date']), extra_comment: r['Extra Comment'] || '' };
        if (!skip.has(att.id)) {
          const res = await fetch(new URL(r._blob, base).href, { credentials: 'include' });
          const type = (res.headers.get('content-type') || '').split(';')[0];
          const buf = new Uint8Array(await res.arrayBuffer()); att.size = buf.length;
          if (/text\/html/.test(type)) att.error = 'the portal returned a page instead of the file';
          else if (buf.length <= MAX_FILE) { let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); att.content_base64 = btoa(s); att.mime_type = type; }
        }
        out.push(att);
        await sleep(300);
      }
    }
    return { files: out, seen };
  }
  async function toRequest(row, tl, atts, mine = new Set()) {
    const id = row['Request Id']; const creator = row['Creation User'] || '';
    const timeline = [];
    for (const r of tl) {
      const tid = 'tl-' + (await sha([id, r['Chronic Status Name'], norm(r['Chronic Comment']), norm(r['Extra Comment']), r['Creation User'], r['Creation Date']].join('|'))).slice(0, 20);
      const actor = mine.has(tid) ? 'integration' : STAFF_TEXT.test(r['Chronic Comment'] || '') ? 'staff' : 'requester';
      timeline.push({ id: tid, status_name: r['Chronic Status Name'], status_code: STATUS[r['Chronic Status Name']] ?? null, comment: r['Chronic Comment'] || '', extra_comment: r['Extra Comment'] || '', by: actor === 'requester' ? creator : actor === 'integration' ? 'sarwa-chronic' : 'portal staff', actor_type: actor, at: iso(r['Creation Date']) });
    }
    const dates = [iso(row['Creation Date']), ...timeline.map((t) => t.at), ...atts.filter((a) => a.source !== 'Sarwa').map((a) => a.uploaded_at)].filter(Boolean).sort();
    return {
      request_id: id, individual_number: row['Individual Number'] || row._indiv || '', individual_name: row['Individual Name'] || '', mobile: /^\d{8,15}$/.test(creator) ? creator : '', creation_user: creator,
      channel: row['Cr Type'] || '', contract_no: row['Contract No'] || row['Contract no'] || '', policy_holder: row['Policy Holder'] || '', policy_holder_name: row['Policy Holder Name'] || '',
      broker: row['Broker'] || '', broker_mail: row['Broker Mail'] || '', cc: [], status_name: row['Chronic Status Name'], status_code: STATUS[row['Chronic Status Name']] ?? 3,
      chronic_date: day(row['Chronic Date']), assign_to: row['Assign To'] || '', creation_date: iso(row['Creation Date']), last_update: dates.pop() || '', timeline, attachments: atts,
    };
  }
  const historyRow = (r) => ({ request_id: r['Request Id'], individual_number: r['Individual Number'] || r._indiv || '', individual_name: r['Individual Name'] || '', policy_holder: r['Policy Holder Name'] || r['Policy Holder'] || '', contract_no: r['Contract No'] || r['Contract no'] || '', channel: r['Cr Type'] || '', creation_user: r['Creation User'] || '', broker: r['Broker'] || '', broker_mail: r['Broker Mail'] || '', status_name: r['Chronic Status Name'] || '', status_code: STATUS[r['Chronic Status Name']] ?? null, chronic_date: day(r['Chronic Date']) || null, creation_date: iso(r['Creation Date']) || null, assign_to: r['Assign To'] || '' });
  // read one request completely (row from the report + timeline + broker/Sarwa files)
  async function readRequest(id, opts = {}) {
    const row = reportRows().find((r) => r['Request Id'] === String(id)); if (!row) throw new Error('request ' + id + ' is not on the report');
    const tl = await timeline(id); await sleep(400);
    const f = await files(id, new Set(opts.skip || [])); await sleep(400);
    return { req: await toRequest(row, tl, f.files, new Set(opts.mine || [])), seen: f.seen, tlFingerprint: await sha(JSON.stringify(tl)) };
  }
  window.SarwaPortalReader = { version: 1, reportRows, readRequest, timeline, files, toRequest, historyRow, irRows };
})();
