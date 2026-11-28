<#
  Sync-ChronicHistory.ps1 - sends the GlobeMed chronic medication history to the Sarwa Chronic helpdesk.
  Reads the monthly exports in "Chronic Validations\All chronic Sarwa" (the same files the
  "Chronic Validation Dashboard" Power BI report uses), keeps one line per member + medicine
  (the most recent month wins) and uploads only what changed since the last run.
  Not uploaded: mobile numbers, dates of birth, staff codes.
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File Sync-ChronicHistory.ps1 [-Force]
#>
param(
  [string]$Folder = 'D:\SharePoint\OneDrive - Sarwa Life\Chronic Validations\All chronic Sarwa',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Home2 = Join-Path $env:LOCALAPPDATA 'ChronicIntake'
$StateFile = Join-Path $Home2 'history_state.json'
$LogFile = Join-Path $Home2 'log.txt'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Cfg = [IO.File]::ReadAllText((Join-Path $Home2 'bridge.json'), $Utf8) | ConvertFrom-Json
function Log($m) { $line = '{0:yyyy-MM-dd HH:mm:ss}  History: {1}' -f (Get-Date), $m; Add-Content -Path $LogFile -Value $line -Encoding UTF8; Write-Output $line }
function Bridge($body) {
  $r = Invoke-WebRequest -Method Post -Uri $Cfg.url -Headers @{ 'x-bridge-token' = $Cfg.token } -ContentType 'application/json; charset=utf-8' -Body $Utf8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress)) -TimeoutSec 180 -UseBasicParsing
  $ms = New-Object IO.MemoryStream; $r.RawContentStream.Position = 0; $r.RawContentStream.CopyTo($ms); $Utf8.GetString($ms.ToArray()) | ConvertFrom-Json
}
$mutex = New-Object System.Threading.Mutex($false, 'Global\ChronicHistorySync')
if (-not $mutex.WaitOne(0)) { Log 'already running - skipped'; return }
try {
  $files = @(Get-ChildItem -LiteralPath $Folder -Filter '*.xls' -File | Sort-Object LastWriteTime)
  $sig = ($files | ForEach-Object { $_.Name + ':' + $_.Length + ':' + $_.LastWriteTimeUtc.Ticks }) -join '|'
  $state = @{ sig = ''; csig = ''; hashes = @{} }
  if (Test-Path $StateFile) { $s = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json; $state.sig = $s.sig; $state.csig = "$($s.csig)"; foreach ($p in $s.hashes.PSObject.Properties) { $state.hashes[$p.Name] = $p.Value } }
  # csig: the files the contract dates were last sent from (28 Nov 2026: contract dates added - sent once even if no file changed;
  # version 2: the policy number is the "Certificate NBR" column - the "Policy Number" column holds the holder's name;
  # version 3: the starting day of each contract is counted here and sent with the dates;
  # version 4: each member's monthly treatment cost is sent too)
  $cver = '4'; $csigWant = "$cver|$sig"
  if (-not $Force -and $state.sig -eq $sig -and $state.csig -eq $csigWant) { Log 'no file changed - nothing to do'; return }

  $culture = [Globalization.CultureInfo]::InvariantCulture
  function D($s) { $s = "$s".Trim(); if (-not $s) { return $null }; try { return [datetime]::ParseExact($s, 'dd-MMM-yy', $culture).ToString('yyyy-MM-dd') } catch { return $null } }
  function N($s) { $s = "$s".Trim(); if (-not $s) { return $null }; $v = 0.0; if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, $culture, [ref]$v)) { return $v }; return $null }

  $agg = @{}   # key member|code -> hashtable row
  $con = @{}   # contract -> dates of its newest line (Effective / Expiry DATE, Policy Number, holder)
  $cmd = @{}   # contract|member -> starting day (the server is too slow to work this out from 290,000 lines)
  $since = (Get-Date).AddDays(-400).ToString('yyyy-MM-dd')
  $rowsRead = 0
  foreach ($f in $files) {
    # GlobeMed exports are Arabic Windows text (code page 1256), not UTF-8 – reading them as UTF-8 broke names such as
    # "MSMEDA – The Cabinet" and Arabic holder names. Use UTF-8 only when the file really is valid UTF-8.
    $enc = [Text.Encoding]::GetEncoding(1256)
    try { $bytes = [IO.File]::ReadAllBytes($f.FullName); if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $enc = [Text.Encoding]::UTF8 } else { [void](New-Object Text.UTF8Encoding($false, $true)).GetString($bytes); $enc = [Text.Encoding]::UTF8 } } catch { }
    $bytes = $null
    $r = New-Object IO.StreamReader($f.FullName, $enc)
    $h = $r.ReadLine(); if (-not $h) { $r.Close(); continue }
    $hdr = $h.Split("`t") | ForEach-Object { $_.Trim() }
    $ix = @{}; for ($i = 0; $i -lt $hdr.Count; $i++) { if (-not $ix.ContainsKey($hdr[$i])) { $ix[$hdr[$i]] = $i } }
    if (-not $ix.ContainsKey('Individual NBR') -or -not $ix.ContainsKey('Medicine CODE')) { $r.Close(); Log "skipped $($f.Name) (not a chronic export)"; continue }
    $g = { param($c, $n) if ($ix.ContainsKey($n) -and $ix[$n] -lt $c.Count) { $c[$ix[$n]].Trim() } else { '' } }
    while ($null -ne ($l = $r.ReadLine())) {
      $c = $l.Split("`t"); if ($c.Count -lt 30) { continue }
      $member = & $g $c 'Individual NBR'; $code = & $g $c 'Medicine CODE'
      if ($member -notmatch '^\d{4,12}$' -or -not $code) { continue }
      $rowsRead++
      $dist = D (& $g $c 'Distribution Date'); $key = "$member|$code"
      $cn = & $g $c 'Contract'
      # starting day: per contract + member the day of the month of the newest line's Start Date (lines of the last 13 months)
      if ($cn -match '^\d{4,12}$' -and $dist -and $dist -ge $since) { $sd = D (& $g $c 'Start Date'); if ($sd) { $mk = "$cn|$member"; $o = $cmd[$mk]; if (-not $o -or $dist -ge $o.d) { $cmd[$mk] = @{ d = $dist; day = [int]$sd.Substring(8, 2) } } } }
      if ($cn -match '^\d{4,12}$') { $cc = $con[$cn]; if (-not $cc -or ($dist -and (-not $cc.seen -or $dist -gt $cc.seen))) { $con[$cn] = @{ contract = $cn; policy_holder = (& $g $c 'Policy Holder Name'); policy_no = $(if ((& $g $c 'Certificate NBR') -match '^\d{6,12}$') { & $g $c 'Certificate NBR' } else { & $g $c 'Policy Number' }); effective = (D (& $g $c 'Effective DATE')); expiry = (D (& $g $c 'Expiry DATE')); seen = $dist } } }
      $cur = $agg[$key]
      if ($cur) {
        if ($dist) { if (-not $cur.first_dist -or $dist -lt $cur.first_dist) { $cur.first_dist = $dist }; [void]$cur.mset.Add($dist.Substring(0, 7)) }
        if ($dist -and $cur.last_dist -and $dist -lt $cur.last_dist) { continue }   # older line: keep the newer details
      } else { $cur = @{ first_dist = $dist; mset = New-Object 'System.Collections.Generic.HashSet[string]' }; if ($dist) { [void]$cur.mset.Add($dist.Substring(0, 7)) }; $agg[$key] = $cur }
      $dis = @(); foreach ($p in @(@('Disease1', 'Disease Description1'), @('Disease2', 'Disease Description2'), @('Disease3', 'Disease Decsription3'))) { $dc = & $g $c $p[0]; if ($dc) { $dis += [ordered]@{ code = $dc; desc = (& $g $c $p[1]) } } }
      $cur.member = $member; $cur.med_code = $code; $cur.med_desc = & $g $c 'Medicine Description'
      $cur.member_name = & $g $c 'Individual Name'; $cur.principal_id = & $g $c 'Principle ID'; $cur.policy_holder = & $g $c 'Policy Holder Name'; $cur.contract = & $g $c 'Contract'
      $cur.relation = & $g $c 'Relation'; $cur.gender = & $g $c 'Gender'; $ag = N (& $g $c 'Adherent Age'); $cur.age = $(if ($null -ne $ag) { [int]$ag } else { $null })
      $cur.diseases = $dis; $cur.status = & $g $c 'Medicine Status Description'
      $cur.qty = N (& $g $c 'Quantity'); $cur.qty_type = & $g $c 'Quantity Type'; $cur.units_needed = N (& $g $c 'Number of Unit Needed'); $cur.units_taken = N (& $g $c 'Number of Unit Taken')
      $cur.daily = N (& $g $c 'Daily'); $cur.monthly = N (& $g $c 'Monthly'); $cur.unit_price = N (& $g $c 'Unit Price')
      $cur.cov_start = D (& $g $c 'Start Date'); $cur.cov_end = D (& $g $c 'End Date'); $cur.provider = & $g $c 'Provider'
      $drc = & $g $c 'DRC Description'; if (-not $drc) { $drc = & $g $c 'DRC' }; $cur.drc = $drc; $cur.last_dist = $dist
    }
    $r.Close()
    Log ("read {0} ({1:N0} lines so far, {2:N0} member-medicines)" -f $f.Name, $rowsRead, $agg.Count)
  }

  # upload only new / changed lines
  $sha = [Security.Cryptography.SHA1]::Create(); $send = New-Object System.Collections.Generic.List[object]; $newHashes = @{}
  foreach ($k in $agg.Keys) {
    $v = $agg[$k]
    $row = [ordered]@{ member = $v.member; med_code = $v.med_code; med_desc = $v.med_desc; member_name = $v.member_name; principal_id = $v.principal_id; contract = $v.contract; policy_holder = $v.policy_holder; relation = $v.relation; gender = $v.gender; age = $v.age; diseases = @($v.diseases); status = $v.status; qty = $v.qty; qty_type = $v.qty_type; units_needed = $v.units_needed; units_taken = $v.units_taken; daily = $v.daily; monthly = $v.monthly; unit_price = $v.unit_price; cov_start = $v.cov_start; cov_end = $v.cov_end; provider = $v.provider; drc = $v.drc; first_dist = $v.first_dist; last_dist = $v.last_dist; months = $v.mset.Count }
    $js = $row | ConvertTo-Json -Depth 4 -Compress
    $hh = [Convert]::ToBase64String($sha.ComputeHash($Utf8.GetBytes($js))).Substring(0, 12)
    $newHashes[$k] = $hh
    if ($Force -or $state.hashes[$k] -ne $hh) { $send.Add($row) }
  }
  Log ("{0:N0} member-medicines, {1:N0} new or changed - uploading" -f $agg.Count, $send.Count)
  $done = 0
  for ($i = 0; $i -lt $send.Count; $i += 1000) {
    $batch = $send.GetRange($i, [Math]::Min(1000, $send.Count - $i))
    $ok = $false
    # short internet / DNS outages: retry up to 6 times over about 5 minutes before giving up
    for ($try = 1; $try -le 6 -and -not $ok; $try++) { try { $res = Bridge @{ action = 'history_upsert'; rows = @($batch) }; if ($res.error) { throw $res.error }; $ok = $true } catch { if ($try -eq 6) { throw }; Start-Sleep -Seconds (10 * $try * $try / 2 + 5) } }
    $done += $batch.Count
    if (($i / 1000) % 20 -eq 0) { Log ("uploaded {0:N0} / {1:N0}" -f $done, $send.Count) }
  }
  # contract dates (a few thousand lines): all of them each time the files change; the server keeps the newest per contract
  $csig = $state.csig
  try {
    $days = @{}; foreach ($k in $cmd.Keys) { $cn = $k.Split('|')[0]; if (-not $days[$cn]) { $days[$cn] = @{} }; $dd = $cmd[$k].day; $days[$cn][$dd] = 1 + [int]$days[$cn][$dd] }
    $cl = @($con.Values | ForEach-Object {
      $row = [ordered]@{ contract = $_.contract; policy_holder = $_.policy_holder; policy_no = $_.policy_no; effective = $_.effective; expiry = $_.expiry; seen = $_.seen }
      $dm = $days[$_.contract]
      if ($dm) { $r = @($dm.GetEnumerator() | Sort-Object { -$_.Value }, { $_.Key }); $tot = ($dm.Values | Measure-Object -Sum).Sum
        $row.start_day = [int]$r[0].Key; $row.day_share = [Math]::Round($r[0].Value / $tot, 3); $row.members = [int]$tot; if ($r.Count -gt 1) { $row.second_day = [int]$r[1].Key } }
      $row })
    $cn = 0; for ($i = 0; $i -lt $cl.Count; $i += 1000) { $res = Bridge @{ action = 'contracts_upsert'; rows = @($cl[$i..([Math]::Min($i + 999, $cl.Count - 1))]) }; if ($res.error) { throw $res.error }; $cn += [int]$res.n }
    Log ("contract dates: {0:N0} contracts, {1:N0} updated" -f $cl.Count, $cn)
    # each member's monthly treatment cost (active medicines: Monthly x Unit Price) - for the AML report's night reads and the
    # months a limit balance covers; members not sent this time (no active medicine) are removed on the server
    $today = (Get-Date).ToString('yyyy-MM-dd'); $mc = @{}
    foreach ($v in $agg.Values) {
      if (-not $v.cov_end -or $v.cov_end -lt $today) { continue }
      $m = $mc[$v.member]; if (-not $m) { $m = @{ member = $v.member; monthly_cost = 0.0; active_lines = 0; holder = $v.policy_holder; contract = $v.contract }; $mc[$v.member] = $m }
      $m.active_lines++; if ($v.monthly -and $v.unit_price) { $m.monthly_cost += [double]$v.monthly * [double]$v.unit_price }
    }
    $ml = @($mc.Values | ForEach-Object { [ordered]@{ member = $_.member; monthly_cost = [Math]::Round($_.monthly_cost, 2); active_lines = $_.active_lines; holder = $_.holder; contract = $_.contract } })
    $since = (Get-Date).ToUniversalTime().AddMinutes(-1).ToString('o'); $mn = 0
    for ($i = 0; $i -lt $ml.Count; $i += 1000) { $res = Bridge @{ action = 'member_cost_upsert'; rows = @($ml[$i..([Math]::Min($i + 999, $ml.Count - 1))]) }; if ($res.error) { throw $res.error }; $mn += [int]$res.n }
    $pr = Bridge @{ action = 'member_cost_prune'; since = $since }
    Log ("member monthly costs: {0:N0} members on active treatment, {1:N0} no longer active removed" -f $mn, [int]$pr.n); $csig = $csigWant
  } catch { Log ('contract dates / member costs not sent: ' + $_.Exception.Message) }
  [IO.File]::WriteAllText($StateFile, ([pscustomobject]@{ sig = $sig; csig = $csig; at = (Get-Date).ToString('o'); hashes = $newHashes } | ConvertTo-Json -Depth 3 -Compress), $Utf8)
  Log ("done: {0:N0} uploaded, server has {1:N0} lines" -f $done, (Bridge @{ action = 'history_stats' }).rows)
  try { $cr = Bridge @{ action = 'catalog_refresh' }; Log ("medicine search list: {0:N0} medicines" -f $cr.medicines) } catch { Log ('medicine list refresh failed: ' + $_.Exception.Message) }
}
catch { Log ('FAILED: ' + $_.Exception.Message); exit 1 }
finally { $mutex.ReleaseMutex() }
