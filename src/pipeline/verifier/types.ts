/**
 * Verifier — independent ground truth check.
 *
 * The agent loop CAN'T mark its own work as done. The verifier looks at
 * actual screen state (before vs. after) and decides whether the task
 * succeeded. No LLM self-assessment, no prompt heuristics.
 */

import type { ScreenshotResult, UiElement, WindowInfo } from '../../v2/platform/types';

/** A snapshot of relevant screen state at a point in time. */
export interface StateSnapshot {
  timestamp: number;
  screenshot: ScreenshotResult;
  windows: WindowInfo[];
  activeWindow: WindowInfo | null;
  focusedElement: UiElement | null;
  ocrText: string;            // OCR result joined into a single string for keyword checks
  clipboard: string;
}

export interface VerifyResult {
  /** True if the task is verifiably complete. */
  pass: boolean;
  /** 0-1: how confident we are in the verdict. */
  confidence: number;
  /** Human-readable explanation. */
  reason: string;
  /** Individual signal contributions for debugging. */
  signals: VerifySignal[];
}

export interface VerifySignal {
  name: string;
  weight: number;       // 0-1, contribution to overall verdict
  value: boolean;
  detail: string;
}

export interface VerifyOptions {
  /** Original task description. Used for keyword + intent matching. */
  task: string;
  /** State BEFORE the agent ran. */
  before: StateSnapshot;
  /** State AFTER the agent claims completion. */
  after: StateSnapshot;
  /** Optional task-type hint to enable specialized assertions. */
  taskType?: TaskType;
}

export type TaskType =
  | 'send_email'
  | 'compose_message'
  | 'open_app'
  | 'navigate_url'
  | 'type_text'
  | 'create_file'
  | 'search'
  | 'generic';

export interface Verifier {
  /** Run all verification signals and return a verdict. */
  verify(opts: VerifyOptions): Promise<VerifyResult>;

  /** Capture the current state for use as before/after. */
  captureState(ocrText: string): Promise<StateSnapshot>;
}
