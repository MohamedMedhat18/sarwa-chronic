-- Contracts: effective / expiry dates (GlobeMed monthly chronic files, columns "Effective DATE" / "Expiry DATE" / "Policy Number")
-- and the standard monthly-treatment starting day of each contract (the day most of its members start on).
-- Read by the app (Patient info, Chronic validation: starting day, "Till renewal date"), filled by the history sync on the
-- Chronic PC (bridge action contracts_upsert) and recalculated by refresh_contract_days() after every sync.
create table if not exists public.contract_info (
  contract      text primary key,
  policy_holder text,
  policy_no     text,
  effective     date,
  expiry        date,
  seen          date,          -- the newest file line (distribution date) the dates come from
  start_day     int,           -- standard starting day (1..31) from the members' coverage start dates
  day_share     numeric,       -- share of the contract's members that start on that day
  members       int,
  second_day    int,
  updated_at    timestamptz default now()
);
alter table public.contract_info enable row level security;
drop policy if exists "members read contract_info" on public.contract_info;
create policy "members read contract_info" on public.contract_info for select to authenticated using (is_member());
revoke all on public.contract_info from anon;

-- rows: [{contract, policy_holder, policy_no, effective, expiry, seen}] – a newer line (seen) wins; an older one never overwrites
create or replace function public.contracts_merge(rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.contract_info as c (contract, policy_holder, policy_no, effective, expiry, seen, updated_at)
  select r->>'contract', nullif(r->>'policy_holder', ''), nullif(r->>'policy_no', ''), (nullif(r->>'effective', ''))::date, (nullif(r->>'expiry', ''))::date, (nullif(r->>'seen', ''))::date, now()
  from jsonb_array_elements(rows) r where coalesce(r->>'contract', '') ~ '^\d{4,12}$'
  on conflict (contract) do update set policy_holder = coalesce(excluded.policy_holder, c.policy_holder), policy_no = coalesce(excluded.policy_no, c.policy_no),
    effective = excluded.effective, expiry = excluded.expiry, seen = excluded.seen, updated_at = now()
  where c.seen is null or excluded.seen is null or excluded.seen >= c.seen;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.contracts_merge(jsonb) from public, anon, authenticated;

-- standard starting day per contract: per member the most common day of the month their medicines start (last 13 months),
-- then the most common of those days in the contract (same method as refresh_holder_days, one level finer)
create or replace function public.refresh_contract_days() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  create temp table _cm on commit drop as
    select contract, member, mode() within group (order by extract(day from cov_start)::int) dd
    from public.member_meds where coalesce(contract, '') <> '' and cov_start >= current_date - 400 group by 1, 2;
  with d as (select contract, dd, count(*) m from _cm where dd is not null group by 1, 2),
  r as (select contract, dd, m, sum(m) over (partition by contract) tot, row_number() over (partition by contract order by m desc, dd) rk from d),
  x as (select a.contract, a.dd, a.tot, round(a.m::numeric / a.tot, 3) share, b.dd sec_day from r a left join r b on b.contract = a.contract and b.rk = 2 where a.rk = 1)
  insert into public.contract_info as c (contract, start_day, day_share, members, second_day, updated_at)
  select contract, dd, share, tot, sec_day, now() from x
  on conflict (contract) do update set start_day = excluded.start_day, day_share = excluded.day_share, members = excluded.members, second_day = excluded.second_day, updated_at = now();
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.refresh_contract_days() from public, anon, authenticated;
