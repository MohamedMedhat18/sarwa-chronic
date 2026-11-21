-- Portal history: every Chronic Attach request ever made (decided ones included), as a searchable record in Sarwa Chronic.
-- Open requests are also tickets (portal_links); old decided ones live here only, so they do not fill the ticket queues,
-- do not use CHR numbers and do not slow the app. Shown on the member panel of every ticket and in Portal > History.
create table if not exists public.portal_history (
  request_id       text primary key,
  individual_number text,
  individual_name  text,
  policy_holder    text,
  contract_no      text,
  channel          text,
  creation_user    text,
  broker           text,
  broker_mail      text,
  status_code      int,
  status_name      text,
  chronic_date     date,
  creation_date    timestamptz,
  assign_to        text,
  source           text not null default 'chronic-attach',
  imported_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists portal_history_member  on public.portal_history (individual_number);
create index if not exists portal_history_created on public.portal_history (creation_date desc);
create index if not exists portal_history_status  on public.portal_history (status_code);
alter table public.portal_history enable row level security;
create policy "members read portal_history" on public.portal_history for select using (public.is_member());
