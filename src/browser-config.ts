/**
 * Browser Configuration — centralised helpers for browser detection and CDP port.
 *
 * All files that need to know which browser processes to match, what CDP port
 * to connect to, or where the browser executable lives should import from here
 * instead of hardcoding values.
 */

import type { ClawdConfig } from './types';

export const DEFAULT_CDP_PORT = 9223;
const DEFAULT_BROWSER_PROCESSES = ['msedge', 'chrome', 'chromium', 'firefox', 'brave', 'opera', 'arc', 'safari'];

/** Get configured browser executable path, or null for auto-detection */
export function getBrowserExePath(config?: ClawdConfig): string | null {
  return config?.browser?.executablePath || null;
}

/** Get list of browser process names to match against */
export function getBrowserProcessNames(config?: ClawdConfig): string[] {
  if (config?.browser?.processName) {
    return [config.browser.processName, ...DEFAULT_BROWSER_PROCESSES];
  }
  return DEFAULT_BROWSER_PROCESSES;
}

/** Get CDP debugging port */
export function getCDPPort(config?: ClawdConfig): number {
  return config?.browser?.cdpPort || DEFAULT_CDP_PORT;
}

/** Build a regex matching browser process names */
export function getBrowserProcessRegex(config?: ClawdConfig): RegExp {
  const names = getBrowserProcessNames(config);
  return new RegExp(names.join('|'), 'i');
}

const PLATFORM = process.platform;

/** Get default Chrome executable paths for the current platform */
export function getChromePaths(): string[] {
  if (PLATFORM === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (PLATFORM === 'linux') return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
}

/** Get default Edge executable paths for the current platform */
export function getEdgePaths(): string[] {
  if (PLATFORM === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  if (PLATFORM === 'linux') return ['/usr/bin/microsoft-edge'];
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
}

/** Get browser executable paths, respecting config overrides. Tries custom path first, then defaults. */
export function getBrowserPaths(browser: 'chrome' | 'edge', config?: ClawdConfig): string[] {
  const customExe = getBrowserExePath(config);
  if (customExe) return [customExe];
  return browser === 'chrome' ? getChromePaths() : getEdgePaths();
}
