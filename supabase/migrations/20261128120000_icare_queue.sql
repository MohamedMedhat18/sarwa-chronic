-- i-CARE reader queue (28 Nov 2026): the app asks for a member's i-CARE details (verified / confirmed card, open ticket, nothing
-- fresher than 24 h); the reader on the Chronic PC (icare-bridge.mjs, read-only on i-CARE) takes one job at a time and the server
-- writes the result on the ticket. No member data in this table besides the card number the ticket already has.
create table if not exists public.icare_queue (
  id           bigserial primary key,
  ticket       text not null,
  member       text not null,
  status       text not null default 'queued',      -- queued | taken | done | notfound | error
  requested_by text,
  requested_at timestamptz not null default now(),
  taken_at     timestamptz,
  done_at      timestamptz,
  tries        int not null default 0,
  error        text
);
create unique index if not exists icare_queue_open on public.icare_queue (ticket, member) where status in ('queued', 'taken');
create index if not exists icare_queue_status on public.icare_queue (status, requested_at);
alter table public.icare_queue enable row level security;
drop policy if exists "members read icare_queue" on public.icare_queue;
create policy "members read icare_queue" on public.icare_queue for select to authenticated using (is_member());
drop policy if exists "members ask icare_queue" on public.icare_queue;
create policy "members ask icare_queue" on public.icare_queue for insert to authenticated with check (is_member() and status = 'queued' and ticket ~ '^CHR-\d{6}$' and member ~ '^\d{6,10}$');
revoke all on public.icare_queue from anon;
