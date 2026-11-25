-- Info Desk (25 Nov 2026, approved): a Call Center request becomes OUR ticket only when its Current Status (list) is no
-- longer "Open" (= the Call Center handed it to the Chronic team: In Progress). While Open it is only watched (no ticket).
create table if not exists public.mcc_watch (
  request_no text primary key,
  kind text not null check (kind in ('chronic', 'approval')),
  member_id text,
  member_name text,
  call_type text,
  request_type text,
  current_status text,
  fp text,                                   -- fingerprint of the list row (status, team decision, notes, assignee)
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.mcc_watch enable row level security;
-- the last list fingerprint per ticketed request: unchanged requests cost no Timeline read
alter table public.mcc_links add column if not exists fp text;
alter table public.mcc_links add column if not exists tl_read_at timestamptz;
create index if not exists mcc_links_status on public.mcc_links (current_status, in_list);
