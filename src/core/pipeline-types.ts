/**
 * Pipeline — shared types.
 *
 * The unified pipeline restores v0.6.3's "Universal Smart Pipeline" shape on top
 * of v0.8.0's V2 infrastructure (PlatformAdapter + ground-truth verifier). These
 * types are the contract between layers — Router, Sense, Knowledge, SkillCache,
 * TextAgent, VisionAgent, Verifier, Retry.
 *
 * Model-agnostic by construction: names reference "text model" / "vision model"
 * / "retry model" slots, never specific models. Actual model selection flows
 * through `src/providers.ts` PROVIDERS registry and AI_* env vars (inherited
 * from v0.6.0+).
 */

export type Platform = 'windows' | 'macos' | 'linux';

export type TaskCategory =
  | 'mechanical'   // open app, press key combo, navigate URL — router handles, zero LLM
  | 'navigation'   // multi-step inside one app — router + shortcuts, maybe one text LLM turn
  | 'reasoning'    // needs a11y/OCR context — text-agent
  | 'spatial';     // drawing, canvas manipulation, image-heavy — vision-agent

export interface ClassifyResult {
  kind: TaskCategory;
  needsVision: boolean;
  suggestedLayers: string[];
  /** Estimated timeout in ms, derived from category. */
  timeoutMs: number;
  /** Raw matchers that fired, for telemetry. */
  matches: string[];
}

/**
 * A single element in the merged perception snapshot.
 * Coordinates are in real screen pixels (after DPI scaling).
 */
export interface SnapshotElement {
  /** Human-readable label (a11y name or OCR text). */
  name: string;
  /** Accessibility role / control type when known. */
  role?: string;
  /** True screen coords for the element center. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source of this element — preserved so agents can prefer a11y when available. */
  source: 'a11y' | 'ocr' | 'cdp';
  /** A11y-specific automation ID, if present. */
  automationId?: string;
  /** Whether the element accepts input (button, link, input). */
  interactive?: boolean;
  /** Whether the field is a password/secure field — redacted in `value`. */
  secure?: boolean;
  /** Current text value for inputs (redacted if `secure`). */
  value?: string;
  /** Process ID of the owning window. */
  processId?: number;
}

/**
 * A merged perception snapshot — one call, parallel OCR + a11y + optional CDP.
 * Modeled on the per-turn perception snapshot; extended with fingerprint for
 * stagnation detection.
 */
export interface Snapshot {
  /** Source platform. */
  platform: Platform;
  /** Active window when the snapshot was taken. */
  activeWindow?: {
    processId: number;
    processName: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  /** All elements merged from a11y + OCR + CDP, de-duped by spatial overlap. */
  elements: SnapshotElement[];
  /**
   * Stable fingerprint of the snapshot — same UI produces same string, used by
   * the agent loop to detect "nothing changed, stop retrying the same action".
   */
  fingerprint: string;
  /** Timestamp for staleness checks. */
  capturedAt: number;
  /** Which sources successfully contributed; empty sources fell back silently. */
  sources: Array<'a11y' | 'ocr' | 'cdp'>;
}

export interface AppGuide {
  /** App key, e.g. "gmail", "outlook", "notion". */
  app: string;
  /** Human-readable display name. Loader fills from `app` if absent. */
  name: string;
  /** Keyboard shortcuts known for this app (platform-aware modifier). */
  shortcuts?: Record<string, string>;
  /**
   * Named workflows. Each entry is EITHER:
   *   - a prose string ("Press Ctrl+N. Type. Click Save.") — human-readable
   *     hint the LLM reasons from. Easiest to author; what most guides use.
   *   - a structured `AppWorkflow` with typed steps — useful when a future
   *     template runner can execute the workflow deterministically.
   * Both shapes ship and load the same way; consumers should handle both.
   */
  workflows?: Record<string, AppWorkflow | string>;
  /**
   * Layout cues — named UI regions and what lives in them. Surfaced to the
   * agent so it can navigate without a screenshot.
   */
  layout?: Record<string, string>;
  /** Free-form tips injected into the text-agent prompt. */
  tips?: string[];
  /** Domain → app mapping hints (gmail → "gmail"). */
  domainHints?: string[];
  /**
   * Auto-persisted workflows from successful `learn_app` calls. Prose form,
   * FIFO-capped at 20. Distinct from hand-curated `workflows` so the user-
   * override learning loop never overwrites curated entries.
   */
  learnedWorkflows?: Record<string, string>;
}

export interface AppWorkflow {
  /** Display name for the workflow. */
  name: string;
  /** Ordered steps. */
  steps: Array<
    | { type: 'pressKey'; key: string; note?: string }
    | { type: 'typeAtFocus'; field: string; note?: string }
    | { type: 'click'; target: string; note?: string }
    | { type: 'wait'; ms: number; note?: string }
    | { type: 'verify'; name: string; note?: string }
  >;
}

/**
 * A compact action the text-agent or vision-agent emits.
 * This is the internal action vocabulary — not the public MCP tool catalog.
 */
export type PipelineAction =
  | { type: 'a11y_click'; target: string; processId?: number }
  | { type: 'a11y_set_value'; target: string; value: string; processId?: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: number }
  | { type: 'type'; text: string }
  | { type: 'press'; combo: string }
  | { type: 'scroll'; dir: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { type: 'drag'; startX: number; startY: number; endX: number; endY: number }
  | { type: 'screenshot' }
  | { type: 'wait'; ms: number }
  | { type: 'cannot_read'; reason: string }
  | { type: 'done'; reason: string }
  | { type: 'give_up'; reason: string };

export interface ActionResult {
  success: boolean;
  /** Human-readable outcome, for logs + trace. */
  text: string;
  /** Structured payload for introspection. */
  data?: Record<string, unknown>;
  /** Error code when success = false. */
  errorCode?: string;
}

/**
 * What the verifier returns after a task completes. Ported from
 * src/core/verifier.ts — preserved shape so the existing
 * verifier can be moved in v0.8.2 without a rewrite.
 */
export interface VerifierResult {
  pass: boolean;
  confidence: number;
  signals: Record<string, { value: number | boolean | string; weight: number }>;
  rejectReason?: string;
}

export interface TaskResult {
  success: boolean;
  /** The path the pipeline took — useful for telemetry and debugging. */
  path: 'router' | 'playbook' | 'skill-cache' | 'text-agent' | 'vision-agent';
  /** Final verifier result. */
  verifier?: VerifierResult;
  /** Total cost for this task (USD). */
  costUsd: number;
  /** Total duration in ms. */
  durationMs: number;
  /** Correlation ID for log lookups. */
  correlationId: string;
  /** Action trace. */
  trace: Array<{ action: PipelineAction; result: ActionResult; durationMs: number }>;
  /** Human-readable final message. */
  text: string;
}

/**
 * The priorContext accumulator — v0.6.3's pattern, restored.
 * Each layer appends its insights so downstream layers have memory.
 */
export interface PriorContext {
  taskText: string;
  classify?: ClassifyResult;
  guide?: AppGuide;
  snapshot?: Snapshot;
  /** Prior action trace, for step-log digest on retry. */
  trace: Array<{ action: PipelineAction; result: ActionResult }>;
  /** Which checkpoints have fired (multi-app workflows). */
  checkpoints: Record<string, boolean>;
}
