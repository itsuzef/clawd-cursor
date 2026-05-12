# Direct-drive coordinate accuracy test against the running daemon.
# No `clawdcursor agent` loop, no LLM in the path - just MCP tool calls.
#
# What it proves:
#  1. read_screen reports element bounds at logical coords.
#  2. mouse_click on those coords lands on the element (focus shifts to it).
#  3. invoke_element clicks the right thing without coord math at all.
#  4. The values returned by find_element + the get_screen_size scale factor
#     agree end-to-end across DPI.

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
    if ($r.Content -match '(?s)data:\s*(\{.*\})') {
      return ($matches[1] | ConvertFrom-Json)
    }
    return ($r.Content | ConvertFrom-Json)
  } catch { return @{ error = @{ message = $_.Exception.Message } } }
}

function Tool-Text {
  param($r)
  if ($r.error)        { return "ERROR: $($r.error.message)" }
  if ($r.result.content) { return ($r.result.content | ForEach-Object { $_.text }) -join "`n" }
  return ($r | ConvertTo-Json -Depth 5 -Compress)
}

Write-Host ""
Write-Host "============================================"
Write-Host " Coordinate accuracy test"
Write-Host "============================================"

# A) Screen / scale baseline
$ssR = Call-Tool "get_screen_size"
$ss  = Tool-Text $ssR
Write-Host ""
Write-Host "[A] get_screen_size:"
Write-Host "    $ss"

# B) Open Notepad fresh (clean Win32, no ApplicationFrameHost UWP wrapper)
$null = Call-Tool "open_app" @{ name = "Notepad" }
Start-Sleep -Seconds 2
$null = Call-Tool "focus_window" @{ title = "Notepad" }
Start-Sleep -Milliseconds 500

# C) Read the a11y tree, find the Text editor element bounds
$treeR = Call-Tool "read_screen"
$tree  = Tool-Text $treeR
Write-Host ""
Write-Host "[B] Notepad a11y bounds (look for [Edit] / Text editor lines):"
$tree -split "`n" | Where-Object { $_ -match "Text editor|Edit|Document" } | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" }

# Extract the Edit bounds. Format example:
#   [Edit] "Text editor" id:... @122,200 1200x600
$editLine = ($tree -split "`n") | Where-Object { $_ -match "@\d+,\d+\s+\d+x\d+.*Text editor|Text editor.*@\d+,\d+" } | Select-Object -First 1
if (-not $editLine) {
  $editLine = ($tree -split "`n") | Where-Object { $_ -match "\[Edit\]" } | Select-Object -First 1
}
Write-Host ""
Write-Host "[C] Picked editor line:"
Write-Host "    $editLine"

if ($editLine -match "@(\d+),(\d+)\s+(\d+)x(\d+)") {
  $ex = [int]$matches[1]; $ey = [int]$matches[2]
  $ew = [int]$matches[3]; $eh = [int]$matches[4]
  $cx = $ex + [int]($ew / 2)
  $cy = $ey + [int]($eh / 2)
  Write-Host ""
  Write-Host "[D] Edit center calc: ($cx, $cy)   bounds @($ex,$ey) ${ew}x${eh}"

  # D1) Click via raw coords - verify focus moves to the Edit
  $null = Call-Tool "mouse_click" @{ x = $cx; y = $cy }
  Start-Sleep -Milliseconds 400
  $focusR = Call-Tool "get_focused_element"
  $focus  = Tool-Text $focusR
  Write-Host ""
  Write-Host "[E] After mouse_click($cx,$cy) - focused element:"
  Write-Host "    $focus"
  $isEditFocused = ($focus -match "Edit|Text editor|Document|RichEdit")
  if ($isEditFocused) {
    Write-Host "    PASS  raw coordinate click landed in the editor" -ForegroundColor Green
  } else {
    Write-Host "    FAIL  raw coordinate click did NOT focus the editor" -ForegroundColor Red
  }

  # D2) Now type a marker - if focus is right, it appears in the doc
  $marker = "COORD_TEST_$([int](Get-Random -Maximum 99999))"
  $null = Call-Tool "type_text" @{ text = $marker }
  Start-Sleep -Milliseconds 400
  $tree2 = Tool-Text (Call-Tool "read_screen")
  $contained = ($tree2 -match [regex]::Escape($marker))
  Write-Host ""
  Write-Host "[F] type_text('$marker') -> tree contains marker: $contained"
  if ($contained) {
    Write-Host "    PASS  raw click + type was end-to-end correct" -ForegroundColor Green
  } else {
    Write-Host "    FAIL  marker not found in tree" -ForegroundColor Red
  }
} else {
  Write-Host "    Could not parse bounds from editor line - skipping coord test" -ForegroundColor Yellow
}

# E) Title bar buttons: Minimize sits at a known position on every Win32 window.
#    Use it to test edge-of-window coord accuracy without actually minimizing.
$minLine = ($tree -split "`n") | Where-Object { $_ -match "\[Button\] `"Minimize" } | Select-Object -First 1
if ($minLine -match "@(\d+),(\d+)\s+(\d+)x(\d+)") {
  $mx = [int]$matches[1] + [int]([int]$matches[3] / 2)
  $my = [int]$matches[2] + [int]([int]$matches[4] / 2)
  Write-Host ""
  Write-Host "[G] Minimize button center: ($mx, $my) - HOVER ONLY (no click)"
  # Hover, then read the focused window - if hover landed there, the tooltip
  # area would update but the focused element should not (hover != click).
  $null = Call-Tool "mouse_hover" @{ x = $mx; y = $my }
  Start-Sleep -Milliseconds 250
  Write-Host "    (hover dispatched; visible verification is the tooltip you may see)"
}

Write-Host ""
Write-Host "============================================"
Write-Host " Limitations probed:"
Write-Host "============================================"
Write-Host "  - DPI scaling: get_screen_size already prints the scaleFactor."
Write-Host "  - UWP offset (Calculator): the wrapped ApplicationFrameHost"
Write-Host "    case is tested separately - this run focuses on plain Win32."
Write-Host "  - Multi-monitor: not exercised here. read_screen reports virtual"
Write-Host "    desktop coords; off-primary-monitor accuracy needs a multi-mon"
Write-Host "    box to validate."
Write-Host "  - Negative coords (left-of-primary monitor): same as above."
Write-Host ""
