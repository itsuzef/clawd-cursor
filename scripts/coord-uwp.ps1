param([int]$Port = 3847)

$token = (Get-Content "$env:USERPROFILE\.clawdcursor\token" -Raw).Trim()
$base  = "http://127.0.0.1:$Port/mcp"
$hdrs  = @{
  "Authorization" = "Bearer $token"
  "Accept"        = "application/json, text/event-stream"
}

function Call-Tool {
  param([string]$Name, [hashtable]$Arguments = @{})
  $body = (@{ jsonrpc="2.0"; id=1; method="tools/call"; params=@{ name=$Name; arguments=$Arguments } } | ConvertTo-Json -Depth 10 -Compress)
  try {
    $r = Invoke-WebRequest -Uri $base -Method POST -Headers $hdrs -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 15
    if ($r.Content -match '(?s)data:\s*(\{.*\})') { return ($matches[1] | ConvertFrom-Json) }
    return ($r.Content | ConvertFrom-Json)
  } catch { return @{ error = @{ message = $_.Exception.Message } } }
}

function Tool-Text {
  param($r)
  if ($r.error) { return "ERROR: $($r.error.message)" }
  if ($r.result.content) { return ($r.result.content | ForEach-Object { $_.text }) -join "`n" }
  return ($r | ConvertTo-Json -Depth 5 -Compress)
}

Write-Host ""
Write-Host "============================================"
Write-Host " UWP (Calculator + ApplicationFrameHost)"
Write-Host " Raw coordinate click test - no invoke_element shortcut"
Write-Host "============================================"

$null = Call-Tool "open_app" @{ name = "Calculator" }
Start-Sleep -Seconds 2
$null = Call-Tool "focus_window" @{ title = "Calculator" }
Start-Sleep -Milliseconds 500

# Clear the display first via invoke (known good)
$null = Call-Tool "invoke_element" @{ name = "Clear" }
Start-Sleep -Milliseconds 250

$tree = Tool-Text (Call-Tool "read_screen")

# Parse coords for Two, Plus, Three, Equals
$want = @("Two","Plus","Three","Equals")
$coords = @{}
foreach ($n in $want) {
  # Lines look like:  [Button] "Two" id:num2Button @171,489 77x51
  $line = ($tree -split "`n") | Where-Object { $_ -match "\[Button\]\s+`"$n`"" } | Select-Object -First 1
  if ($line -match "@(\d+),(\d+)\s+(\d+)x(\d+)") {
    $bx = [int]$matches[1]; $by = [int]$matches[2]
    $bw = [int]$matches[3]; $bh = [int]$matches[4]
    $coords[$n] = @{ x = $bx + [int]($bw/2); y = $by + [int]($bh/2); raw = "$bx,$by ${bw}x$bh" }
    Write-Host "[parse] $n bounds: $($coords[$n].raw)  -> center ($($coords[$n].x),$($coords[$n].y))"
  } else {
    Write-Host "[parse] $n NOT FOUND in tree" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "[click] Driving 2 + 3 = via mouse_click only (no invoke_element):"
foreach ($n in $want) {
  if ($coords.ContainsKey($n)) {
    $r = Call-Tool "mouse_click" @{ x = $coords[$n].x; y = $coords[$n].y }
    Write-Host "  mouse_click $n @ ($($coords[$n].x),$($coords[$n].y)) -> $(Tool-Text $r)"
    Start-Sleep -Milliseconds 200
  }
}

Start-Sleep -Milliseconds 400
$treeAfter = Tool-Text (Call-Tool "read_screen")
if ($treeAfter -match "Display is (\d+)") {
  Write-Host ""
  Write-Host ">>> Display shows: $($matches[1])"
  if ($matches[1] -eq "5") {
    Write-Host "    PASS  UWP raw-coord click chain produced correct result" -ForegroundColor Green
  } else {
    Write-Host "    FAIL  UWP raw-coord click chain produced WRONG result" -ForegroundColor Red
  }
}
