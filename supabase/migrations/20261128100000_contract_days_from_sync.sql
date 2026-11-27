-- The standard starting day of each contract is counted by the history sync on the Chronic PC (it reads every file line anyway);
-- refresh_contract_days() over the 290,000 lines took 12-22 s on this database and hit the API statement timeout.
create or replace function public.contracts_merge(rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.contract_info as c (contract, policy_holder, policy_no, effective, expiry, seen, start_day, day_share, members, second_day, updated_at)
  select r->>'contract', nullif(r->>'policy_holder', ''), nullif(r->>'policy_no', ''), (nullif(r->>'effective', ''))::date, (nullif(r->>'expiry', ''))::date, (nullif(r->>'seen', ''))::date,
    (nullif(r->>'start_day', ''))::int, (nullif(r->>'day_share', ''))::numeric, (nullif(r->>'members', ''))::int, (nullif(r->>'second_day', ''))::int, now()
  from jsonb_array_elements(rows) r where coalesce(r->>'contract', '') ~ '^\d{4,12}$'
  on conflict (contract) do update set policy_holder = coalesce(excluded.policy_holder, c.policy_holder), policy_no = coalesce(excluded.policy_no, c.policy_no),
    effective = excluded.effective, expiry = excluded.expiry, seen = excluded.seen,
    start_day = coalesce(excluded.start_day, c.start_day), day_share = coalesce(excluded.day_share, c.day_share), members = coalesce(excluded.members, c.members),
    second_day = case when excluded.start_day is not null then excluded.second_day else c.second_day end, updated_at = now()
  where c.seen is null or excluded.seen is null or excluded.seen >= c.seen;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.contracts_merge(jsonb) from public, anon, authenticated;
