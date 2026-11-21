# Portal (Chronic Attach) ⇄ Sarwa Chronic

> **Two ways to connect, one switch (Settings › Portal › Connection):**
> - **Portal screens via the Outlook bridge PC (no IT)** – available now. `tools/portal-bridge/` drives the real portal
>   in Chrome on the bridge PC. Needed because the portal is reachable only from inside the Sarwa network (tested
>   21 Nov 2026: Supabase → portal times out after 20 s; a Sarwa PC → portal answers in 0.7 s).
> - **Live portal API (ORDS)** – the permanent alternative below, if IT ever builds the endpoint. Switching is a setting.
>
> Both use the same tables, ticket rules, decision mapping, retries, Sync-failed queue and audit log.

## No-IT path (browser bridge) – what is built and tested

| Piece | File |
|---|---|
| Bridge endpoints | `portal` function: `bridge_config` (kill switch), `bridge_ingest`, `bridge_peek` (look, no claim), `bridge_jobs` (claim one named job), `bridge_job_result`, `bridge_reconcile`, `bridge_health` (alerts admins) |
| Worker | `tools/portal-bridge/bridge.mjs` + `Set-PortalCredential.ps1`, `Start-PortalBridge.ps1`, `Install-PortalBridgeTask.ps1`, `reply-map.example.json`, README |
| Tests | `tests/portal-browser-e2e.ps1` – 22/22 (the script plays the bridge PC); `tests/portal-e2e.ps1` – 23/23 (ORDS/mock path) |

Verified read-only on the live Chronic Attach page: the worker's reader gets 9/9 open requests with all 15 columns
(matches the report counter "1 - 9"); Starting Day found for 9/9 from the Policy-holder data.

**Still blocked (needs a test request):** the Reply form fields (`reply-map.json`) and the Broker / Sarwa Attachment
pages. Until then the bridge imports requests and reads timelines, but never submits, and portal attachments are not
copied into tickets.

Every request on the Sarwa portal's **Chronic Attach** page (Oracle APEX 23.2, Medical Claims app 2009, page 165) appears
automatically as a ticket in Sarwa Chronic. The agent reviews and answers **only in Sarwa Chronic**. The decision goes back
through the portal's own Reply logic, which updates the status, writes the Request Timeline and sends the message (WhatsApp to the
member, or email to the broker with every Cc). The ticket closes or goes Pending only after the portal confirms.

```
Portal (APEX + Oracle)                      Supabase (Sarwa Chronic)                         Agents
 Chronic Attach  ──GET /requests (5 min)──▶  Edge Function "portal"  ──events──▶  tickets  ◀──  app (index.html)
   ORDS module   ◀─POST /decision──────────   portal_outbox ◀── queued decision ───────────────┘
   Reply logic → status, Request Timeline, WhatsApp / broker email
```

**Why this design:** the Module has no server of its own, but its Supabase project does. An Edge Function keeps the
OAuth2 secret server-side, creates tickets even when nobody has the app open, and retries on its own. The portal's business
rules stay in one place, because the decision endpoint runs the **same PL/SQL as the Reply button**. Nothing writes into portal
tables directly.

## What is built (branch `feature/portal-sync`)

| Piece | File | What it does |
|---|---|---|
| Tables, RLS, RPCs | `supabase/migrations/20261121120000_portal_sync.sql` | `portal_links` (request id ⇄ ticket, de-duplication), `portal_outbox` (decisions to post, one in flight per ticket), `portal_sync_log` (audit), `portal_state`, mock tables; `portal_next_ticket`, `portal_claim_outbox` (skip-locked), `portal_try_lock`, `portal_holder_day` (Policy Holder → Starting Day from `holder_days`, else through the member's GlobeMed history). Additive only. |
| Sync function | `supabase/functions/portal/index.ts` | `tick` / `push` / `retry` / `cancel` / `status` / `log` for members; `set_config` / `test_connection` / `sync_now` / `reset_cursor` / `new_token` for admins. |
| Mock portal | `supabase/functions/portal-mock/index.ts` | The ORDS contract below, with TEST requests only, plus `/_test/*` helpers (seed, member reply, direct portal change, fault injection, act as agent). |
| App | `index.html` | Portal panel on the ticket. Decision buttons and Pending go through the portal. Reply on a portal ticket goes through the portal. Views: Portal – open, waiting, sync failed, changed on the portal. Settings › Portal (connection, status, sync log). |
| Tests | `tests/portal-e2e.ps1` | 22 end-to-end checks against the mock. |

## Field mapping (portal → ticket)

| Portal (page column / API field) | Ticket | Rule |
|---|---|---|
| Request Id / `request_id` | `portal.requestId`, subject `Chronic Attach #<id> – <name>` | **Unique key** (`portal_links` primary key). A re-run never creates a second ticket. |
| Individual Number / `individual_number` | `member` (card no.) | Drives GlobeMed history, i-CARE, Suggested decisions |
| Individual Name / `individual_name` | `memberName` | |
| Creation User / `mobile` | `mobile` (01xxxxxxxxx), requester phone | WhatsApp requests: the member's number |
| Cr Type / `channel` | `portal.channel`, tag `whatsapp` / `broker` | Decides the reply channel (on the portal side) |
| Policy Holder (+ Policy Holder Name) | `portal.policyHolder` | First non-empty |
| — (reference data) | `portal.startDay` (+ `secondDay`) | `holder_days` by holder name; else by the member's holder in `member_meds`; `starting_day` from the API wins if IT provides it |
| Contract no / `contract_no` | `portal.contractNo` | IT to confirm which of the two "Contract No" columns is authoritative |
| Broker / Broker Mail / `cc[]` | requester email, `portal.brokerMail`, `portal.cc` | The portal replies to all of them (Reply All) |
| Chronic Status Name / `status_code` | `portal.statusCode/statusName` | See status table |
| Chronic Date, Creation Date | `portal.chronicDate`, ticket created | |
| Assign To | `portal.assignTo` | Shown only |
| Item codes / `item_codes[]` | `portal.items` | **Not on the page** – IT to add |
| Broker / Sarwa attachments | ticket attachments (open inside the app) | Copied to storage; > 20 MB stays a link to the portal |
| Request Timeline rows from the requester | new message on the ticket | Reopens a Pending ticket, tag `customer_response` |

## Status mapping (for approval before cutover)

Portal status codes as read from the page's Status Filter: 1 Assigned · 2 Processing · 3 Pending · 4 Closed · 5 Approved ·
6 Partially_Approved_Pending · 7 Partially_Approved_Rejected · 8 Rejected · 9 Reopened.

| Agent decision in Sarwa Chronic | Posted `decision` | Portal status after | Message to requester | Ticket after the portal confirms |
|---|---|---|---|---|
| Approved | `APPROVE` | **5 Approved** (final) | Approval text (+ attachments) | Closed, decision Approved |
| Partially approved | `PARTIAL` | **7 Partially_Approved_Rejected** (final) | Which items are not approved | Closed |
| Rejected | `REJECT` (reason mandatory) | **8 Rejected** (final) | Rejection reason | Closed |
| Pending – customer reason (missing documents, customer info, pharmacy & branch) | `PENDING_DOCS` | **3 Pending** (not closed) | Missing documents list | Pending – reason (sub-folder) |
| Pending – Awaiting medical team decision ("Refer to medical team") | nothing posted | unchanged | none | Pending – reason (internal) |
| Reply / reminder on a portal ticket | `MESSAGE` | unchanged | the text | unchanged |

| Portal change seen by the sync | Effect on the ticket |
|---|---|
| New request, status 1/2/3/6/9 | New ticket (Open) |
| New request already 4/5/7/8 | Not imported (history before go-live) |
| Requester answered (new file / message, or status → 9 Reopened) | New message; a Pending/Closed ticket reopens with `customer_response` |
| Status changed **on the portal by staff** | Note on the ticket, "Changed on the portal" view; a later decision gets 409 and is not sent |
| Our own decision (timeline entry `actor_type = integration`) | Ignored (no loop) |

**To confirm with the portal owner:** whether "Pending – need documents" should be 3 Pending (used here) or 6
Partially_Approved_Pending; what "Pending Wp" means; and whether 4 Closed is ever set by Reply.

## Rules that are enforced

- **One source of truth = Sarwa Chronic.** IT is asked to hide or lock the Reply button for requests that are linked
  (decision endpoint returns 423 for manual replies, or the page shows "Answered in Sarwa Chronic").
- **No second sender.** The Module never emails or WhatsApps a portal requester; only the portal does.
- **Never "replied" while the portal is open.** A queued decision shows "Waiting for the portal". The ticket stays in
  Unresolved and its SLA is not met until the portal confirms.
- **Idempotent.** Each decision is one `portal_outbox` row whose id is the `Idempotency-Key`. Only one row can be in flight
  per ticket. Jobs are claimed with skip-locked.
- **Failures:** network / 5xx / 429 / 401 → retry after 1, 2, 4, 8 minutes. After 5 tries → *Sync failed*: the ticket stays
  open, it is listed in "Portal – sync failed", and admins get an email (through the existing Outlook outbox). 409 → *conflict*
  (refresh and resend). Other 4xx → *refused* with the portal's message. Each case has a "Try again" and a "Cancel" button.
- **Security:** dedicated OAuth2 client (client credentials) stored in `app_secrets`, readable by the server only and never by a
  browser. The repository is public: no secret, token or member data is committed. Scheduler / test access uses a `chp_` token,
  of which only the SHA-256 hash is stored.
- **Network:** calls come from Supabase Edge Functions (EU, `eu-central-1`), which have **no fixed outgoing IP**. If IT requires
  an IP allow-list on the ORDS module, the fallback is to relay through the on-prem Outlook bridge PC (same pattern as the mail bridge).
  Without an allow-list, the controls are OAuth2 client + HTTPS + a privilege limited to this module.
- **Audit:** the portal Request Timeline (business record) plus `portal_sync_log` (every call, direction, who, old → new status,
  HTTP code, error), shown in Settings › Portal.

## ORDS contract IT is asked to build

Base: `https://sl-portal.sarwa.insurance/ords/sl_ws/chronic/v1` · Token: `https://sl-portal.sarwa.insurance/ords/sl_ws/oauth/token`
(ORDS OAuth2 client, `client_credentials`, privilege on the module only, 1-hour tokens).

**GET `/requests?changed_since=<ISO-8601>&limit=50&offset=0`**
```json
{ "items": [ { "request_id": "38206", "status_code": 3, "status_name": "Pending", "last_update": "2026-11-20T21:29:00Z" } ],
  "hasMore": false, "limit": 50, "offset": 0, "count": 1 }
```

**GET `/requests/{id}`**
```json
{ "request_id": "38206", "individual_number": "51389865", "individual_name": "…", "mobile": "2011…", "creation_user": "2011…",
  "channel": "WhatsApp", "contract_no": "50045954", "policy_holder": "…", "policy_holder_name": null,
  "broker": null, "broker_mail": null, "cc": [], "status_code": 3, "status_name": "Pending",
  "chronic_date": "2026-11-20", "assign_to": null, "creation_date": "2026-11-20T21:29:00Z", "last_update": "2026-11-20T21:29:00Z",
  "request_type": "New", "starting_day": null, "notes": "…",
  "item_codes": [ { "code": "…", "name": "…", "dose": "…", "quantity": 30 } ],
  "attachments": [ { "id": "1201", "file_name": "rx.jpg", "mime_type": "image/jpeg", "size": 183422, "source": "Broker", "uploaded_at": "…" } ],
  "timeline": [ { "id": "9001", "status_code": 3, "status_name": "Pending", "comment": "…", "extra_comment": "", "by": "2011…",
                  "actor_type": "requester", "source": "whatsapp", "at": "…" } ] }
```
`actor_type` is `requester` (member / broker), `staff` (portal user) or `integration` (posted by Sarwa Chronic).

**GET `/requests/{id}/attachments/{attachment_id}`**: the file bytes, with `Content-Type` and `Content-Disposition`.

**POST `/requests/{id}/decision`**: header `Idempotency-Key: <job id>`
```json
{ "decision": "PENDING_DOCS", "status_code": 3, "message": "عميلنا العزيز …", "message_html": "<p>…</p>",
  "reason": "Missing documents", "missing_documents": ["HbA1c (≤ 6 months)"], "agent_name": "…", "agent_email": "…",
  "ticket": "CHR-000412", "base_last_update": "2026-11-20T21:29:00Z", "source": "sarwa-chronic",
  "attachments": [ { "file_name": "screenshot.png", "mime_type": "image/png", "content_base64": "…" } ] }
```
→ `200 { "request_id": "38206", "status_code": 3, "status_name": "Pending", "timeline_id": "9002", "last_update": "…",
"delivered": { "channel": "whatsapp", "to": "2011…", "cc": [] } }`.
Errors: `409` the request changed after `base_last_update` or is already final. `422` invalid (e.g. REJECT without reason).
`423` locked. Same `Idempotency-Key` again → the first answer, nothing done twice. The endpoint must call **the same package
as the Reply button on page 173**, so the status, Request Timeline, notifications and Sarwa Attachment all behave as for a
manual reply.

## Interim plan (until IT delivers) — manual steps marked ✋

1. ✋ Every morning, Chronic Attach › Actions › Download › CSV (or a daily Subscription to the Chronic mailbox).
2. ✋ Settings › Portal stays **Off**. Requests are worked from the CSV; the decision is entered in the portal with Reply.
3. Sarwa Chronic is used for validation and Suggested decisions as today.

## Cutover

1. Deploy the migration + both functions (additive). Settings › Portal = **Mock**. Run `tests/portal-e2e.ps1` → 22/22.
2. IT delivers the ORDS module on UAT. Admin enters its addresses + client in Settings › Portal (Live), then clicks **Test connection**.
3. Approve the status mapping above. Pick a go-live time and set "Start with requests changed after" to it.
4. Go live: Live mode; open requests from that time come in; IT locks Reply for linked requests.
5. First week: daily check of "Portal – sync failed" and the sync log.
