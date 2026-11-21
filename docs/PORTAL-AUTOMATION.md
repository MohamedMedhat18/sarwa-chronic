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

## 5. Done only after confirmation

A decision or message is "sent" only when the bridge sees the new entry in the portal's Request Timeline. Failures are
retried (1, 2, 4, 8, 16 min); then the job goes to "Portal - Sync failed" and an admin alert email is queued. A request
changed on the portal by someone else is never overwritten ("Changed on the portal").
