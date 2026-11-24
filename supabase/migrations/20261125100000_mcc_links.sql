-- Info Desk (25 Nov 2026): Call Center requests (portal Medical Claims > Call Center > Chronic / Approval, MCC-YYYY-NNNNN).
-- One row per request number = one ticket (primary key: a request can never become two tickets).
create table if not exists public.mcc_links (
  request_no text primary key,
  ticket text not null,
  kind text not null check (kind in ('chronic', 'approval')),
  member_id text,
  current_status text,           -- the Call Center's status (In Progress / ...)
  team_status text,              -- our team's decision on the portal (Team Action Status)
  in_list boolean not null default true,   -- shown in the Call Center list now (false = closed by the Call Center)
  closed_at timestamptz,
  last_hash text,
  line_ids text[] not null default '{}',   -- Timeline lines already in the ticket
  file_ids text[] not null default '{}',   -- files already stored
  synced_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mcc_links_ticket on public.mcc_links (ticket);
alter table public.mcc_links enable row level security;
