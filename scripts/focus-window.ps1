<#
.SYNOPSIS
    Focuses (brings to front) a window by title substring or process ID.
    Uses UI Automation WindowPattern.SetWindowVisualState + SetFocus.
.PARAMETER Title
    Substring match against window titles (case-insensitive).
.PARAMETER ProcessId
    Exact process ID to focus.
.PARAMETER Restore
    If true, restore from minimized state before focusing.
#>
param(
    [string]$Title = "",
    [int]$ProcessId = 0,
    [switch]$Restore
)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write((@{ success = $false; error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWindows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $windowCondition
    )

    $targetWindow = $null

    # When BOTH ProcessId and Title are supplied, AND-match. This disambiguates
    # tabbed apps like Win11 Notepad where multiple windows share one pid —
    # without the AND-match, this script returned whichever window came first
    # in the UIA enumeration, which is non-deterministic across launches.
    if ($ProcessId -gt 0 -and $Title -ne "") {
        $titleLower = $Title.ToLower()
        foreach ($win in $allWindows) {
            try {
                if ($win.Current.ProcessId -ne $ProcessId) { continue }
                $winTitle = $win.Current.Name
                if ($winTitle -and $winTitle.ToLower().Contains($titleLower)) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
        # Fall back to pid-only if the title didn't match — the caller may
        # have passed a stale title; better to focus *something* than fail.
        if ($null -eq $targetWindow) {
            foreach ($win in $allWindows) {
                try {
                    if ($win.Current.ProcessId -eq $ProcessId) {
                        $targetWindow = $win
                        break
                    }
                } catch {}
            }
        }
    } elseif ($ProcessId -gt 0) {
        foreach ($win in $allWindows) {
            try {
                if ($win.Current.ProcessId -eq $ProcessId) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
    } elseif ($Title -ne "") {
        $titleLower = $Title.ToLower()
        foreach ($win in $allWindows) {
            try {
                $winTitle = $win.Current.Name
                if ($winTitle -and $winTitle.ToLower().Contains($titleLower)) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
    } else {
        [Console]::Out.Write((@{ success = $false; error = "Must specify -Title or -ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    if ($null -eq $targetWindow) {
        [Console]::Out.Write((@{ success = $false; error = "Window not found matching Title='$Title' ProcessId=$ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    # Restore from minimized if needed
    try {
        $winPattern = $targetWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        $state = $winPattern.Current.WindowVisualState
        if ($state -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
            $winPattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
            Start-Sleep -Milliseconds 200
        }
    } catch {
        # WindowPattern may not be available
    }

    # Always load the Win32 helpers; we use them for ForegroundWindow even
    # on the SetFocus path because UIA SetFocus does NOT change foreground.
    Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32Focus {
            [DllImport("user32.dll")]
            public static extern bool SetForegroundWindow(IntPtr hWnd);
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            [DllImport("user32.dll")]
            public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
            [DllImport("kernel32.dll")]
            public static extern uint GetCurrentThreadId();
            [DllImport("user32.dll", SetLastError=true)]
            public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
            [StructLayout(LayoutKind.Sequential)]
            public struct INPUT { public uint type; public InputUnion u; }
            [StructLayout(LayoutKind.Explicit)]
            public struct InputUnion {
                [FieldOffset(0)] public KEYBDINPUT ki;
            }
            [StructLayout(LayoutKind.Sequential)]
            public struct KEYBDINPUT {
                public ushort wVk;
                public ushort wScan;
                public uint dwFlags;
                public uint time;
                public IntPtr dwExtraInfo;
            }
        }
"@

    $hwnd = [IntPtr]$targetWindow.Current.NativeWindowHandle

    # Restore from minimized if needed (Win32 path is more reliable than UIA here)
    [Win32Focus]::ShowWindow($hwnd, 9) | Out-Null # SW_RESTORE

    # Try UIA SetFocus first — it works inside the same process and pokes the
    # accessibility focus, but it does NOT change the foreground window when
    # the daemon was launched from a different foreground app.
    try { $targetWindow.SetFocus() } catch { }

    # Now force foreground. Windows blocks SetForegroundWindow unless the
    # calling thread is attached to the current foreground thread's input
    # queue (or one of a few other conditions). Standard Raymond-Chen trick:
    # nudge SendInput once to satisfy the foreground-lock timeout, then
    # attach-then-set-then-detach.
    $foregroundOk = $false
    try {
        # 1. Nudge SendInput with a no-op to clear the foreground lock timeout.
        $blank = New-Object Win32Focus+INPUT
        $blank.type = 1 # INPUT_KEYBOARD
        $blank.u.ki.wVk = 0
        $blank.u.ki.wScan = 0
        $blank.u.ki.dwFlags = 0
        [Win32Focus]::SendInput(1, @($blank), [System.Runtime.InteropServices.Marshal]::SizeOf($blank)) | Out-Null

        # 2. Attach this thread's input queue to the foreground thread's.
        $fgHwnd = [Win32Focus]::GetForegroundWindow()
        $fgTid  = [Win32Focus]::GetWindowThreadProcessId($fgHwnd, [IntPtr]::Zero)
        $myTid  = [Win32Focus]::GetCurrentThreadId()
        $tgtTid = [Win32Focus]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)

        $attachedFg = $false
        $attachedTgt = $false
        if ($fgTid -ne 0 -and $fgTid -ne $myTid) {
            $attachedFg = [Win32Focus]::AttachThreadInput($myTid, $fgTid, $true)
        }
        if ($tgtTid -ne 0 -and $tgtTid -ne $myTid -and $tgtTid -ne $fgTid) {
            $attachedTgt = [Win32Focus]::AttachThreadInput($myTid, $tgtTid, $true)
        }

        # 3. Now SetForegroundWindow is permitted.
        $foregroundOk = [Win32Focus]::SetForegroundWindow($hwnd)

        if ($attachedFg)  { [Win32Focus]::AttachThreadInput($myTid, $fgTid,  $false) | Out-Null }
        if ($attachedTgt) { [Win32Focus]::AttachThreadInput($myTid, $tgtTid, $false) | Out-Null }

        # 4. Verify: read GetForegroundWindow and confirm it's our hwnd. If
        # something denied us anyway, surface that to the caller.
        Start-Sleep -Milliseconds 80
        $nowFg = [Win32Focus]::GetForegroundWindow()
        if ($nowFg -ne $hwnd) { $foregroundOk = $false }
    } catch {
        $foregroundOk = $false
    }

    $c = $targetWindow.Current
    [Console]::Out.Write((@{
        success      = $true
        foreground   = $foregroundOk
        title        = $c.Name
        processId    = $c.ProcessId
        handle       = $c.NativeWindowHandle
    } | ConvertTo-Json -Compress))

} catch {
    [Console]::Out.Write((@{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
