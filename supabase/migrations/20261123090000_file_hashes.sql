-- Duplicate check (23 Nov 2026): SHA-256 of stored files, computed once and kept, so "the same file" is decided by content
-- (not by name) and a file is never downloaded twice for the check. Server only (service role); no client access.
create table if not exists public.file_hashes (
  path text primary key,
  size bigint,
  sha256 text not null,
  at timestamptz not null default now()
);
alter table public.file_hashes enable row level security;
create index if not exists file_hashes_sha on public.file_hashes (sha256);
