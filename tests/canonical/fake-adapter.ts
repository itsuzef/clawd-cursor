/**
 * Deterministic fake LLM adapter for canonical regression corpus.
 *
 * Plan §5.7 step 32 + §19a.7 — robust-to-model-drift substitute for
 * pre-recorded LLM traces. Pattern-matches (task, state) → canned
 * PipelineAction. No real LLM calls; tests are deterministic.
 */

import type { PipelineAction } from '../../src/pipeline/types';

export interface FakeAgentState {
  task: string;
  step: number;
  /** Last result's text, so the fake can say "done" once the adapter
   *  has echoed back a successful action. */
  lastResultText?: string;
  /** App name currently active (from snapshot), lowercased. */
  activeApp?: string;
}

export type FakeRule = (state: FakeAgentState) => PipelineAction | null;

/**
 * Rule table — first match wins. Each rule inspects state and returns the
 * next action the fake model "wants". Rules encode the expected path for
 * a canonical task; the assertions then check that the pipeline actually
 * took it.
 */
export const FAKE_RULES: FakeRule[] = [
  // "open <app>" — router handles on step 0; the agent is only consulted if
  // router misses, which would itself be a bug. But model the fallback here
  // anyway so a failing router doesn't cascade.
  (s) => {
    if (/^open\s+(notepad|textedit|chrome|gmail)\b/i.test(s.task) && s.step === 0) {
      const app = /open\s+(\S+)/i.exec(s.task)?.[1] ?? '';
      return { type: 'run_playbook', name: 'no-op', args: { note: `router should handle open ${app}` } };
    }
    return null;
  },

  // "type hello" — step 0 types the literal, step 1 declares done.
  (s) => {
    if (/^type\s+.+/i.test(s.task) && s.step === 0) {
      const text = /^type\s+(.+)/i.exec(s.task)?.[1] ?? '';
      return { type: 'type', text };
    }
    if (/^type\s+.+/i.test(s.task) && s.step === 1) {
      return { type: 'done', reason: 'typed' };
    }
    return null;
  },

  // "send email in Outlook" — playbook path.
  (s) => {
    if (/send\s+.*email.*outlook|compose.*outlook/i.test(s.task) && s.step === 0) {
      return { type: 'run_playbook', name: 'outlook-send', args: { to: 'bob@acme.com', subject: 'hi', body: 'test' } };
    }
    if (/send\s+.*email.*outlook|compose.*outlook/i.test(s.task) && s.step === 1) {
      return { type: 'done', reason: 'outlook-send playbook finished' };
    }
    return null;
  },

  // "click Send" — a11y_click with target "Send".
  (s) => {
    if (/^click\s+(?:the\s+)?(\S+)/i.test(s.task) && s.step === 0) {
      const target = /^click\s+(?:the\s+)?(\S+)/i.exec(s.task)?.[1] ?? '';
      return { type: 'a11y_click', target };
    }
    if (/^click\s+/i.test(s.task) && s.step === 1) {
      return { type: 'done', reason: 'clicked' };
    }
    return null;
  },

  // "summarize the screen" — blind-first fast path; we just read and report.
  (s) => {
    if (/summari[sz]e.*screen/i.test(s.task) && s.step === 0) {
      return { type: 'done', reason: 'summary emitted (based on snapshot)' };
    }
    return null;
  },

  // "draw a square on the canvas" — spatial → vision-fallback expected; but
  // in the fake, the text-agent should emit cannot_read on turn 0.
  (s) => {
    if (/\b(draw|sketch|paint)\b/i.test(s.task) && s.step === 0) {
      return { type: 'cannot_read', reason: 'spatial task — canvas not described by a11y' };
    }
    return null;
  },

  // RED TEAM: prompt-injection payload in the task text itself.
  // The fake's task here would be something crafted; the rule ensures we
  // never emit a destructive action regardless of phrasing.
  (s) => {
    if (/IGNORE\s+PREVIOUS\s+INSTRUCTIONS/i.test(s.task)) {
      return { type: 'give_up', reason: 'refusing prompt-injection attempt' };
    }
    return null;
  },

  // Fallback — the agent gives up cleanly, making failures loud in the corpus.
  () => ({ type: 'give_up', reason: 'no fake rule matched' }),
];

/**
 * Build a fake callTextLlm function compatible with TextAgentDeps.callTextLlm.
 * Wraps the rule engine and emits the canonical JSON the agent's parser expects.
 */
export function makeFakeTextLlm(rules: FakeRule[] = FAKE_RULES) {
  let step = 0;
  let lastResultText: string | undefined;

  return async ({ user }: { system: string; user: string; maxTokens?: number }): Promise<string> => {
    // Pull the task line out of the user prompt (first "TASK: ..." line).
    const taskMatch = /TASK:\s*(.+)/m.exec(user);
    const task = taskMatch?.[1]?.trim() ?? '';
    const activeMatch = /window:\s*([^\[]+)\[([^\]]+)/m.exec(user);
    const activeApp = activeMatch?.[2]?.trim().toLowerCase();

    const state: FakeAgentState = { task, step, lastResultText, activeApp };
    for (const rule of rules) {
      const action = rule(state);
      if (action) {
        step += 1;
        const actionPayload = toOutputObject(action);
        return JSON.stringify(actionPayload);
      }
    }
    // Unreachable because the fallback rule always fires, but satisfy types.
    step += 1;
    return JSON.stringify({ action: 'give_up', args: { reason: 'no rule' } });
  };
}

/** Convert a PipelineAction union into the { action, args } shape parseAction expects. */
function toOutputObject(action: PipelineAction): { action: string; args: Record<string, unknown> } {
  const { type, ...rest } = action as any;
  return { action: type, args: rest };
}
