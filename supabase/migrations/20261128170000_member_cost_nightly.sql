-- Member monthly treatment cost, recalculated every night inside the database (28 Nov 2026).
-- The folder of monthly files holds only part of the history (104k member-medicines) while member_meds has all of it (291k),
-- and summing 291k lines takes ~2 minutes on this database – too long for an API call (8 s), fine for a database job.
create extension if not exists pg_cron;

create or replace function public.refresh_member_cost_all() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  create temp table _mc on commit drop as
    select member, round(sum(case when monthly > 0 and unit_price > 0 then monthly * unit_price else 0 end), 2) cost, count(*) lines, max(policy_holder) holder, max(contract) contract
    from public.member_meds where cov_end >= current_date group by member;
  insert into public.member_cost as c (member, monthly_cost, active_lines, holder, contract, updated_at)
  select member, cost, lines, holder, contract, now() from _mc
  on conflict (member) do update set monthly_cost = excluded.monthly_cost, active_lines = excluded.active_lines, holder = excluded.holder, contract = excluded.contract, updated_at = now();
  get diagnostics n = row_count;
  delete from public.member_cost m where not exists (select 1 from _mc where _mc.member = m.member);   -- no active medicine any more
  return n;
end $$;
revoke all on function public.refresh_member_cost_all() from public, anon, authenticated;

-- every night 01:30 UTC (03:30 Cairo); a long statement is fine here (no API time limit)
select cron.unschedule('member_cost_nightly') where exists (select 1 from cron.job where jobname = 'member_cost_nightly');
select cron.schedule('member_cost_nightly', '30 1 * * *', $$set statement_timeout = '20min'; select public.refresh_member_cost_all();$$);
