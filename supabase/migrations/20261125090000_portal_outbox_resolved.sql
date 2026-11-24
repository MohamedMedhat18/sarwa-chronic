-- 25 Nov 2026: a failed portal reply that is settled (later reply confirmed / the portal shows the intended decision / closed
-- after the refusal / a person checked it) becomes "resolved": it leaves "Sync failed", its history stays.
alter table public.portal_outbox drop constraint if exists portal_outbox_status_check;
alter table public.portal_outbox add constraint portal_outbox_status_check
  check (status = any (array['queued', 'sending', 'sent', 'conflict', 'error', 'dead', 'cancelled', 'resolved']));
