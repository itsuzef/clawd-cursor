param([int]$Port = 3847, [int]$TimeoutSec = 30)

$token = (Get-Content "$env:USERPROFILE\.clawdcursor\token" -Raw).Trim()
$base = "http://127.0.0.1:$Port/mcp"
$hdrs = @{
  "Authorization" = "Bearer $token"
  "Accept" = "application/json, text/event-stream"
}

$global:jsonRpcId = 0
function Call-Tool {
  param([string]$Name, [hashtable]$Arguments = @{})
  $global:jsonRpcId++
  $body = @{
    jsonrpc = "2.0"
    id      = $global:jsonRpcId
    method  = "tools/call"
    params  = @{ name = $Name; arguments = $Arguments }
  } | ConvertTo-Json -Depth 10 -Compress
  try {
    $r = Invoke-WebRequest -Uri $base -Method POST -Headers $hdrs -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSec -UseBasicParsing
    $content = $r.Content
    if ($content -match '(?ms)^data:\s*(\{.*?\})\s*$') {
      return ($matches[1] | ConvertFrom-Json)
    }
    return ($content | ConvertFrom-Json)
  } catch {
    return @{ error = @{ message = $_.Exception.Message } }
  }
}

function Tool-Text {
  param($Result)
  if ($Result.error) { return "ERROR: $($Result.error.message)" }
  if ($Result.result.content) {
    return ($Result.result.content | ForEach-Object { $_.text }) -join "`n"
  }
  return ($Result | ConvertTo-Json -Depth 5 -Compress)
}

Write-Host ""
Write-Host "========================================="
Write-Host " Smoke 1: Calculator (Win32 a11y)"
Write-Host "========================================="

$r1 = Call-Tool open_app @{ name = "Calculator" }
Write-Host "open_app Calculator: $(Tool-Text $r1)"
Start-Sleep -Seconds 2

$r2 = Call-Tool read_screen @{}
$tree = Tool-Text $r2
$hasButtons = ($tree -match 'One|Two|Three|Plus|Equals|Button')
Write-Host "read_screen lines: $($tree.Split([char]10).Count); named buttons: $hasButtons"

$r3 = Call-Tool invoke_element @{ name = "Two" }
Write-Host "invoke Two: $(Tool-Text $r3)"
Start-Sleep -Milliseconds 200
$null = Call-Tool invoke_element @{ name = "Plus" }
Start-Sleep -Milliseconds 200
$null = Call-Tool invoke_element @{ name = "Three" }
Start-Sleep -Milliseconds 200
$null = Call-Tool invoke_element @{ name = "Equals" }
Start-Sleep -Milliseconds 600

$r4 = Call-Tool read_screen @{}
$treeAfter = Tool-Text $r4
$saysFive = ($treeAfter -match 'Display is 5|\b5\b')
Write-Host "Result tree mentions 5: $saysFive"
if ($saysFive) { Write-Host "PASS  Calculator 2+3=5 via a11y" } else { Write-Host "FAIL  result not in tree" }

Write-Host ""
Write-Host "========================================="
Write-Host " Smoke 2: Notepad (Win32 typing)"
Write-Host "========================================="

$r5 = Call-Tool open_app @{ name = "Notepad" }
Write-Host "open_app Notepad: $(Tool-Text $r5)"
Start-Sleep -Seconds 2

$r6 = Call-Tool focus_element @{ name = "Text editor" }
Write-Host "focus_element Text editor: $(Tool-Text $r6)"

$stamp = (Get-Date -Format 'HHmmss')
$payload = "clawdcursor v0.9 smoke at $stamp"
$r7 = Call-Tool type_text @{ text = $payload }
Write-Host "type_text: $(Tool-Text $r7)"
Start-Sleep -Milliseconds 500

$r8 = Call-Tool read_screen @{}
$treeNotepad = Tool-Text $r8
$contains = ($treeNotepad -match [regex]::Escape($payload.Substring(0, 20)))
Write-Host "Notepad tree contains typed prefix: $contains"
if ($contains) { Write-Host "PASS  Notepad type_text via a11y" } else { Write-Host "FAIL  typed text not in tree" }

Write-Host ""
Write-Host "========================================="
Write-Host " Smoke 3: Outlook webview detection"
Write-Host "========================================="

$r9 = Call-Tool open_app @{ name = "Outlook" }
Write-Host "open_app Outlook: $(Tool-Text $r9)"
Start-Sleep -Seconds 3

$r10 = Call-Tool detect_webview_apps @{}
Write-Host "detect_webview_apps: $(Tool-Text $r10)"

$r11 = Call-Tool read_screen @{}
$outlookTree = Tool-Text $r11
$emptyTree = ($outlookTree.Length -lt 400 -or $outlookTree -match 'empty a11y tree|custom-canvas|app may be custom')
Write-Host "Outlook a11y tree size: $($outlookTree.Length) chars; sparse/empty: $emptyTree"
if ($emptyTree) {
  Write-Host "REPRO  Outlook a11y is sparse/empty (matches your failed run)"
  Write-Host "       Agent should have used detect_webview_apps + relaunch_with_cdp"
} else {
  Write-Host "NEW    Outlook surfaced a real tree (webview hint may not be needed)"
}

Write-Host ""
Write-Host "=== SMOKE TESTS DONE ==="
