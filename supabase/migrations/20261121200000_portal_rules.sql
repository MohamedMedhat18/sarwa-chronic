-- Portal arrival checks (rules engine): what else is going on for this member, for the duplicate / history rules.
-- Read only; service role only.
create or replace function public.portal_member_context(p_member text, p_ticket text, p_request text)
returns json language sql stable security definer set search_path = public as $$
  with tk as (
    select e.t no, e.ts created, e.d->>'source' src,
           coalesce((select u.d->>'status' from public.events u where u.t = e.t and u.type = 'update' and u.d ? 'status' order by u.ts desc limit 1), e.d->>'status', 'Open') status,
           (select u.d->>'into' from public.events u where u.t = e.t and u.type = 'merge' and u.d ? 'into' limit 1) merged
    from public.events e
    where e.type = 'ticket.create' and coalesce(p_member, '') <> '' and e.d->>'member' = p_member and e.t <> coalesce(p_ticket, ''))
  select json_build_object(
    'open_tickets', coalesce((select json_agg(json_build_object('no', no, 'created', created, 'source', src, 'status', status) order by created desc)
                              from tk where status not in ('Closed', 'Resolved') and merged is null), '[]'::json),
    'recent_tickets', coalesce((select json_agg(json_build_object('no', no, 'created', created, 'source', src, 'status', status) order by created desc)
                              from tk where created > now() - interval '45 days'), '[]'::json),
    'portal_requests', coalesce((select json_agg(json_build_object('request_id', h.request_id, 'status_code', h.status_code, 'status', h.status_name, 'created', h.creation_date) order by h.creation_date desc)
                              from public.portal_history h
                              where coalesce(p_member, '') <> '' and h.individual_number = p_member and h.request_id <> coalesce(p_request, '')
                                and h.creation_date > now() - interval '180 days'), '[]'::json));
$$;
revoke all on function public.portal_member_context(text, text, text) from public, anon, authenticated;
grant execute on function public.portal_member_context(text, text, text) to service_role;
