<#
  End-to-end test of the portal sync against the MOCK portal – TEST requests only (900001…900004), never live data.
  Run it against a test project (or production while Settings › Portal is in mock mode and no live connection exists).

    .\tests\portal-e2e.ps1 -Project <project-ref> -Token chp_...

  The token comes from the "portal" function (admin: action new_token) and is never stored in the repository.
#>
param(
  [Parameter(Mandatory)] [string] $Project,
  [Parameter(Mandatory)] [string] $Token
)
$ErrorActionPreference = 'Stop'
$base = "https://$Project.supabase.co/functions/v1"
$H = @{ 'x-portal-token' = $Token }
$results = [System.Collections.Generic.List[object]]::new()

function Call($fn, $body) {
  $json = $body | ConvertTo-Json -Depth 20 -Compress
  try { return Invoke-RestMethod -Method Post -Uri "$base/$fn" -Headers $H -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 120 }
  catch { $m = $_.ErrorDetails.Message; if (-not $m) { $m = $_.Exception.Message }; return [pscustomobject]@{ error = $m } }
}
function Portal($body) { Call 'portal' $body }
function Mock($path, $body) { Call "portal-mock/_test/$path" $body }
function Check($name, [bool]$ok, $detail = '') { $results.Add([pscustomobject]@{ Test = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = "$detail" }); Write-Host ("{0}  {1}  {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail) }
function State($id) { Mock 'state' @{ request_id = $id } }
function Evs($st, $type) { @($st.events | Where-Object { $_.type -eq $type }) }

# tiny test files (1x1 PNG, minimal PDF)
$png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
$pdf = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("%PDF-1.4`n1 0 obj<<>>endobj`ntrailer<<>>`n%%EOF"))
$now = (Get-Date).ToUniversalTime().ToString('o')

# 0) mock mode, fast retries, cursor reset
$r = Portal @{ action = 'set_config'; mode = 'mock'; fastRetry = $true; intervalMin = 1; alertTo = 'portal-alerts@example.invalid' }
Check 'T00 mock mode on' ($r.mode -eq 'mock') ($r.error)
Portal @{ action = 'reset_cursor'; since = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('o') } | Out-Null

# 1) seed test requests
$seed = Mock 'seed' @{ requests = @(
  @{ request_id = '900001'; individual_number = '59000001'; individual_name = 'TEST MEMBER ONE'; mobile = '201000000001'; creation_user = '201000000001'; channel = 'WhatsApp'; contract_no = '50049991'; policy_holder = 'TEST HOLDER A'; status_code = 3; chronic_date = $now.Substring(0,10); creation_date = $now; request_type = 'New'; notes = 'TEST – monthly medication'; item_codes = @(@{ code = 'T-001'; name = 'TESTMED 10 MG'; dose = '1x1' });
     files = @(@{ id = 'f-900001-1'; file_name = 'prescription.png'; mime_type = 'image/png'; content_b64 = $png; source = 'WhatsApp' }, @{ id = 'f-900001-2'; file_name = 'lab.pdf'; mime_type = 'application/pdf'; content_b64 = $pdf; source = 'WhatsApp' }) },
  @{ request_id = '900002'; individual_number = '59000002'; individual_name = 'TEST MEMBER TWO'; mobile = '201000000002'; creation_user = 'broker.test@example.invalid'; channel = 'Broker'; broker = 'TEST BROKER'; broker_mail = 'broker.test@example.invalid'; cc = @('cc1.test@example.invalid', 'cc2.test@example.invalid'); policy_holder = 'TEST HOLDER B'; status_code = 3; creation_date = $now; files = @() },
  @{ request_id = '900003'; individual_number = '59000003'; individual_name = 'TEST MEMBER THREE'; mobile = '201000000003'; channel = 'WhatsApp'; policy_holder = 'TEST HOLDER A'; status_code = 5; creation_date = $now; files = @() },
  @{ request_id = '900004'; individual_number = '59000004'; individual_name = 'TEST MEMBER FOUR'; mobile = '201000000004'; channel = 'WhatsApp'; policy_holder = 'TEST HOLDER A'; status_code = 3; creation_date = $now; files = @() }
) }
Check 'T01 seed 4 test requests' (@($seed.seeded).Count -eq 4) ($seed.error)

# 2) import: 3 open requests -> 3 tickets, the already-approved one is skipped
$s1 = Portal @{ action = 'sync_now' }
Check 'T02 import creates tickets for open requests' ($s1.in.created -eq 3) ("created=$($s1.in.created) skipped=$($s1.in.skipped) errors=$(@($s1.in.errors) -join ';') $($s1.error)")
Check 'T03 already-decided request not imported' ($s1.in.skipped -ge 1) "skipped=$($s1.in.skipped)"
$st1 = State '900001'; $t1 = $st1.link.ticket
$create = (Evs $st1 'ticket.create')[0]; $init = (Evs $st1 'msg.in')[0]
Check 'T04 ticket fields mapped' ($create.d.source -eq 'portal' -and $create.d.portal.requestId -eq '900001' -and $create.d.member -eq '59000001' -and $create.d.portal.policyHolder -eq 'TEST HOLDER A' -and $create.d.mobile -eq '01000000001' -and $create.d.tags -contains 'whatsapp') "$t1 holder=$($create.d.portal.policyHolder) startDay=$($create.d.portal.startDay) ($($create.d.portal.startDaySrc))"
Check 'T05 attachments copied into the ticket' (@($init.d.atts).Count -eq 2 -and -not (@($init.d.atts) | Where-Object { -not $_.path })) ((@($init.d.atts) | ForEach-Object { "$($_.name) [$($_.cls)]" }) -join ', ')
$st2 = State '900002'; $c2 = (Evs $st2 'ticket.create')[0]
Check 'T06 broker request keeps broker + CC' ($c2.d.portal.brokerMail -eq 'broker.test@example.invalid' -and @($c2.d.portal.cc).Count -eq 2) ($c2.d.portal.cc -join '; ')

# 3) duplicate import: running again creates nothing new
$s2 = Portal @{ action = 'sync_now' }
$st1b = State '900001'
Check 'T07 re-run is idempotent (no duplicate ticket)' ($s2.in.created -eq 0 -and @(Evs $st1b 'ticket.create').Count -eq 1) "created=$($s2.in.created) same=$($s2.in.same)"

# 4) Pending – need documents, with a screenshot -> posted to the portal, ticket Pending after confirmation
$d1 = Mock 'decide' @{ ticket = $t1; decision = 'Pending'; text = 'TEST: please send HbA1c'; reason = 'Missing documents'; missing = @('HbA1c (<= 6 months)'); files = @(@{ name = 'screenshot.png'; mime = 'image/png'; content_b64 = $png });
  ticketUpdate = @{ status = 'Pending'; pendingReason = 'Missing documents'; decision = 'Pending' } }
$p1 = Portal @{ action = 'push' }
$st = State '900001'; $job = @($st.jobs | Where-Object id -eq $d1.id)[0]
$tl = @($st.request.timeline)[-1]
Check 'T08 Pending posted to the portal' ($job.status -eq 'sent' -and $st.request.status_code -eq 3) "job=$($job.status) portal=$($st.request.status_name) $($p1.error)"
Check 'T09 portal timeline entry from the helpdesk' ($tl.actor_type -eq 'integration' -and $tl.extra_comment -match 'HbA1c') "$($tl.by) | $($tl.extra_comment)"
Check 'T10 screenshot reached the portal' (@($st.request.attachments | Where-Object { $_.source -eq 'Sarwa' }).Count -eq 1)
$upd = @(Evs $st 'update' | Where-Object { $_.d.status -eq 'Pending' })
Check 'T11 ticket set Pending only after confirmation' ($upd.Count -eq 1 -and $upd[0].ts -gt (@(Evs $st 'portal.status' | Where-Object { $_.d.status -eq 'sent' })[0].ts)) "by=$($upd[0].actor)"

# 5) the member answers on WhatsApp with the document -> ticket gets the answer (reopens with customer_response in the app)
Mock 'reply' @{ request_id = '900001'; comment = 'TEST: here is my HbA1c'; file = @{ file_name = 'hba1c.pdf'; mime_type = 'application/pdf'; content_b64 = $pdf } } | Out-Null
$s3 = Portal @{ action = 'sync_now' }
$st = State '900001'; $ans = @(Evs $st 'msg.in' | Where-Object { -not $_.d.initial })
Check 'T12 customer response imported (message + file)' ($ans.Count -eq 1 -and @($ans[0].d.atts).Count -eq 1 -and $ans[0].d.text -match 'HbA1c') "updated=$($s3.in.updated)"
Check 'T13 no echo of our own decision as a customer answer' (@(Evs $st 'msg.in').Count -eq 2)

# 6) portal down: 503 x5 -> retries, then failed, admin alerted; Try again -> sent
Mock 'fault' @{ path_like = '%/decision'; http = 503; remaining = 5 } | Out-Null
$d2 = Mock 'decide' @{ ticket = $t1; decision = 'Approved'; text = 'TEST: approved'; ticketUpdate = @{ decision = 'Approved'; status = 'Closed' } }
for ($i = 0; $i -lt 8; $i++) { Portal @{ action = 'push' } | Out-Null; $st = State '900001'; $job = @($st.jobs | Where-Object id -eq $d2.id)[0]; if ($job.status -in 'dead', 'sent') { break }; Start-Sleep -Seconds ([math]::Min(17, [math]::Pow(2, $i))) }
$retr = @(Evs $st 'portal.status' | Where-Object { $_.d.jobId -eq $d2.id -and $_.d.status -eq 'retrying' })
Check 'T14 retries with back-off' ($retr.Count -eq 4) "retrying events=$($retr.Count) attempts=$($job.attempts)"
Check 'T15 after 5 tries: failed, ticket NOT closed' ($job.status -eq 'dead' -and -not (Evs $st 'update' | Where-Object { $_.d.status -eq 'Closed' })) "job=$($job.status) http=$($job.http_code)"
Check 'T16 admin alert email queued' (@($st.alerts | Where-Object { $_.subject -match 'Portal sync failed' }).Count -ge 1)
$rt = Portal @{ action = 'retry'; id = $d2.id }
$st = State '900001'; $job = @($st.jobs | Where-Object id -eq $d2.id)[0]
Check 'T17 Try again -> sent, ticket closed, portal Approved' ($job.status -eq 'sent' -and $st.request.status_code -eq 5 -and (Evs $st 'update' | Where-Object { $_.d.status -eq 'Closed' })) "job=$($job.status) portal=$($st.request.status_name) $($rt.error)"

# 7) decided directly on the portal while the ticket is open -> flagged on the ticket; a later decision is refused (409)
Mock 'direct' @{ request_id = '900002'; status_code = 5; by = 'portal.user.test' } | Out-Null
Portal @{ action = 'sync_now' } | Out-Null
$st = State '900002'; $pu = @(Evs $st 'portal.update')
Check 'T18 direct portal change flagged' ($pu.Count -eq 1 -and $pu[0].d.direct -and @(Evs $st 'note').Count -eq 1) "by=$($pu[0].d.by)"
$t2 = $st.link.ticket
$d3 = Mock 'decide' @{ ticket = $t2; decision = 'Rejected'; text = 'TEST'; reason = 'Not covered'; ticketUpdate = @{ decision = 'Rejected'; status = 'Closed' } }
Portal @{ action = 'push' } | Out-Null
$st = State '900002'; $job = @($st.jobs | Where-Object id -eq $d3.id)[0]
Check 'T19 conflict (409) is not retried and does not close the ticket' ($job.status -eq 'conflict' -and $job.http_code -eq 409 -and -not (Evs $st 'update' | Where-Object { $_.d.status -eq 'Closed' })) "job=$($job.status)"

# 8) the portal refuses a bad decision (reject without reason) -> error, no retry
$st4 = State '900004'
$d4 = Mock 'decide' @{ ticket = $st4.link.ticket; decision = 'Rejected'; text = 'TEST'; reason = '' }
Portal @{ action = 'push' } | Out-Null
$st4 = State '900004'; $job = @($st4.jobs | Where-Object id -eq $d4.id)[0]
Check 'T20 validation error (422) shown, not retried' ($job.status -eq 'error' -and $job.http_code -eq 422 -and $job.attempts -eq 1) "job=$($job.status) http=$($job.http_code)"

# 9) one decision in flight per ticket
$d5 = Mock 'decide' @{ ticket = $st4.link.ticket; decision = 'Message'; text = 'TEST 1' }
$d6 = Mock 'decide' @{ ticket = $st4.link.ticket; decision = 'Message'; text = 'TEST 2' }
Check 'T21 second decision while one is in flight is refused' ($d5.id -and $d6.error) "$($d6.error)"
Portal @{ action = 'push' } | Out-Null

# 10) audit log
$lg = Portal @{ action = 'log'; limit = 200 }
$acts = @($lg.rows | ForEach-Object action | Sort-Object -Unique)
Check 'T22 sync log has both directions with results' ((@($lg.rows | Where-Object direction -eq 'in').Count -gt 0) -and (@($lg.rows | Where-Object direction -eq 'out').Count -gt 0) -and (@($lg.rows | Where-Object { -not $_.ok }).Count -gt 0)) ($acts -join ', ')

$fail = @($results | Where-Object Result -eq 'FAIL').Count
Write-Host ''; Write-Host ("{0} passed, {1} failed" -f ($results.Count - $fail), $fail)
$results | Format-Table -AutoSize | Out-String -Width 220
