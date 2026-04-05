/**
 * Cross-platform system notification helper.
 *
 * Sends a non-blocking toast notification to the user's desktop.
 * Used by the guidance system to alert the user when the agent needs help.
 *
 * - Windows: PowerShell [System.Windows.Forms.MessageBox] toast (non-blocking)
 * - macOS:   osascript display notification
 * - Linux:   notify-send
 *
 * Failures are logged but never throw — notifications are best-effort.
 */

import { execFile } from 'child_process';

/**
 * Send a non-blocking toast notification to the user's desktop.
 * Safe to call on any platform — silently no-ops if the notification
 * mechanism is unavailable.
 */
export async function sendNotification(title: string, message: string): Promise<void> {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      await sendWindowsNotification(title, message);
    } else if (platform === 'darwin') {
      await sendMacNotification(title, message);
    } else {
      await sendLinuxNotification(title, message);
    }
  } catch (err) {
    // Notifications are best-effort — never block the pipeline
    console.warn(`[Notification] Failed to send: ${(err as Error).message}`);
  }
}

function sendWindowsNotification(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    // Use BalloonTip via PowerShell — non-blocking toast notification
    const safeTitle = title.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");
    const script = [
      `Add-Type -AssemblyName System.Windows.Forms`,
      `$n = New-Object System.Windows.Forms.NotifyIcon`,
      `$n.Icon = [System.Drawing.SystemIcons]::Information`,
      `$n.Visible = $true`,
      `$n.ShowBalloonTip(10000, '${safeTitle}', '${safeMessage}', 'Info')`,
      `Start-Sleep -Seconds 1`,
      `$n.Dispose()`,
    ].join('; ');

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 10000,
      windowsHide: true,
    }, () => resolve()); // Resolve regardless of outcome
  });
}

function sendMacNotification(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMessage = message.replace(/"/g, '\\"');
    const script = `display notification "${safeMessage}" with title "${safeTitle}"`;

    execFile('osascript', ['-e', script], {
      timeout: 5000,
    }, () => resolve());
  });
}

function sendLinuxNotification(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('notify-send', [title, message, '--expire-time=10000'], {
      timeout: 5000,
    }, () => resolve());
  });
}
