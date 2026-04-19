/**
 * Destructive-key blocklist.
 *
 * v0.8.0 shipped a 3-entry list (alt+f4, ctrl+alt+delete, ctrl+alt+del).
 * The audit flagged this as cosmetic. v0.8.1 expands to the full known
 * destructive set with whitespace-normalized matching so "alt +f4" also
 * blocks.
 *
 * Used by the SafetyLayer. Adding a combo here blocks it across EVERY
 * path (text-agent, vision-agent, MCP direct, REST /action, playbooks).
 */

/** Normalize a user-supplied combo for comparison — lowercase, trim, collapse whitespace. */
export function normalizeCombo(combo: string): string {
  return combo.toLowerCase().replace(/\s+/g, '').replace(/[+_-]+/g, '+');
}

/** Base set stored in normalized form. */
const RAW_BLOCK: string[] = [
  // OS-level destructive
  'alt+f4',              // Windows close window — harmless by itself, but never what an agent should do
  'ctrl+alt+delete',
  'ctrl+alt+del',
  'cmd+q',               // macOS quit app (all windows); text-agent should close via menu explicitly
  'cmd+opt+esc',         // macOS force-quit picker
  'cmd+shift+q',         // macOS log-out

  // Lock / switch-user
  'win+l',               // Windows lock
  'cmd+ctrl+q',          // macOS lock

  // Run-arbitrary-command pickers
  'win+r',               // Windows Run dialog — arbitrary command entry
  'cmd+space',           // macOS Spotlight (not destructive but not an agent action)

  // Show desktop / minimize everything
  'win+d',
  'cmd+f3',              // macOS Show Desktop
  'f11',                 // Full-screen — rarely what an agent wants, often interferes with UIA

  // Task manager / force quit escalation path
  'ctrl+shift+esc',

  // Shutdown combos some laptops map to
  'fn+alt+f4',

  // Close tab / window
  'ctrl+w',              // close tab/window — can lose state silently
  'cmd+w',
];

/** The read-only normalized blocklist. */
export const BLOCKED_KEYS: ReadonlySet<string> = new Set(RAW_BLOCK.map(normalizeCombo));

/** Is this combo blocked? */
export function isBlockedKey(combo: string): boolean {
  return BLOCKED_KEYS.has(normalizeCombo(combo));
}

/** Reason string for a block — usable as an error message. */
export function blockReason(combo: string): string {
  return `Key combo "${combo}" is blocked — requires explicit user consent via Confirm-tier safety.`;
}
