-- Sarwa portal (Oracle APEX "Chronic Attach", app 2009 page 165) <-> Sarwa Chronic helpdesk.
-- Every portal request becomes one ticket (key = portal request id); the agent's decision goes back to the portal
-- through the portal's own Reply logic (ORDS endpoint). Additive only: no existing table, function or policy is changed.

-- 1) request id <-> ticket (the de-duplication key) and what was last seen of the request
create table if not exists public.portal_links (
  request_id         text primary key,
  ticket             text not null unique,
  last_hash          text not null default '',
  status_code        int,
  status_name        text,
  portal_updated_at  timestamptz,
  att_ids            text[] not null default '{}',
  timeline_ids       text[] not null default '{}',
  created_at         timestamptz not null default now(),
  synced_at          timestamptz not null default now()
);

-- 2) decisions / messages waiting to be posted to the portal (one row = one idempotent call; id = Idempotency-Key)
create table if not exists public.portal_outbox (
  id           text primary key,
  ticket       text not null,
  request_id   text not null,
  job          jsonb not null,
  status       text not null default 'queued'
               check (status in ('queued', 'sending', 'sent', 'conflict', 'error', 'dead', 'cancelled')),
  attempts     int not null default 0,
  next_try_at  timestamptz not null default now(),
  http_code    int,
  error        text,
  result       jsonb,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists portal_outbox_due on public.portal_outbox (status, next_try_at);
-- never two decisions in flight for the same ticket (a double click or two agents at once)
create unique index if not exists portal_outbox_one_open on public.portal_outbox (ticket) where status in ('queued', 'sending');

-- 3) technical audit: every call in both directions (the business audit stays the portal's Request Timeline)
create table if not exists public.portal_sync_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  direction   text not null check (direction in ('in', 'out', 'system')),
  action      text not null,
  request_id  text,
  ticket      text,
  ok          boolean not null default true,
  http_code   int,
  actor       text,
  old_status  text,
  new_status  text,
  detail      jsonb not null default '{}',
  error       text
);
create index if not exists portal_sync_log_at on public.portal_sync_log (at desc);
create index if not exists portal_sync_log_req on public.portal_sync_log (request_id);

-- 4) sync cursor and run lock (server only)
create table if not exists public.portal_state (
  key         text primary key,
  value       jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

-- 5) mock of the portal (TEST requests only – used while IT builds the real ORDS endpoints)
create table if not exists public.portal_mock_requests (
  request_id  text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
create table if not exists public.portal_mock_files (
  id          text primary key,
  request_id  text not null,
  file_name   text not null,
  mime_type   text not null,
  content_b64 text not null
);
create table if not exists public.portal_mock_faults (
  id          bigserial primary key,
  path_like   text not null,          -- e.g. '%/decision'
  http        int not null,           -- e.g. 503, 409
  remaining   int not null default 1
);
create table if not exists public.portal_mock_calls (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  method  text, path text, http int, body jsonb
);

alter table public.portal_links          enable row level security;
alter table public.portal_outbox         enable row level security;
alter table public.portal_sync_log       enable row level security;
alter table public.portal_state          enable row level security;
alter table public.portal_mock_requests  enable row level security;
alter table public.portal_mock_files     enable row level security;
alter table public.portal_mock_faults    enable row level security;
alter table public.portal_mock_calls     enable row level security;

-- team members read the links, the queue and the log; they may only ADD a queued job (the server does the rest)
create policy "members read portal_links"    on public.portal_links    for select using (public.is_member());
create policy "members read portal_outbox"   on public.portal_outbox   for select using (public.is_member());
create policy "members add portal_outbox"    on public.portal_outbox   for insert
  with check (public.is_member() and status = 'queued' and attempts = 0 and http_code is null and result is null);
create policy "members read portal_sync_log" on public.portal_sync_log for select using (public.is_member());
-- portal_state and portal_mock_*: no policy = server (service role) only

-- ticket number for a portal request (same sequence as email tickets; server only)
create or replace function public.portal_next_ticket()
returns json language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  n := nextval('public.ticket_seq');
  return json_build_object('seq', n, 'no', 'CHR-' || lpad(n::text, 6, '0'));
end $$;
revoke all on function public.portal_next_ticket() from public, anon, authenticated;
grant execute on function public.portal_next_ticket() to service_role;

-- take due jobs (skip locked, so a cron run and a "send now" never post the same job twice)
create or replace function public.portal_claim_outbox(n int default 10)
returns setof public.portal_outbox language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.portal_outbox o
     set status = 'sending', attempts = o.attempts + 1, next_try_at = now()   -- next_try_at = claimed at (a stuck "sending" is taken again after 10 min)
   where o.id in (
     select x.id from public.portal_outbox x
      where (x.status = 'queued' and x.next_try_at <= now() + interval '2 seconds')   -- tolerance: next_try_at may come from the function server's clock
         or (x.status = 'sending' and x.next_try_at < now() - interval '10 minutes')
      order by x.created_at
      limit greatest(1, least(n, 25))
      for update skip locked)
  returning o.*;
end $$;
revoke all on function public.portal_claim_outbox(int) from public, anon, authenticated;
grant execute on function public.portal_claim_outbox(int) to service_role;

-- the browser bridge claims ONE specific job (the one the user approved for a live write), never "whatever is due"
create or replace function public.portal_claim_one(p_id text)
returns setof public.portal_outbox language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.portal_outbox o
     set status = 'sending', attempts = o.attempts + 1, next_try_at = now()
   where o.id = p_id
     and ((o.status = 'queued' and o.next_try_at <= now() + interval '2 seconds')
       or (o.status = 'sending' and o.next_try_at < now() - interval '10 minutes'))
  returning o.*;
end $$;
revoke all on function public.portal_claim_one(text) from public, anon, authenticated;
grant execute on function public.portal_claim_one(text) to service_role;

-- a short lock (one sync run at a time, whoever triggers it): true when taken; released by moving updated_at back
create or replace function public.portal_try_lock(p_key text, p_secs int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.portal_state (key, value, updated_at) values (p_key, '{}', now() - interval '1 day') on conflict (key) do nothing;
  update public.portal_state set updated_at = now() where key = p_key and updated_at < now() - make_interval(secs => p_secs);
  return found;
end $$;
revoke all on function public.portal_try_lock(text, int) from public, anon, authenticated;
grant execute on function public.portal_try_lock(text, int) to service_role;

-- Policy Holder -> Starting Day (holder_days); when the holder name does not match, through the member's GlobeMed history
create or replace function public.portal_holder_day(p_holder text, p_member text)
returns json language plpgsql stable security definer set search_path = public as $$
declare h record; found_it boolean := false; via text := 'holder';
begin
  select d.* into h from public.holder_days d where lower(trim(d.policy_holder)) = lower(trim(coalesce(p_holder, ''))) limit 1;
  found_it := found;
  if not found_it and coalesce(p_member, '') <> '' then
    select d.* into h from public.member_meds m join public.holder_days d on d.policy_holder = m.policy_holder
     where m.member = p_member and m.policy_holder is not null order by m.last_dist desc nulls last limit 1;
    found_it := found; via := 'member history';
  end if;
  if not found_it then return null; end if;
  return json_build_object('policy_holder', h.policy_holder, 'start_day', h.start_day, 'second_day', h.second_day,
                           'share', h.share, 'contracts', h.contracts, 'via', via);
end $$;
revoke all on function public.portal_holder_day(text, text) from public, anon, authenticated;
grant execute on function public.portal_holder_day(text, text) to service_role;
