-- Portal replies can no longer get stuck (22 Nov 2026, CHR-000361 / request 38219 waited 10 h in "sending").
-- Cause: the server marked the job "sending" while the bridge's connection dropped, so the bridge never received it;
-- the bridge only looks at "queued" jobs, so nothing ever picked it up again and nothing raised an alert.
--  * waiting_since: when the job (last) started waiting - the 15-minute timeout counts from here (Try again resets it)
--  * a claimed job with no answer for 5 minutes is claimable again (lease), at most 3 attempts in total
alter table public.portal_outbox add column if not exists waiting_since timestamptz;
update public.portal_outbox set waiting_since = created_at where waiting_since is null;
alter table public.portal_outbox alter column waiting_since set default now();
alter table public.portal_outbox alter column waiting_since set not null;

create or replace function public.portal_claim_one(p_id text)
 returns setof public.portal_outbox language plpgsql security definer set search_path to 'public' as $$
begin
  return query
  update public.portal_outbox o
     set status = 'sending', attempts = o.attempts + 1, next_try_at = now()
   where o.id = p_id and o.attempts < 3
     and ((o.status = 'queued' and o.next_try_at <= now() + interval '2 seconds')
       or (o.status = 'sending' and o.next_try_at < now() - interval '5 minutes'))
  returning o.*;
end $$;

create or replace function public.portal_claim_outbox(n integer default 10)
 returns setof public.portal_outbox language plpgsql security definer set search_path to 'public' as $$
begin
  return query
  update public.portal_outbox o
     set status = 'sending', attempts = o.attempts + 1, next_try_at = now()
   where o.id in (
     select x.id from public.portal_outbox x
      where x.attempts < 3
        and ((x.status = 'queued' and x.next_try_at <= now() + interval '2 seconds')
          or (x.status = 'sending' and x.next_try_at < now() - interval '5 minutes'))
      order by x.created_at
      limit greatest(1, least(n, 25))
      for update skip locked)
  returning o.*;
end $$;
