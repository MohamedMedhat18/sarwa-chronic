-- Limits (28 Nov 2026): the latest i-CARE read per member (also members without a ticket, read at night for the monthly AML
-- report), each member's monthly treatment cost from the GlobeMed files (counted by the history sync on the Chronic PC – the
-- server is too slow to sum 290,000 lines), and an index to look up a medicine's usual monthly cost.
create index if not exists member_meds_code on public.member_meds (med_code);

create table if not exists public.member_icare (
  member   text primary key,
  d        jsonb not null,          -- admin (name, holder, contract, dates), limits, cover dates, fetchedAt – as read
  read_at  timestamptz not null default now(),
  ticket   text                     -- the ticket it was read for ('' = the monthly night read)
);
alter table public.member_icare enable row level security;
drop policy if exists "members read member_icare" on public.member_icare;
create policy "members read member_icare" on public.member_icare for select to authenticated using (is_member());
revoke all on public.member_icare from anon;

create table if not exists public.member_cost (
  member        text primary key,
  monthly_cost  numeric,            -- sum of (monthly quantity × unit price) of the member's active medicines (EGP)
  active_lines  int,
  holder        text,
  contract      text,
  updated_at    timestamptz default now()
);
alter table public.member_cost enable row level security;
drop policy if exists "members read member_cost" on public.member_cost;
create policy "members read member_cost" on public.member_cost for select to authenticated using (is_member());
revoke all on public.member_cost from anon;

-- the sync sends every active member each time the files change; members no longer active are removed
create or replace function public.member_cost_upsert(rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.member_cost as c (member, monthly_cost, active_lines, holder, contract, updated_at)
  select r->>'member', (nullif(r->>'monthly_cost', ''))::numeric, (nullif(r->>'active_lines', ''))::int, nullif(r->>'holder', ''), nullif(r->>'contract', ''), now()
  from jsonb_array_elements(rows) r where coalesce(r->>'member', '') ~ '^\d{4,12}$'
  on conflict (member) do update set monthly_cost = excluded.monthly_cost, active_lines = excluded.active_lines, holder = excluded.holder, contract = excluded.contract, updated_at = now();
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.member_cost_upsert(jsonb) from public, anon, authenticated;
-- members not sent in the latest full upload (older than the upload start) are no longer on active treatment
create or replace function public.member_cost_prune(since timestamptz) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin delete from public.member_cost where updated_at < since; get diagnostics n = row_count; return n; end $$;
revoke all on function public.member_cost_prune(timestamptz) from public, anon, authenticated;
