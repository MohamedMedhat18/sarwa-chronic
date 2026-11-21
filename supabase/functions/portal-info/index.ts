// portal-info: the member card number of given portal requests, for the bridge's lookup of requests that left the
// Pending list (the portal's card filter finds them in seconds; a text search over all requests never finishes).
// Bridge token only (x-portal-token, SHA-256 compared with app_secrets.portal_token). Read only.
import { createClient } from 'npm:@supabase/supabase-js@2';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
async function sha256(s: string) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const tok = req.headers.get('x-portal-token') || '';
  const { data: sec } = await db.from('app_secrets').select('value').eq('name', 'portal_token').maybeSingle();
  let hash = ''; try { hash = JSON.parse(sec?.value || '{}').hash || ''; } catch { /* none */ }
  if (!tok.startsWith('chp_') || !hash || hash !== await sha256(tok)) return json({ error: 'Bridge token required' }, 401);
  const body = await req.json().catch(() => ({}));
  const ids = ((body.request_ids || []) as unknown[]).map(String).filter((x) => /^\d{1,12}$/.test(x)).slice(0, 50);
  if (!ids.length) return json({ ok: true, members: {} });
  const out: Record<string, string> = {};
  const { data: h } = await db.from('portal_history').select('request_id,individual_number').in('request_id', ids);
  for (const r of h || []) if (r.individual_number) out[r.request_id] = r.individual_number;
  const rest = ids.filter((x) => !out[x]);
  if (rest.length) {
    const { data: links } = await db.from('portal_links').select('request_id,ticket').in('request_id', rest);
    for (const l of links || []) {
      const { data: ev } = await db.from('events').select('d').eq('type', 'ticket.create').eq('t', l.ticket).maybeSingle();
      const m = (ev?.d as any)?.member; if (m) out[l.request_id] = String(m);
    }
  }
  return json({ ok: true, members: out });
});
