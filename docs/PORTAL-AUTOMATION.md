# Portal cycle automation (Chronic Attach -> Sarwa Chronic -> portal / WhatsApp)

Status: 21 Nov 2026. Live project, dry run ON.

## 1. Inbound: request -> ticket with all files

| Step | How |
|---|---|
| List of requests | Chronic Attach report (page 165), read in the signed-in page |
| Request Timeline | page 172 - the signed dialog URL is in every report row; fetched with a plain GET |
| Broker / Sarwa attachments | the Actions drawer (page 173, signed URL in the row) carries signed URLs of pages 170 and 166; their `apex_util.get_blob` links are resolved against `<base href="/ords/">` and downloaded in the same session |
| Code | `tools/portal-bridge/portal-reader.js` (read only, no clicks); `bridge.mjs` injects it |
| Server | `portal` function `bridge_ingest` -> ticket (folder "Sarwa Chronic Portal", tag `chronic_portal`), files in the private `chronic` bucket at `hd/files/<ticket>/p_<portal file id>_<name>` (one object per portal file - never stored twice) |

Root cause of the first import without files (21 Nov): the importer did not open the attachment pages (rule: do not click
Broker / Sarwa Attachment on live requests), so it sent `attachments: []`. A second trap was found while fixing it: the
download link is relative; resolved against the page URL it returns a 683-byte "page isn't available" HTML page.
Backfill: `bridge_ingest` with `backfill: true` adds the files to the original request (no customer-response, no reopen).

## 2. Arrival checks (rules engine, server)

Every rule result is logged (`portal_sync_log`, action `rule:R1`...`rule:R5`, then `suggestion`) and shown on the ticket
("Checks on arrival").

| Rule | Check | Result |
|---|---|---|
| R1 Documents present | files from the portal on the ticket (readable by the AI reader or not) | fail = no file -> suggest Pending - Missing documents |
| R2 Duplicate request | other OPEN ticket or other OPEN portal request for the same member | warn -> suggest review as possible duplicate |
| R3 Recent portal decision | same member decided on the portal in the last 30 days | warn |
| R4 Starting Day alignment | Starting Day of the policy holder -> the monthly cycle that contains the request date (e.g. day 1, request 21/11/2026 -> treatment start 01/11/2026, next cycle 01/12/2026) | info / warn if no Starting Day |
| R5 Contract active / eligible | needs i-CARE (agent button / i-CARE helper) | info |
| Items (app) | after the AI reader read the prescription: item codes vs the confirmed team rules and past decisions (`suggestedDecision`) | Approve / Partial / Reject / Pending with confidence |

## 3. Automation levels (Settings > Portal, per decision type)

| Decision type | Recommended | Why |
|---|---|---|
| Pending - missing documents (no file at all) | Level 2 now; Level 1 candidate | objective (R1), the message is the portal's own Pending template with the missing list; low risk, it does not close anything |
| Approve (all items approved by confirmed team rules) | Level 2 | money decision; the AI reading of a prescription can be wrong; one click keeps a person accountable |
| Reject (item not covered by a confirmed rule) | Level 2 | final and sent to the member; needs a person to read the justification |
| Partially approved | Level 3 | mixed outcome, wording matters |
| Duplicate request | Level 3 | linking / merging needs judgement |
| Needs review / conflicting past decisions | Level 3 | uncertain by definition |
| Refer to medical team | Level 3 (locked) | internal, medical judgement |

Level 1 is locked in the app and nothing executes automatically. A Level 1 rule needs: the admin's written approval
of that rule, dry-run evidence on 20+ real tickets with 0 wrong suggestions, and its own kill switch.

## 4. Outbound: reply delivery

| Requester | Path | Status |
|---|---|---|
| Broker (Cr Type BROKER) | the portal's own Reply (page 168): status + message + files -> Request Timeline -> the portal emails the broker | works (bridge; confirmed by Request Timeline). Live writes are allowed per request only (`LIVE_WRITE_ALLOW`) |
| Member on WhatsApp (Cr Type WhatsApp / Clinic) | the SAME portal Reply: the portal sends the message and the attached files on WhatsApp to the request's Creation User | works - proven on test request 38218 (message + image received on WhatsApp, 21 Nov 2026) |
| Direct WhatsApp from Sarwa Chronic (optional) | WhatsApp Business Platform (Cloud API, official) | not built - needs the items below |

Recommendation: keep replies going through the portal's Reply. One action writes the decision, the Request Timeline,
the portal status AND the WhatsApp / email - the portal stays the record, and no second WhatsApp number is needed.

Direct WhatsApp (only if wanted, e.g. reminders without a portal status change) - what Sarwa must provide:
1. A Meta Business Manager account for Sarwa Life (business verification done).
2. A WhatsApp Business Account (WABA) and a phone number registered to the Cloud API (not used in the WhatsApp app). If the
   portal's WhatsApp number already runs on the Cloud API through a provider, its provider's API access instead.
3. A permanent System User access token with `whatsapp_business_messaging` (stored only in Supabase secrets).
4. Approved message templates (Arabic + English) for messages sent outside the 24-hour window (e.g. "missing documents",
   "decision ready"); free-form text is allowed only within 24 hours of the member's last message.
5. Opt-in: the member contacted Sarwa first on WhatsApp (portal bot) - keep that record; offer opt-out.
6. A webhook URL for delivery receipts (a Supabase function) so a ticket is "delivered" only on the receipt.
Unofficial WhatsApp automation (WhatsApp Web scripts, unofficial libraries) is not used.

### First live reply from Sarwa Chronic (21 Nov 2026, test request 38234, approved by the admin)

| Cairo time | Step |
|---|---|
| 17:53 | test request created on WhatsApp (2 files) |
| 17:54 | portal agent imported it by itself (ticket, both files, arrival checks R1-R5) |
| 17:56 | Send on the ticket (Pending - missing documents + test image); live list = this request only |
| 17:58 | agent filled the portal's Reply form (status 3, AR, template + text, file) and saved it |
| 17:58 | new entry found in the Request Timeline -> job "sent" on attempt 1 -> ticket Pending |
| 17:58 | WhatsApp with the message and the image received on the requester's phone (confirmed) |

Settings > Portal: dry run OFF, Live requests = the approved request numbers; "Live for all" stays off until approved.

## 5. Done only after confirmation

A decision or message is "sent" only when the bridge sees the new entry in the portal's Request Timeline. Failures are
retried (1, 2, 4, 8, 16 min); then the job goes to "Portal - Sync failed" and an admin alert email is queued. A request
changed on the portal by someone else is never overwritten ("Changed on the portal").

## Stuck replies: safeguards (22 Nov 2026)

Incident: CHR-000361 / request 38219 (Rejected) showed "Waiting for the portal" for 10 h. The server marked the job
`sending` while the bridge's connection to Supabase dropped (09:42-09:49 UTC, "fetch failed"), so the bridge never got it;
the bridge only looks at `queued` jobs and nothing timed it out. Fixed by one retry on 22 Nov 20:19 UTC (portal Timeline
checked first; confirmed Rejected, WhatsApp by the portal).

What prevents it now:
| Safeguard | Where |
|---|---|
| Lease: a claimed reply with no answer for 5 min goes back to the queue; the retry is attempt 2+, so the bridge checks the Request Timeline before Save (never twice) | `sweep()` in the portal function, `portal_claim_*` |
| At most 3 tries (back-off 1 min, 3 min), then Sync failed + admin email | `MAX_ATTEMPTS`, `RETRY_MIN` |
| 15-minute timeout: not confirmed -> `dead` (http 408) with the cause (bridge silent, sign-in expired, last error); one alert email; ticket shows "Failed - not confirmed in 15 min" + Try again | `sweep()` step 2 |
| Status sync: the app's view (portal.status events) is compared with the queue every minute and corrected | `sweep()` step 3 |
| Late confirmation: for 48 h the bridge looks for timed-out replies in the portal Timeline (read only) and marks the ones that arrived as sent | `bridge_unconfirmed`, `lateConfirm()` |
| Results are kept in state.json on the bridge PC until Sarwa Chronic receives them; network calls are retried 3 times | `reportResult()`, `call()` |
| Bridge silent 6+ min or portal sign-in expired: shown in Settings > Portal > Portal health and emailed (hourly); replies stay queued | `bridgeProblem()` |
| Old bridge copies (and the old in-page agent) cannot claim replies (version 6+) | `BRIDGE_MIN_VERSION` |
| Daily list (07:00 Cairo) of every reply not confirmed in the last 7 days, to the admins | `sweep()` step 5 |

The sweep runs inside the portal function at most once a minute, triggered by the bridge's polls and by every open app's
tick, so it also runs while the bridge PC is down. One job per ticket while open (`portal_outbox_one_open`), job id =
idempotency key.

## One request = one ticket: email + portal in the same ticket (23 Nov 2026)

CHR-000348 (email) and portal request #38210 (WhatsApp, same member, same day) were linked on 21 Nov by a one-off data
update the app did not read: the ticket stayed "email only", was answered and closed by email, and #38210 stayed Pending on
the portal with no way to answer it from the ticket. Now:

* `portal.link` event: a portal request linked to an email ticket gives that ticket the full portal channel (`t.portal`).
  A merge carries the portal request to the target ticket; the server sends later portal updates to the ticket a request
  was merged into (`finalTicket()`).
* Reply box of an email + portal ticket: tick **Email (Reply All)** and/or **Portal -> WhatsApp / broker email**; the
  recipients of each channel show before sending; each channel shows its own status (email: Outlook; portal: confirmed in
  the portal Timeline; never "waiting" for more than 15 min). WhatsApp is the portal's own delivery for WhatsApp requests
  (no second, unofficial WhatsApp).
* Decision buttons on such a ticket send the decision through the portal and, ticked by default, the same text by email.
* Portal panel: **Close portal request: Approved / Partially approved / Rejected**, also when the ticket is already closed
  (warning "Closed here, but still Pending on the portal"). An already decided request shows why nothing can be closed.
* Duplicate rule: merged / linked automatically only when certain - same member card AND a byte-identical file (SHA-256,
  table `file_hashes`) AND within 3 days; only tickets created after 23 Nov 09:05 UTC, never one already answered, never
  two different portal requests (each needs its own answer). A new portal request that is already here by email is linked
  to that ticket on arrival. Anything less: a "Possible duplicate / Same request?" banner with Merge... for the team.

## Portal vs Sarwa Chronic count (24 Nov 2026)

Seen: portal Pending 16 vs 9 tickets in the Sarwa Chronic Portal queue. Causes found (bridge log + Windows events):
1. The bridge stopped at 02:20 Cairo: after a slow night sign-in it judged "wrong password" after 2.5 s and stopped for good
   (same on 23 Nov 02:32). The stored password was right: it signed in at once in the morning.
2. This PC went into Modern Standby from 18:40 (network throttled: "Sarwa Chronic not reachable") and slept 03:28-10:10.
3. With more Pending requests than one report page, requests on another page could not be read ("not on the report") and
   one such error - or a request decided during the cycle - ended the whole cycle, so nothing after it was read.
Fixed 24 Nov: 11 missing requests became tickets within minutes of the restart; 17 shown = 17 read = 17 with a ticket.

Guards: sign-in waits up to 45 s and stops only on the portal's own refusal text (max 3 attempts / hour, then waits);
the bridge keeps the PC out of standby while it runs (Windows power request, no setting changed); the page of each
request is shown before it is read; one unreadable request is logged and retried, never ends the cycle; portal total vs
rows read is checked every cycle (re-read, then alert); the server keeps the "Portal vs Sarwa Chronic" counter
(Settings > Portal > Portal health) and emails the admins when a request has no ticket for 10+ minutes; the daily
07:00 email carries the comparison. Note: the portal's "Pending Wp" card is not the same as the report's Pending list.

## "Sync failed" = only what needs a person (25 Nov 2026)

The folder showed a ticket while its LAST portal reply was refused / failed, and nothing ever settled that: CHR-000361
(our Rejected reached the member 22/11; a later Approved was refused because the portal had already decided) stayed there
after the ticket was resolved. Now a failed reply becomes **resolved** (status `resolved`, history kept, note in the ticket)
automatically, every minute, when: a later reply for the ticket was confirmed; or the portal already shows the intended
final decision; or the portal had already decided and the ticket was closed after the refusal. A person can also
**Mark as resolved** with a required note. States: Waiting (goes out by itself) / Failed (needs a person) / Resolved.
The folder count is the same filter as its list. Left for a person on purpose: a refusal where the portal's decision
differs from ours and nobody has looked at it since (e.g. CHR-000382 / 38234).

## Info Desk – Call Center requests (25 Nov 2026)

Portal Medical Claims > Call Center > **Chronic** / **Approval** (request numbers MCC-YYYY-NNNNN). The Call Center creates the
request (Call Type WP = the member wrote on WhatsApp, INCOMING = phone call), works it ("Open" -> "In Progress", reasons,
files) and closes it; it answers the member. Our team's only action: **Actions -> Team Status** (page 6): Status (Approved /
Partially Approved Rejected / Rejected / Pending, **required** – a comment alone is refused: tested 25 Nov on MCC-2026-05976,
"Status must have some value", nothing saved) + Comment + Save. The list shows every request still "In Progress" (the Status
Filter does not apply to it); a request closed by the Call Center leaves the list.

| Portal | Ticket (folder **Info Desk**, tags info_desk / mcc / chronic or approval) |
|---|---|
| new request | one ticket (key = request number, table `mcc_links`), details + Timeline + files |
| Call Center follow-up / new file / back in the list | same ticket, note "Follow-up from / Reopened by the Call Center", reopened |
| our reply (decision + comment), confirmed in the Timeline | Pending - Awaiting Call Center (or Closed if the agent chose it) |
| left the list | note "Closed by the Call Center on ..."; the ticket closes if our team had decided, else stays open |
| reply after the Call Center closed it | Resolved: "reply saved on the ticket only" (never Waiting / Failed) |

No email / WhatsApp to the member. Linked (not merged) to a Chronic Attach ticket of the same card. Approval requests: same
folder, tag approval, "Forward to Approval team" (Approval@sarwa.life) – preview only until the template is approved
(`MCC_FORWARD_LIVE`). Same safeguards as the other portal flows (queue, Timeline check, retries, sweep, alerts, sync light).

### Open vs In Progress: who owns the request (25 Nov 2026, approved)

The list column **Current Status** decides, not the Timeline (every Call Center save writes an "Open -> In Progress" line
there, even while the list still says Open):

| Current Status (list) | Meaning | Sarwa Chronic |
|---|---|---|
| Open | the Call Center is still working on it | **no ticket** – watch list `mcc_watch`, sidebar "Call Center working" |
| In Progress | handed to the Chronic team | one Info Desk ticket (created at handover, note "Handed to the Chronic team …") |
| In Progress -> Open | returned to the Call Center | note, ticket Pending – Awaiting Call Center, hidden from Info Desk |
| -> Pending Info | waiting for the Call Center / member | note, ticket Pending – Awaiting Call Center |
| Open / Pending Info -> In Progress | back to us | note "Back from the Call Center", ticket Open again |
| left the list while Open | closed by the Call Center | removed from the watch list, nothing else (no ticket existed) |

A reply on a request that is still Open is possible but asks for confirmation first.

**Performance.** The bridge keeps a fingerprint of each list row (Current Status, Team Action Status, Team Comment, Request
Notes, Assigned To, Request Annex, Request Priority). Unchanged rows are skipped; a Timeline is read only for a changed row, a
new handover, or the full pass every 10 minutes (files the Call Center adds later). Open rows never read a Timeline. Files are
downloaded once (known file ids). Each cycle logs `pages`, `timelines`, `skipped`, `secs`; the server keeps them in
`portal_state.mcc_reconcile`.

## Large files go up one at a time (25 Nov 2026)

Request 38408 had no ticket for about 2.5 hours: all its files were sent as base64 inside one message and the server ran
out of memory ("546 Memory limit exceeded") on every try. Now the bridge sends a request's biggest files separately, one
call each as raw bytes, to `hd/staging/…` (until what is left inside the message is under 3 MB). The message only names
them; the server copies them into the ticket's folder inside storage and removes the staged copy. The SHA-256 is taken at
upload (duplicate rule, `file_hashes`). Same for Info Desk (Call Center) files. Bridge token only; bad paths are refused.

When the portal confirms a reply, the ticket status chosen with it is applied only if nobody changed the ticket's status
after the reply was queued; otherwise the later status stays and a note says so.

## New email – start a new conversation from the helpdesk (26 Nov 2026)

"✉ New email" (header, shortcut **C**) works like Outlook's New Message. One new email = **one new ticket**
(source `outbound`, tag "New email", assigned to the sender). The ticket number is added to the subject
(`Subject [CHR-000123]`), so the recipient's reply joins the ticket; the copy Outlook files in Sent Items is recognised
(ChronicOutId tag + ticket number) and never makes a second ticket. No auto-acknowledgement (that only answers incoming
email) and no "email without ticket" (the ticket exists before the email leaves).

- From: the shared mailbox only. To / Cc / Bcc with suggestions from past contacts; max 25 recipients.
- Warnings before sending: no subject, attachment mentioned but none attached, more than 10 recipients, an address never
  emailed before. One confirmation lists To / Cc / Bcc and the domains.
- Same editor as Reply (RTL for Arabic, pasted pictures, templates with {{placeholders}} filled at send, signature), files
  up to 20 MB in total.
- Ticket details: folder (group), priority, type, tags, member card, related ticket (a note on both), status after sending
  (default Pending – Awaiting customer info; the reply opens it again).
- Draft: saved on this PC every second of typing (text, settings, files), one per agent, restored when New email opens.
- Undo: nothing is written for 10 seconds after Send. Closing the page in that time sends nothing (the draft stays).
- Schedule send: `job.sendAt`; the bridge function's `outbox_list` holds the email until then. "Cancel sending" on the
  ticket (RPC `outbox_cancel`, until 1 minute before) marks it `cancelled` – nothing is deleted.
- Sent by the Outlook PC through the same queue as replies (Sent Items check, 6 retries, never twice). A retry after a lost
  connection reuses the draft's queue id and ticket, so it can never queue the email twice.
- Bcc: the Outlook PC script adds `job.bcc` as Bcc recipients (one line; replies have no bcc and are unchanged).
- The bridge function source is now in the repo (`supabase/functions/bridge`).

## Failures of 26 Nov 2026 and what now prevents them

| Ticket | What happened | Root cause | Now |
|---|---|---|---|
| CHR-000898 | Approved refused "request changed on the portal", Try again pressed 4 times | the request was already Rejected **by our own team from the same ticket**; a decided request takes no new decision (bridge guard), but the app let it be queued and the message blamed the portal | the app checks before queuing and offers to send the text as a Message; the server says who decided it; "Send as message" replaces Try again; same status + no text = closed as done |
| CHR-000917, CHR-000850 | "Refused by the portal" ORA-12899 | the Call Center Team Comment holds **1000 bytes** (UTF-8, CRLF – an Arabic letter is 2); 1300 / 1315 were sent | live byte counter + Shorten in the reply box; refused before queuing and in the bridge before the portal is touched; "Shorten & edit" on the failed reply |
| 5 tickets on 26 Nov | the member got the same letter twice (Message, then Approved with the same text) | the warning only offered "send again" or "cancel" | "Approved without sending the text again" is offered first (the portal posts Approved without text) |
| 3 replies 14:44–14:58 | "login page not recognised" for 14 min | the portal did not show its sign-in form (portal side); the bridge did not say what it showed | the error now carries the page title, address and first words, and says when the portal reports maintenance |

Also: a warning when a reply names another ticket number (CHR-000917's letter named CHR-000908); one admin alert per failed
reply; the daily check has a **Health** section (kinds of errors of 24 h, NEW ones marked, double letters, emails not sent,
Info Desk counts); a **new kind of error** is emailed at once (once per kind); admin action `health_report` (read only).
Regression checks: `node tests/regressions.mjs` (23 checks, no network, synthetic texts).

## Member card no., contract dates, starting day, Till renewal date (28 Nov 2026)
* Why: one ticket got the sender's office phone (from the email signature) as the member card, because the old rule skipped a
  number written after "-" (subject "XX-COMPANY-NAME-<card>") and took the first 8-digit number of the email. 33 tickets had a
  phone, policy or contract number as the card; 9 sent replies quoted it.
* Now every 8-digit number of the subject, the email text, attachment names, the form (AI reader) and the Portal field is a
  candidate with a score: where it is, the words before it (card / member / CN# up; policy / contract / "Approval No." down;
  Tel / Fax / +20 = dropped), dates and amounts dropped, the GlobeMed files (known member up; contract and policy numbers never a
  card), numbers the team corrected away for that sender dropped. Starting with 5 is a small bonus, never a rule.
* Ticket > Patient info: the card, its status (Verified / Needs review / Not found / Mismatch) and why, the other candidates,
  "Confirm member ID" (who and when are saved) and the history of every change. A ticket is always created; only a validation
  and Approved / Partially approved / Rejected (email and Portal) wait for a verified or confirmed card. Pending is always allowed.
* The system corrects only a card IT set, on tickets created from 28 Nov, when the form gives a high-confidence number. Older
  tickets are never changed automatically (the review list is kept outside the repository and approved by the team first).
* Contracts (table contract_info): effective / expiry dates and policy number from the GlobeMed monthly files (sent by
  Sync-ChronicHistory.ps1, newest line wins) and the standard starting day of each contract (the day most of its members start
  on). Starting day used: set by the team for the contract › for the holder › the contract's own day › the holder's day.
* Chronic validation: "Starting day must be 01" when the start is another day (warning + suggested date, never a block) and
  "Till renewal date": the end date becomes the contract expiry (GlobeMed files, else i-CARE); unknown = the person enters it.
  The decision email then says "until <date> (the contract renewal date)".

## i-CARE reader and the first-monthly-treatment rule (28 Nov 2026)
* i-CARE reader (tools/portal-bridge/icare-bridge.mjs, task ChronicIcareReader): read-only, its own Chrome profile next to the
  portal bridge. Signs in (account from Set-IcareCredential.ps1, DPAPI), types the card in Patient Information and presses its
  search button, then reads Administrative Info (all labels, dependants, exclusions, notes), the Notice of Insurance Coverage
  (class of cover) and the coverage report PDF from the GlobeMed report server (policy dates, eligibility, class, restrictions,
  disease conditions and the limits table read by position: level, description, pool, limit, used, balance, per transaction).
  The report link is short-lived and reflects the last search: it is asked for right after the search and must name the same
  beneficiary, else it is retried once and the ticket says "Not available – reason".
* Jobs: the app queues open tickets with a verified / confirmed card (icare_queue), again after 24 h or with "Read from i-CARE".
  The server writes the result on the ticket once (icare.check via bridge, plus name / mobile like the manual check), refuses a
  result for another member, and has a kill switch (portal_state icare_config.off). One member at a time, 10 s apart.
* Health: ok / login_failed / no_account / layout_changed / unreachable in portal_state icare_health, the daily Health section
  and one admin email per 6 h for a problem that needs a person. No member data in the reader's log or the queue.
* i-CARE allows ONE session per account: the reader needs its own read-only user, or it signs out whoever uses the same account.
* Starting day: contract set by the team › holder set by the team › the contract's own members (one is enough) › the holder's
  earlier contracts › none = first monthly treatment → day 01. Start = the current cycle (latest standard day on or before the
  requested start), never before the contract start or the member's eligibility (then the next one), with warnings for the last
  month before expiry and unknown dates. "Till renewal date" is ticked for the first one when the expiry is known. Another day
  can be kept with a note; contract day changes are kept with who / when / why; the decision email names the starting day.
