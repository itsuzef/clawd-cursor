/**
 * WebView2 / Electron settle rule — ported from src/action-router.ts.
 *
 * Earned through real debugging: Outlook, Teams, Slack, Discord, Spotify,
 * VSCode, modern Code builds all lock up if hit with UIA queries during
 * their first ~4 seconds of startup. Without this wait, the router
 * succeeds at launching but every downstream tool call on the window
 * times out.
 *
 * Not in PlatformAdapter because:
 *  - the data is OS-agnostic (same apps misbehave on Windows + mac)
 *  - the action is just a sleep; no per-OS syscall to abstract
 *
 * The list of apps this matches against lives in `src/core/app-categories.ts`
 * as the single source of truth for app pattern data. To add a new
 * Electron / WebView2 app to the settle rule, edit `WEBVIEW2_APPS` there
 * — not this file.
 */

import { WEBVIEW2_APPS_PATTERN } from '../app-categories';

export { WEBVIEW2_APPS_PATTERN }; // re-exported for back-compat with existing callers

export const WEBVIEW2_SETTLE_MS = 4_000;

/** True if the given process or app name falls under the settle rule. */
export function needsWebView2Settle(processOrAppName: string): boolean {
  if (!processOrAppName) return false;
  return WEBVIEW2_APPS_PATTERN.test(processOrAppName);
}

/** Millisecond sleep. Returns a promise that resolves after `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Settle if needed. Caller passes the app name or process name — we decide
 * whether to wait. Returns whether a settle fired (for telemetry).
 */
export async function settleIfWebView2(processOrAppName: string): Promise<boolean> {
  if (!needsWebView2Settle(processOrAppName)) return false;
  await sleep(WEBVIEW2_SETTLE_MS);
  return true;
}
