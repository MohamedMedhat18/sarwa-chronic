<#
  End-to-end test of the NO-IT browser-bridge path (Settings > Portal = browser).
  The script plays the role of the Outlook bridge PC: it INGESTS scraped portal requests, PULLS queued decisions,
  simulates carrying them out in the browser and CONFIRMING from the Request Timeline, reconciles and reports health.
  Supabase never touches a real portal here. TEST requests only (900001-900004, 999999).

    .\tests\portal-browser-e2e.ps1 -Project <project-ref> -Token chp_...
#>
param([Parameter(Mandatory)] [string] $Project, [Parameter(Mandatory)] [string] $Token)
$ErrorActionPreference = 'Stop'
$base = "https://$Project.supabase.co/functions/v1"
$H = @{ 'x-portal-token' = $Token }
$results = [System.Collections.Generic.List[object]]::new()
function Call($fn, $body) {
  $json = $body | ConvertTo-Json -Depth 20 -Compress
  try { return Invoke-RestMethod -Method Post -Uri "$base/$fn" -Headers $H -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 120 }
  catch { $m = $_.ErrorDetails.Message; if (-not $m) { $m = $_.Exception.Message }; return [pscustomobject]@{ error = $m } }
}
function Portal($b) { Call 'portal' $b }                       # the server function (bridge endpoints + admin)
function Bridge($b) { Call 'portal' $b }                       # bridge endpoints are on the same function (token-auth)
function Mock($p, $b) { Call "portal-mock/_test/$p" $b }        # test driver (acts as the agent / reads state)
function Check($name, [bool]$ok, $detail = '') { $results.Add([pscustomobject]@{ Test = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = "$detail" }); Write-Host ("{0}  {1}  {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail) }
function State($id) { Mock 'state' @{ request_id = $id } }
function Evs($st, $type) { @($st.events | Where-Object { $_.type -eq $type }) }
function TicketOf($id) { (State $id).link.ticket }

$png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
$pdf = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("%PDF-1.4`n1 0 obj<<>>endobj`ntrailer<<>>`n%%EOF"))
$now = (Get-Date).ToUniversalTime().ToString('o')

# 0) browser mode on, with fast retries for the test
$r = Portal @{ action = 'set_config'; mode = 'browser'; fastRetry = $true; intervalMin = 1; alertTo = 'portal-alerts@example.invalid' }
Check 'B00 browser mode on' ($r.mode -eq 'browser' -and $r.baseUrl -match 'Outlook bridge') ($r.error)
# in browser mode the server must NOT reach out
$t0 = Portal @{ action = 'tick' }
Check 'B01 server tick does nothing in browser mode' ($t0.browser -eq $true -and -not $t0.out) ($t0.error)

# 1) the bridge scraped the portal and ingests requests (3 open + 1 already approved)
$ing = Bridge @{ action = 'bridge_ingest'; requests = @(
  @{ request_id = '900001'; individual_number = '59000001'; individual_name = 'TEST MEMBER ONE'; mobile = '201000000001'; creation_user = '201000000001'; channel = 'WhatsApp'; contract_no = '50049991'; policy_holder = 'TEST HOLDER A'; status_code = 3; status_name = 'Pending'; creation_date = $now; last_update = $now; request_type = 'New'; notes = 'TEST'; item_codes = @(@{ code = 'T-001'; name = 'TESTMED 10 MG'; dose = '1x1' });
     timeline = @(@{ id = 'tl-900001-1'; status_code = 3; status_name = 'Pending'; comment = 'TEST request'; by = '201000000001'; actor_type = 'requester'; source = 'whatsapp'; at = $now });
     attachments = @(@{ id = 'a1'; file_name = 'prescription.png'; mime_type = 'image/png'; source = 'WhatsApp'; content_base64 = $png }, @{ id = 'a2'; file_name = 'lab.pdf'; mime_type = 'application/pdf'; source = 'WhatsApp'; content_base64 = $pdf }) },
  @{ request_id = '900002'; individual_number = '59000002'; individual_name = 'TEST MEMBER TWO'; channel = 'Broker'; broker = 'TEST BROKER'; broker_mail = 'broker.test@example.invalid'; cc = @('cc1.test@example.invalid','cc2.test@example.invalid'); policy_holder = 'TEST HOLDER B'; status_code = 3; status_name = 'Pending'; creation_date = $now; last_update = $now; timeline = @(@{ id = 'tl-900002-1'; status_code = 3; actor_type = 'requester'; source = 'broker'; by = 'broker.test@example.invalid'; at = $now }); attachments = @() },
  @{ request_id = '900003'; individual_number = '59000003'; individual_name = 'TEST MEMBER THREE'; channel = 'WhatsApp'; policy_holder = 'TEST HOLDER A'; status_code = 5; status_name = 'Approved'; creation_date = $now; last_update = $now; timeline = @(); attachments = @() },
  @{ request_id = '900004'; individual_number = '59000004'; individual_name = 'TEST MEMBER FOUR'; mobile = '201000000004'; creation_user = '201000000004'; channel = 'WhatsApp'; policy_holder = 'TEST HOLDER A'; status_code = 3; status_name = 'Pending'; creation_date = $now; last_update = $now; timeline = @(@{ id = 'tl-900004-1'; status_code = 3; actor_type = 'requester'; source = 'whatsapp'; by = '201000000004'; at = $now }); attachments = @() }
) }
Check 'B02 ingest creates tickets for open requests' ($ing.created -eq 3 -and $ing.skipped -eq 1) ("created=$($ing.created) skipped=$($ing.skipped) same=$($ing.same) errors=$(@($ing.errors) -join ';') $($ing.error)")
$st1 = State '900001'; $t1 = $st1.link.ticket; $create = (Evs $st1 'ticket.create')[0]; $init = (Evs $st1 'msg.in')[0]
Check 'B03 fields + Starting Day (holder) mapped' ($create.d.source -eq 'portal' -and $create.d.member -eq '59000001' -and $create.d.portal.startDay -eq 5 -and $create.d.portal.startDaySrc -match 'holder') "$t1 startDay=$($create.d.portal.startDay) ($($create.d.portal.startDaySrc))"
Check 'B04 attachments downloaded by the bridge and stored' (@($init.d.atts).Count -eq 2 -and -not (@($init.d.atts) | Where-Object { -not $_.path })) ((@($init.d.atts) | ForEach-Object { "$($_.name)[$($_.cls)]" }) -join ', ')
$st2 = State '900002'; $c2 = (Evs $st2 'ticket.create')[0]
Check 'B05 Starting Day via member history + broker/CC' ($c2.d.portal.startDay -eq 12 -and $c2.d.portal.startDaySrc -match 'member history' -and @($c2.d.portal.cc).Count -eq 2) "startDay=$($c2.d.portal.startDay) ($($c2.d.portal.startDaySrc)) cc=$(@($c2.d.portal.cc).Count)"

# 2) re-ingest identical snapshot -> no change
$ing2 = Bridge @{ action = 'bridge_ingest'; requests = @(@{ request_id = '900001'; individual_number = '59000001'; individual_name = 'TEST MEMBER ONE'; mobile = '201000000001'; creation_user = '201000000001'; channel = 'WhatsApp'; contract_no = '50049991'; policy_holder = 'TEST HOLDER A'; status_code = 3; status_name = 'Pending'; creation_date = $now; last_update = $now; request_type = 'New'; notes = 'TEST'; item_codes = @(@{ code = 'T-001'; name = 'TESTMED 10 MG'; dose = '1x1' }); timeline = @(@{ id = 'tl-900001-1'; status_code = 3; status_name = 'Pending'; comment = 'TEST request'; by = '201000000001'; actor_type = 'requester'; source = 'whatsapp'; at = $now }); attachments = @(@{ id = 'a1'; file_name = 'prescription.png'; mime_type = 'image/png'; source = 'WhatsApp'; content_base64 = $png }, @{ id = 'a2'; file_name = 'lab.pdf'; mime_type = 'application/pdf'; source = 'WhatsApp'; content_base64 = $pdf }) }) }
Check 'B06 re-ingest identical is idempotent' ($ing2.created -eq 0 -and $ing2.same -eq 1 -and @(Evs (State '900001') 'ticket.create').Count -eq 1) "created=$($ing2.created) same=$($ing2.same)"

# 3) agent sends Pending; bridge pulls it, carries it out, confirms from the timeline
$d1 = Mock 'decide' @{ ticket = $t1; decision = 'Pending'; text = 'TEST: please send HbA1c'; reason = 'Missing documents'; missing = @('HbA1c (<= 6 months)'); files = @(@{ name = 'screenshot.png'; mime = 'image/png'; content_b64 = $png }); ticketUpdate = @{ status = 'Pending'; pendingReason = 'Missing documents'; decision = 'Pending' } }
$jobs = (Bridge @{ action = 'bridge_jobs'; limit = 5 }).jobs
$job = @($jobs | Where-Object id -eq $d1.id)[0]
Check 'B07 bridge pulls the decision with all it needs' ($job -and $job.decision -eq 'Pending' -and $job.message -match 'HbA1c' -and @($job.files).Count -eq 1 -and $job.files[0].url -match 'http') "files=$(@($job.files).Count) base=$($job.base_last_update)"
$conf = Bridge @{ action = 'bridge_job_result'; id = $d1.id; result = 'sent'; portal = @{ status_code = 3; status_name = 'Pending'; timeline_id = 'tl-conf1'; last_update = (Get-Date).ToUniversalTime().ToString('o'); delivered = @{ channel = 'whatsapp'; to = '201000000001' } } }
$st = State '900001'; $pj = @($st.jobs | Where-Object id -eq $d1.id)[0]
Check 'B08 confirmed -> ticket Pending only now' ($conf.status -eq 'sent' -and $pj.status -eq 'sent' -and @(Evs $st 'update' | Where-Object { $_.d.status -eq 'Pending' }).Count -eq 1 -and $st.link.status_name -eq 'Pending') "job=$($pj.status) link=$($st.link.status_name)"

# 4) the member answers (bridge ingests the updated request) -> reopen with customer_response
$later = (Get-Date).ToUniversalTime().AddMinutes(1).ToString('o')
$ing3 = Bridge @{ action = 'bridge_ingest'; requests = @(@{ request_id = '900001'; individual_number = '59000001'; individual_name = 'TEST MEMBER ONE'; mobile = '201000000001'; creation_user = '201000000001'; channel = 'WhatsApp'; policy_holder = 'TEST HOLDER A'; status_code = 9; status_name = 'Reopened'; creation_date = $now; last_update = $later;
  timeline = @(@{ id = 'tl-900001-1'; status_code = 3; actor_type = 'requester'; source = 'whatsapp'; at = $now }, @{ id = 'tl-ans'; status_code = 9; status_name = 'Reopened'; comment = 'TEST: here is my HbA1c'; by = '201000000001'; actor_type = 'requester'; source = 'whatsapp'; at = $later });
  attachments = @(@{ id = 'a1'; file_name = 'prescription.png'; mime_type = 'image/png'; source = 'WhatsApp' }, @{ id = 'a2'; file_name = 'lab.pdf'; mime_type = 'application/pdf'; source = 'WhatsApp' }, @{ id = 'ans1'; file_name = 'hba1c.pdf'; mime_type = 'application/pdf'; source = 'WhatsApp'; content_base64 = $pdf }) }) }
$st = State '900001'; $ans = @(Evs $st 'msg.in' | Where-Object { -not $_.d.initial })
Check 'B09 customer response imported (file + message)' ($ing3.updated -eq 1 -and $ans.Count -eq 1 -and @($ans[0].d.atts).Count -eq 1 -and $ans[0].d.text -match 'HbA1c') "updated=$($ing3.updated) atts=$(@($ans[0].d.atts).Count)"

# 5) conflict: bridge finds the request changed on the portal -> not closed
$d2 = Mock 'decide' @{ ticket = (TicketOf '900002'); decision = 'Rejected'; text = 'TEST'; reason = 'Not covered'; ticketUpdate = @{ decision = 'Rejected'; status = 'Closed' } }
Bridge @{ action = 'bridge_jobs'; limit = 5 } | Out-Null
$c = Bridge @{ action = 'bridge_job_result'; id = $d2.id; result = 'conflict'; error = 'request changed on the portal (status 5)' }
$st = State '900002'; $pj = @($st.jobs | Where-Object id -eq $d2.id)[0]
Check 'B10 conflict -> not retried, ticket not closed' ($c.status -eq 'conflict' -and $pj.status -eq 'conflict' -and -not (Evs $st 'update' | Where-Object { $_.d.status -eq 'Closed' })) "job=$($pj.status)"

# 6) transient failure then success (fast retry)
$d3 = Mock 'decide' @{ ticket = (TicketOf '900004'); decision = 'Approved'; text = 'TEST approved'; ticketUpdate = @{ decision = 'Approved'; status = 'Closed' } }
Bridge @{ action = 'bridge_jobs'; limit = 5 } | Out-Null
$rr = Bridge @{ action = 'bridge_job_result'; id = $d3.id; result = 'retry'; http = 503; error = 'portal not reachable' }
$st = State '900004'; $pj = @($st.jobs | Where-Object id -eq $d3.id)[0]
Check 'B11 transient failure requeues (retry)' ($rr.status -eq 'retrying' -and $pj.status -eq 'queued' -and @(Evs $st 'portal.status' | Where-Object { $_.d.status -eq 'retrying' }).Count -ge 1) "job=$($pj.status) attempts=$($pj.attempts)"
Start-Sleep -Seconds 3
$jobs2 = (Bridge @{ action = 'bridge_jobs'; limit = 5 }).jobs
$again = @($jobs2 | Where-Object id -eq $d3.id)[0]
$ok3 = Bridge @{ action = 'bridge_job_result'; id = $d3.id; result = 'sent'; portal = @{ status_code = 5; status_name = 'Approved'; timeline_id = 'tl-ok3'; last_update = (Get-Date).ToUniversalTime().ToString('o'); delivered = @{ channel = 'whatsapp'; to = '201000000004' } } }
$st = State '900004'; $pj = @($st.jobs | Where-Object id -eq $d3.id)[0]
Check 'B12 retried job reclaimed and confirmed -> closed' ($again -and $again.attempt -ge 2 -and $pj.status -eq 'sent' -and (Evs $st 'update' | Where-Object { $_.d.status -eq 'Closed' }) -and $st.link.status_name -eq 'Approved') "attempt=$($again.attempt) job=$($pj.status) link=$($st.link.status_name)"

# 7) terminal failure -> sync failed + admin alert
$d4 = Mock 'decide' @{ ticket = (TicketOf '900001'); decision = 'Rejected'; text = 'TEST reject'; reason = 'Not covered'; ticketUpdate = @{ decision = 'Rejected'; status = 'Closed' } }
Bridge @{ action = 'bridge_jobs'; limit = 5 } | Out-Null
$er = Bridge @{ action = 'bridge_job_result'; id = $d4.id; result = 'error'; http = 500; error = 'the portal showed an unexpected error page' }
$st = State '900001'; $pj = @($st.jobs | Where-Object id -eq $d4.id)[0]
Check 'B13 terminal failure -> error + ticket not closed + admin alert' ($er.status -eq 'error' -and $pj.status -eq 'error' -and -not (Evs $st 'update' | Where-Object { $_.d.status -eq 'Closed' }) -and @($st.alerts | Where-Object { $_.subject -match 'Portal sync failed' }).Count -ge 1) "job=$($pj.status) alerts=$(@($st.alerts).Count)"

# 8) one decision in flight per ticket
$a = Mock 'decide' @{ ticket = (TicketOf '900002'); decision = 'Message'; text = 'TEST 1' }
$b = Mock 'decide' @{ ticket = (TicketOf '900002'); decision = 'Message'; text = 'TEST 2' }
Check 'B14 one decision in flight per ticket' ($a.id -and $b.error) "$($b.error)"
Bridge @{ action = 'bridge_jobs'; limit = 5 } | Out-Null
Bridge @{ action = 'bridge_job_result'; id = $a.id; result = 'sent'; portal = @{ status_code = 3; status_name = 'Pending'; timeline_id = 'tl-m'; last_update = (Get-Date).ToUniversalTime().ToString('o'); delivered = @{ channel = 'email'; to = 'broker.test@example.invalid' } } } | Out-Null

# 9) reconciliation: a request open on the portal but with no ticket is reported
$rec = Bridge @{ action = 'bridge_reconcile'; open_request_ids = @('900001','900002','900004','999999') }
Check 'B15 reconcile reports a portal request with no ticket' (@($rec.missing_tickets) -contains '999999' -and @($rec.missing_tickets).Count -eq 1 -and $rec.linked -eq 3) "portal_open=$($rec.portal_open) linked=$($rec.linked) missing=$(@($rec.missing_tickets) -join ',')"

# 10) health check + kill switch
$h1 = Bridge @{ action = 'bridge_health'; ok = $false; loggedIn = $false; pageOk = $false; error = 'login failed: account locked'; pc = 'OUTLOOK-PC' }
$stt = Portal @{ action = 'status' }
Check 'B16 health failure recorded + alerted' ($h1.ok -and $stt.health.ok -eq $false -and $stt.health.error -match 'login failed') "health.ok=$($stt.health.ok)"
Bridge @{ action = 'bridge_health'; ok = $true; loggedIn = $true; pageOk = $true; pc = 'OUTLOOK-PC' } | Out-Null
$cfg = Bridge @{ action = 'bridge_config' }
Check 'B17 kill switch: bridge_config reports active' ($cfg.active -eq $true -and $cfg.mode -eq 'browser') "active=$($cfg.active)"
$off = Portal @{ action = 'set_config'; mode = 'off' }
$cfg2 = Bridge @{ action = 'bridge_config' }
$jobsOff = Bridge @{ action = 'bridge_jobs'; limit = 5 }
Check 'B18 kill switch: Off stops the bridge' ($cfg2.active -eq $false -and @($jobsOff.jobs).Count -eq 0) "active=$($cfg2.active) jobs=$(@($jobsOff.jobs).Count)"
Portal @{ action = 'set_config'; mode = 'browser'; fastRetry = $true } | Out-Null

# 11) dry-run safety: peek never claims; claim-one takes only the approved job
$p1 = Mock 'decide' @{ ticket = (TicketOf '900002'); decision = 'Message'; text = 'TEST peek 1' }
Start-Sleep -Milliseconds 300
$pk = (Bridge @{ action = 'bridge_peek'; limit = 10 }).jobs
$st = State '900002'; $pj = @($st.jobs | Where-Object id -eq $p1.id)[0]
Check 'B20 peek shows the job without claiming it' (@($pk | Where-Object id -eq $p1.id).Count -eq 1 -and $pj.status -eq 'queued' -and $pj.attempts -eq 0) "status=$($pj.status) attempts=$($pj.attempts)"
$c1 = (Bridge @{ action = 'bridge_jobs'; limit = 5; id = 'pd_does_not_exist' }).jobs
$c2 = (Bridge @{ action = 'bridge_jobs'; limit = 5; id = $p1.id }).jobs
Check 'B21 claim-one takes only the named job' (@($c1).Count -eq 0 -and @($c2).Count -eq 1 -and $c2[0].id -eq $p1.id) "other=$(@($c1).Count) named=$(@($c2).Count)"
Bridge @{ action = 'bridge_job_result'; id = $p1.id; result = 'sent'; portal = @{ status_code = 3; status_name = 'Pending'; timeline_id = 'tl-p1'; last_update = (Get-Date).ToUniversalTime().ToString('o') } } | Out-Null

# 12) audit log both directions
$lg = Portal @{ action = 'log'; limit = 200 }
$acts = @($lg.rows | ForEach-Object action | Sort-Object -Unique)
Check 'B19 sync log has ingest, decisions, reconcile, health' ((@($lg.rows | Where-Object { $_.action -eq 'bridge_ingest' }).Count -gt 0) -and (@($lg.rows | Where-Object { $_.action -eq 'decision' }).Count -gt 0) -and (@($lg.rows | Where-Object { $_.action -eq 'reconcile' }).Count -gt 0) -and (@($lg.rows | Where-Object { $_.action -eq 'health' }).Count -gt 0)) ($acts -join ', ')

$fail = @($results | Where-Object Result -eq 'FAIL').Count
Write-Host ''; Write-Host ("{0} passed, {1} failed" -f ($results.Count - $fail), $fail)
$results | Format-Table -AutoSize | Out-String -Width 220
