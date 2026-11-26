-- "New email" (26 Nov 2026): Schedule send. A queued email with a future job.sendAt is held back by bridge outbox_list.
-- An agent can cancel it while it is still waiting (status 'cancelled'; nothing is deleted).
alter table public.outbox drop constraint if exists outbox_status_check;
alter table public.outbox add constraint outbox_status_check check (status in ('queued', 'sending', 'sent', 'draft', 'error', 'cancelled'));

create or replace function public.outbox_cancel(p_id text)
returns text language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select id, status, job into r from public.outbox where id = p_id for update;
  if not found then return 'unknown'; end if;
  if r.status <> 'queued' then return r.status; end if;
  -- only a scheduled email that is not due within the next minute (Outlook may already be taking a due one)
  if coalesce(r.job->>'sendAt', '') = '' or (r.job->>'sendAt')::timestamptz <= now() + interval '1 minute' then return 'too_late'; end if;
  update public.outbox set status = 'cancelled', error = 'cancelled before sending' where id = p_id;
  return 'cancelled';
end $$;
revoke all on function public.outbox_cancel(text) from public, anon;
grant execute on function public.outbox_cancel(text) to authenticated;
