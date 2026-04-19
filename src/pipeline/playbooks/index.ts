/**
 * Playbook registry.
 *
 * Playbooks are hand-coded keyboard choreographies for known app flows that
 * the vision loop would otherwise re-discover on every run. Ported from
 * src/deterministic-flows.ts.
 *
 * Exposed to the text-agent as an internal `run_playbook(name)` tool — NOT
 * on the public MCP surface. The text-agent recognizes "send email in
 * Outlook" → calls run_playbook("outlook-send") and the playbook handles
 * the tab-order + mod+Return + Alt+S fallback choreography.
 *
 * Each playbook is a pure function: takes a PlatformAdapter + args, returns
 * a success flag + trace. No per-playbook state, no retries (that's the
 * verifier's job).
 */

import type { PlatformAdapter } from '../../v2/platform/types';
import { outlookSend } from './outlook-send';
import { macMailSend } from './mac-mail-send';
import { findReplace } from './find-replace';

export interface PlaybookResult {
  success: boolean;
  /** One-line description for logs + verifier context. */
  text: string;
  /** Trace of executed steps for skill-cache recording. */
  steps: Array<{ type: 'click' | 'type' | 'key' | 'scroll' | 'wait'; description: string; [k: string]: unknown }>;
}

export interface PlaybookArgs {
  adapter: PlatformAdapter;
  /** Free-form args (recipient, subject, body, findText, etc.). */
  input: Record<string, string | undefined>;
}

export type Playbook = (args: PlaybookArgs) => Promise<PlaybookResult>;

export const PLAYBOOKS: Record<string, Playbook> = {
  'outlook-send':    outlookSend,
  'mac-mail-send':   macMailSend,
  'find-replace':    findReplace,
};

/**
 * Match a task + active app to a playbook name. Returns null when nothing
 * matches — caller proceeds with the text-agent instead.
 */
export function matchPlaybook(task: string, activeApp: string): string | null {
  const t = task.toLowerCase();
  const app = activeApp.toLowerCase();

  // Outlook: "send email" / "send this" with Outlook focused → outlook-send
  if (/\bsend\b.*\bemail\b|\bcompose\b|\bsend\s+(to|message|mail)/i.test(t)) {
    if (/outlook|olk/.test(app)) return 'outlook-send';
    if (app === 'mail' || /mac ?mail/.test(app)) return 'mac-mail-send';
  }

  // Find & replace — fires in any text editor context
  if (/\bfind\s+and\s+replace\b|\breplace\s+all\b/i.test(t)) {
    return 'find-replace';
  }

  return null;
}

export { outlookSend, macMailSend, findReplace };
