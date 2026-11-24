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
