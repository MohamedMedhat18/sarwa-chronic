# Portal bridge (no IT) – setup on the Outlook bridge PC

The Sarwa portal is reachable only from inside the Sarwa network (tested 21 Nov 2026: requests from Supabase time out,
the same page opens in under a second from a Sarwa PC). So the link runs on the **Outlook bridge PC**, like the mail bridge:

```
Chrome on the Outlook PC (signed in to the portal)  <--  bridge.mjs  -->  Supabase "portal" function  -->  Sarwa Chronic
  reads Chronic Attach + Request Timeline                 bridge_ingest / bridge_peek / bridge_jobs / bridge_job_result
  fills Reply, then re-reads the Timeline                 bridge_reconcile / bridge_health / bridge_config (kill switch)
```

## Live status (21 Nov 2026)

- Live Sarwa Chronic (Supabase `dqjkmhorcusaynbmjcxx`): portal tables, `portal` function and Settings > Portal =
  **browser** mode are deployed. Until the bridge PC runs, replies queued in Sarwa Chronic wait in "Waiting for portal".
- **Portal history**: every Chronic Attach request (all statuses) was imported once into `portal_history` (searchable in
  Portal > History and on each ticket's member panel). Open requests (Pending, Partially Approved Pending, Reopened,
  Assigned, Processing) were imported as tickets with their timeline and broker files. The bridge keeps both current: every request it reads on the
  report is upserted into `portal_history`, and a confirmed reply updates that request's status there too.
- The token used for that one-time import is replaced the moment an admin presses **New bridge token** (step 3 below).

## One-time setup (you do these; nothing here needs IT)

1. Install **Node.js LTS** and make sure **Google Chrome** is installed (the bridge uses your installed Chrome).
2. In this folder: `npm install` (Playwright library only; it does not download a browser because it uses Chrome).
3. In Sarwa Chronic: Settings > Portal > **New bridge token** (admin). Copy the `chp_…` token once.
4. `.\Set-PortalCredential.ps1` – type the portal account and the token. They are stored encrypted (Windows DPAPI) in
   `%LOCALAPPDATA%\ChronicPortalBridge`, readable only by this Windows user. Nothing goes to the repository or Supabase.
5. Settings > Portal > Connection = **Portal screens via the Outlook bridge PC**.
6. First run, read-only: `.\Start-PortalBridge.ps1 -SupabaseUrl https://<project>.supabase.co -Once`
   It signs in, reads the report, creates the tickets, reconciles, reports health. **Dry run: nothing is submitted.**
7. Optional: `.\Install-PortalBridgeTask.ps1 -SupabaseUrl …` to start it at sign-in (still dry run).

## Before the first live write (required, in this order)

1. **A test request** on the portal (or one live request you choose).
2. **Calibrate the Reply form** on that request: open Actions > Reply, record the real field ids into
   `%LOCALAPPDATA%\ChronicPortalBridge\reply-map.json` (template: `reply-map.example.json`). Without this file the bridge
   never submits anything.
3. Send the decision from Sarwa Chronic. The bridge writes a **preview** to `previews\<job>.json` (what it would fill,
   which files, which status) and leaves the job queued.
4. You approve the preview, then: `.\Start-PortalBridge.ps1 -SupabaseUrl … -Once -LiveWriteAllow <request id>`.
   Only that request can be written. The ticket closes / goes Pending only after the bridge sees the new entry in the
   Request Timeline.

## Safety built in

| Rule | How |
|---|---|
| No live write without approval | Needs reply-map.json **and** `DRY_RUN=0` **and** the request id in `LIVE_WRITE_ALLOW`. Otherwise preview only (`bridge_peek` does not claim the job). |
| Never "replied" without confirmation | After submit the Request Timeline is re-read; only a new matching entry counts. |
| Never sent twice | Before every submit the Timeline is checked for our reply from an earlier attempt. |
| Someone else changed it | Current status re-read before submit; a final status set by someone else = conflict, not overwritten. |
| Our own replies are not "staff changes" | Each confirmed entry id is kept in `submitted.json` and sent to Sarwa Chronic. |
| Kill switch | Settings > Portal = Off -> `bridge_config.active=false` -> the bridge idles. |
| Login problems | Captcha / second factor / failed sign-in -> stop, health alert to admins, no retry loop. |
| Page changed | Expected report columns missing -> health alert "page structure changed", nothing written. |
| Session | Never opens a portal URL directly (APEX signs the user out for links without the session); navigates by clicking, re-signs in if the session expired. |
| Rate | One request at a time, 1.5–3.5 s between portal actions, 4–7 s between submits. |
| Secrets | DPAPI on this PC only; passed to the bridge process as environment variables and removed when it ends; never logged. |

## Verified on the live page (read-only, 21 Nov 2026)

- Report layout: hidden repeated headers per Individual Number group – cells are mapped by their `headers` attribute.
  Reader result: 9/9 requests, all 15 columns, matches the report counter "1 - 9".
- Dates are `dd/mm/yyyy hh:mi` (Cairo time) – converted to ISO.
- Starting Day found for 9/9 open requests from the Policy-holder data.

## Calibrated on TEST request 38218 (21 Nov 2026, read only – nothing saved)

- Actions drawer = page 173. **Reply = page 168 "Chronis Status"**: `P168_STATUS` (required: 3 Pending, 5 Approved,
  6 Partially Approved Pending, 7 Partially Approved Rejected, 8 Rejected), `P168_LANGUAGE` (AR/EN, default EN),
  `P168_COMMENT`, an upload box (multiple files), buttons **Save** / Cancel. No separate "reason" field.
- **The portal writes its own message**: choosing Language then Status fills `P168_COMMENT` with a template that has a
  `#comment#` slot (Approved has none). The bridge keeps the template and puts the agent's text in the slot. The
  templates are copied into the app so the agent sees an exact preview before sending.
- **Broker Attachments = page 170**: the member's WhatsApp / broker files, each with a download link and a stable file id
  (`k1`). **Sarwa Attachments = page 166**: read-only list; our files arrive there through the Reply upload box.
- Opening Reply, Broker Attachment and Sarwa Attachment changed nothing (status, assignee, timeline unchanged) – only
  Save writes. So the bridge reads attachments on every new request.
- Mapping file: `reply-map.json` (in this folder; a copy in `%LOCALAPPDATA%\ChronicPortalBridge` overrides it).

## First approved write – TEST request 38218 (21 Nov 2026)

Done with the bridge's own steps (Language AR → Status 3 → portal template → our text in `#comment#` → test PNG → Save):

| Check | Result |
|---|---|
| Form before Save matched the approved preview | yes – word for word, 1 file in the upload box, no error |
| Save | form closed, no error; the portal opened the Request Timeline by itself |
| Request Timeline | 1 → 2 entries; the new one carries our exact text (line breaks shown as spaces) |
| Status / assignee | still Pending, unassigned (as intended for a test) |
| Sarwa Attachment | `sarwa-chronic-test.png`, uploaded by the portal account |
| Bridge confirmation rule | finds the new entry → would report `sent` |

Finding: the timeline's **Creation User is always the requester's number**, also on staff replies. The bridge therefore
tells staff replies apart by the portal template text, and its own replies by the ids it keeps in `state.json`.
Checked on the real data: our reply = ours, the member's entry = requester, no false "customer response".

**Delivery (confirmed by the requester):** the portal sent the reply on WhatsApp to the request's **Creation User**
(01069146905 – the number that opened the request in the bot), at 2:52 PM, **with the attached file**. So every file an
agent attaches to a portal reply reaches the member. The bridge reports `delivered.to` = Creation User.
