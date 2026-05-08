/**
 * Unified pipeline (v0.8.1) — three layers, ONE agent.
 *
 *   Layer 1 — PREPROCESSOR         ONE job: decide the shape per task.
 *     └─ emits {strategy, subtasks, hints}
 *
 *   Layer 2 — EXECUTOR              ONE job: execute the chosen strategy.
 *     ├─ router              0 LLM  (app launches, shortcuts)
 *     └─ agent               LLM    (ONE agent, three modes:
 *                                     blind / hybrid / vision)
 *
 *   Layer 3 — ESCALATOR             ONE job: when a rung fails, pick the
 *                                   next one (router → blind → hybrid →
 *                                   vision). No premium retry tier.
 *
 * Differences from the pre-unification design:
 *   • text-agent and vision-agent are deleted. Both are the same loop now,
 *     just different tool catalogs and perception seeds.
 *   • Vision is ALWAYS the fallback, never the default.
 *   • All tool calls flow through the agent's SafetyLayer gate — no more
 *     `ctx.platform.*` bypass via the old vision-agent/tools.ts.
 *   • Native tool_use replaces JSON-in-prose parsing (Anthropic tool_use
 *     + OpenAI tool_calls; generic fallback for other providers).
 *   • Per-turn a11y snapshot refresh keeps the model oriented.
 *   • FingerprintHistory stagnation detection forces the agent to change
 *     approach or give_up, not loop forever on a dead button.
 *
 * Model-agnostic: LLM configs flow through AgentLlmDeps. Mixed-provider is
 * supported natively — text can be Ollama, vision can be Anthropic, etc.
 * OS-agnostic: every I/O goes through PlatformAdapter.
 */

import {
  newCorrelationId,
  runWithCorrelation,
} from './observability/correlation';
import { CostMeter } from './observability/cost-meter';
import { logger, EVENTS } from './observability/logger';
import type {
  TaskResult as PipelineTaskResult,
  PipelineAction,
} from './types';
import type { PlatformAdapter } from '../v2/platform/types';

import { preprocess, type Strategy } from './preprocessor/preprocessor';
import { Router, type RouteResult } from './router/router';
import { SkillCache } from './skills/skill-cache';
import { runAgent } from './agent/agent';
import type { AgentLlmConfig, AgentLlmDeps, AgentMode, AgentResult } from './agent/types';
import type { Verifier, StateSnapshot, TaskType, ReflectionFeedback } from '../v2/verifier/types';
import { GroundTruthVerifier } from '../v2/verifier/ground-truth';
import type { Capability } from './classify/capability';
import { decomposeWithLlm, DECOMPOSE_SYSTEM_PROMPT } from './decompose/llm-decomposer';
import { callLLMWithTools } from '../llm-client';

/**
 * Tasks the LLM decomposer can safely skip — a single concrete verb + a
 * single concrete target with no indefinite phrasing. These get the
 * router's deterministic fast path (or the agent ladder) without paying
 * for an LLM round-trip.
 *
 * Skip LLM:
 *   • "open notepad"                   → trivial
 *   • "navigate to https://github.com" → trivial (URL is concrete)
 *   • "focus outlook"                  → trivial
 *   • "copy"                           → trivial
 *
 * Run LLM:
 *   • "open any wikipedia page"        → INDEFINITE_INTENT_PATTERN matches
 *   • "open the latest article"        → INDEFINITE_INTENT_PATTERN matches
 *   • "open notepad and type hello"    → COMPOUND_TASK_PATTERN matches
 *   • "find a restaurant near me"      → both
 *   • "summarize this page"            → no trivial-verb match (LLM by default)
 *
 * Triviality requires ALL THREE: verb-prefix match AND no compound
 * AND no indefinite phrasing. If any of those fails, we run the LLM.
 */
const TRIVIAL_TASK_PATTERN =
  /^\s*(?:open|launch|start|run|focus|switch\s+to|navigate\s+to|go\s+to|visit|browse\s+to|copy|paste|cut|save|undo|redo|press|type)\s+\S[^.]*?$/i;

/** Compound-task hint. Forces LLM decomposition even if the parts look trivial. */
const COMPOUND_TASK_PATTERN = /\b(?:and|then|,)\b/i;

/**
 * Indefinite phrasing — "any X", "the latest", "a random", "some Y",
 * "today's news", "anything", "an example". Any of these forces LLM
 * decomposition even when the surrounding structure looks trivial.
 *
 * Word-boundary anchored. App-agnostic — these are language patterns,
 * not app-specific rules. English-only (same coupling as the rest of
 * the pipeline's regex layer).
 */
const INDEFINITE_INTENT_PATTERN = new RegExp(
  [
    '\\bany\\b',                           // "any wikipedia page"
    '\\ba\\s+random\\b',                   // "a random article"
    '\\bsome\\s+(?:random\\s+)?\\w+',      // "some restaurant"
    '\\bseveral\\b',                       // "several photos"
    '\\bthe\\s+(?:latest|first|top|most\\s+recent)\\b', // "the latest email"
    '\\btoday\'?s\\b',                     // "today's news"
    '\\bsomething\\b',                     // "something funny"
    '\\banything\\b',                      // "anything trending"
    '\\ban?\\s+example\\b',                // "an example"
    '\\bdefault\\s+(?:browser|mail\\s+client|editor)\\b', // "default browser"
  ].join('|'),
  'i',
);

/**
 * Map the preprocessor's `capability` hint to a verifier `TaskType`.
 * Returning `undefined` lets the verifier fall back to its own regex
 * inference — appropriate for capabilities the verifier doesn't
 * specialize on (e.g. `'window_mgmt'` doesn't have a TaskType).
 *
 * App-agnostic + model-agnostic by construction: pure data lookup, no
 * branching on specific apps or LLM providers.
 */
function capabilityToTaskType(cap?: Capability): TaskType | undefined {
  switch (cap) {
    case 'app_launch':  return 'open_app';
    case 'text_input':  return 'type_text';
    case 'navigation':  return 'navigate_url';
    case 'spatial':     return 'draw';
    case 'file_ops':    return 'create_file';
    // 'form_fill', 'window_mgmt', 'general' have no specialized
    // TaskType — let the verifier infer from task text.
    default:            return undefined;
  }
}

// ─── Dependency injection contract ──────────────────────────────────

/**
 * LLM dependency contract. Each slot is independent — a caller can wire
 * text-only, vision-only, or mixed. The agent gracefully degrades when
 * a required slot is missing (clean give_up with an actionable error).
 */
export interface PipelineLlm {
  /** Text-model config (used for blind + hybrid modes). */
  text?: AgentLlmConfig;
  /** Vision-model config (used for vision mode, and hybrid fallback). */
  vision?: AgentLlmConfig;
}

export interface PipelineDeps {
  adapter: PlatformAdapter;
  llm: PipelineLlm;
  /** Refuse vision even if configured (high-security mode). */
  disableVision?: boolean;
  /** Cap inside the agent loop. Default 20. */
  maxTurnsPerRung?: number;
  /** Maximum strategy escalations per task. Default 3. */
  maxEscalations?: number;
  /**
   * Independent ground-truth verifier. When supplied, every successful
   * agent rung (blind / hybrid / vision) is post-checked against actual
   * screen state — if the verifier rejects (e.g. compose still open
   * after the agent claimed `done`), the rung is demoted to
   * `failureReason: 'verifier_rejected'` and the ladder climbs to the
   * next rung.
   *
   * Skipped for `router` rungs (those already use a deterministic
   * before/after window-list diff).
   *
   * Caller can pass a real `GroundTruthVerifier(adapter)` or any test
   * double satisfying the `Verifier` interface. When omitted, the
   * pipeline auto-creates a `GroundTruthVerifier` unless
   * `disableVerifier` is true.
   */
  verifier?: Verifier;
  /**
   * Disable the verifier entirely. The agent's `done()` claim is taken
   * at face value (the pre-verifier behavior). Use for tests that mock
   * the agent without setting up screen state, or for users that
   * explicitly opted out.
   */
  disableVerifier?: boolean;
  /**
   * LLM-based task decomposer for compound natural-language tasks
   * containing indefinite phrasing ("any wikipedia page", "a random
   * article", "the latest email"). Without this, the regex decomposer
   * passes the literal phrase through to the router, which then types
   * "any wikipedia page" into a search bar — the v0.7-vs-v0.8
   * regression.
   *
   * Auto-instantiated from `llm.text` when present. Pass `null` to
   * disable, or a custom function for tests. Invocation is conditional
   * on `INDEFINITE_INTENT_PATTERN` matching the original task — most
   * tasks ("open notepad", "send email to ...") don't trigger it and
   * pay no extra latency.
   */
  decomposer?: ((task: string) => Promise<string[] | null>) | null;
}

export const PIPELINE_DEFAULTS: Required<Pick<PipelineDeps, 'disableVision' | 'maxTurnsPerRung' | 'maxEscalations' | 'disableVerifier'>> = {
  disableVision: false,
  maxTurnsPerRung: 20,
  maxEscalations: 3,
  disableVerifier: false,
};

export interface PipelineRunInput {
  task: string;
  isAborted?: () => boolean;
}

// ─── Pipeline class ─────────────────────────────────────────────────

export class Pipeline {
  private readonly router: Router;
  private readonly skillCache: SkillCache;
  private readonly disableVision: boolean;
  private readonly maxTurnsPerRung: number;
  private readonly maxEscalations: number;
  private readonly verifier: Verifier | null;
  private readonly decomposer: ((task: string) => Promise<string[] | null>) | null;

  constructor(private readonly deps: PipelineDeps) {
    this.router = new Router(deps.adapter);
    this.skillCache = new SkillCache();
    this.disableVision = deps.disableVision ?? PIPELINE_DEFAULTS.disableVision;
    this.maxTurnsPerRung = deps.maxTurnsPerRung ?? PIPELINE_DEFAULTS.maxTurnsPerRung;
    this.maxEscalations = deps.maxEscalations ?? PIPELINE_DEFAULTS.maxEscalations;
    // Verifier wiring:
    //   • explicit `disableVerifier: true` → null (skip post-check entirely)
    //   • caller-supplied `verifier`      → use as-is (lets tests inject)
    //   • neither                         → instantiate the default
    //                                       GroundTruthVerifier from the adapter
    if (deps.disableVerifier) {
      this.verifier = null;
    } else {
      this.verifier = deps.verifier ?? new GroundTruthVerifier(deps.adapter);
    }
    // Auto-wire the LLM decomposer when a text model is configured. The
    // decomposer is gated by `INDEFINITE_INTENT_PATTERN` at call time
    // (see `maybeRefineSubtasks`), so the LLM only fires for tasks that
    // actually need interpretation.
    if (deps.decomposer === null) {
      this.decomposer = null;
    } else if (deps.decomposer) {
      this.decomposer = deps.decomposer;
    } else if (deps.llm.text) {
      const textConfig = deps.llm.text;
      this.decomposer = async (task: string) => {
        const callTextLlm = async (system: string, user: string, opts?: { maxTokens?: number }) => {
          const result = await callLLMWithTools({
            baseUrl: textConfig.baseUrl,
            model: textConfig.model,
            apiKey: textConfig.apiKey,
            isAnthropic: textConfig.isAnthropic,
            system,
            tools: [],
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            maxTokens: opts?.maxTokens ?? 512,
            timeoutMs: 30_000,
            toolChoice: 'auto',
          });
          return result.text ?? '';
        };
        return decomposeWithLlm(task, { callTextLlm });
      };
    } else {
      this.decomposer = null;
    }
  }

  async run(input: PipelineRunInput): Promise<PipelineTaskResult> {
    const correlationId = newCorrelationId();
    const startedAt = Date.now();
    const costMeter = new CostMeter();
    const log = logger.with({ correlationId, task: input.task });
    const isAborted = input.isAborted ?? (() => false);

    return runWithCorrelation({ correlationId, taskText: input.task }, async () => {
      const modelSummary = [
        this.deps.llm.text ? `text=${this.deps.llm.text.model}` : 'text=off',
        this.disableVision ? 'vision=disabled' : (this.deps.llm.vision ? `vision=${this.deps.llm.vision.model}` : 'vision=off'),
      ].join(' ');
      log.info(EVENTS.PIPELINE_START, { task: input.task, models: modelSummary });

      // ── PREPROCESS ONCE to decide whether this is a compound task.
      const outerActive = await this.safeActiveWindow();
      const outerDecision = preprocess(input.task, {
        activeWindowTitle: outerActive?.title,
        activeWindowProcessName: outerActive?.processName,
      });
      log.info(EVENTS.PIPELINE_PREPROCESS, {
        strategy: outerDecision.strategy,
        reason: outerDecision.hints.reason,
        appKey: outerDecision.hints.appKey,
        capability: outerDecision.hints.capability,
        subtasks: outerDecision.subtasks.length,
      });

      let subtasks = outerDecision.subtasks.length > 0
        ? outerDecision.subtasks
        : [input.task];

      // ── Tier 0: LLM intent resolution (always-on when text LLM is configured).
      //
      // v0.7.x ran an LLM decomposer UNCONDITIONALLY at the front of the
      // pipeline; v0.8.x demoted it to a regex-gated fallback. That
      // dropped semantic interpretation for whole classes of input —
      // "open default browser and search …", "find a restaurant near me",
      // "the latest email" — none of which the regex preprocessor
      // recognizes as needing interpretation.
      //
      // Restored design: the decomposer ALWAYS runs unless the task is
      // unambiguously trivial (single concrete verb + concrete target,
      // no compound) — those skip the LLM call as an optimization. This
      // restores the "LLM is active at every stage that needs it"
      // invariant the user remembers from legacy clawdcursor.
      //
      // Cost: ~500-1000 ms text-LLM call for non-trivial tasks. Cheap
      // tier; well worth the consistent canonicalization downstream.
      const isTrivial =
        TRIVIAL_TASK_PATTERN.test(input.task)
        && !COMPOUND_TASK_PATTERN.test(input.task)
        && !INDEFINITE_INTENT_PATTERN.test(input.task);
      if (this.decomposer && !isTrivial) {
        log.info('pipeline.decompose.refine_attempt', { task: input.task });
        try {
          const refined = await this.decomposer(input.task);
          if (refined && refined.length > 0) {
            log.info('pipeline.decompose.refined', {
              originalSubtasks: subtasks.length,
              refinedSubtasks: refined.length,
              first: refined[0],
            });
            subtasks = refined;
          } else {
            log.info('pipeline.decompose.refine_skipped', { reason: 'llm returned empty' });
          }
        } catch (err) {
          log.warn('pipeline.decompose.refine_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through with the regex decomposer's original subtasks —
          // refinement is best-effort, never authoritative.
        }
      }

      const aggregateTrace: PipelineTaskResult['trace'] = [];
      let lastText = '';
      let lastPath: PipelineTaskResult['path'] = 'text-agent';

      for (let i = 0; i < subtasks.length; i++) {
        if (isAborted()) {
          return this.buildResult({
            success: false, path: lastPath, costMeter, startedAt, correlationId,
            text: 'aborted', trace: aggregateTrace,
          });
        }

        const subtask = subtasks[i];
        log.info(EVENTS.PIPELINE_SUBTASK, { index: i + 1, of: subtasks.length, subtask });

        const subActive = await this.safeActiveWindow();
        const subDecision = i === 0 && subtasks.length === 1
          ? outerDecision
          : preprocess(subtask, {
              activeWindowTitle: subActive?.title,
              activeWindowProcessName: subActive?.processName,
            });

        const subResult = await this.runOneSubtask(
          subtask,
          subDecision,
          { costMeter, log, isAborted, trace: aggregateTrace },
        );

        lastText = subResult.text;
        lastPath = subResult.path;

        if (!subResult.success) {
          log.warn('pipeline.subtask.failed_chain_abort', {
            index: i + 1, subtask, path: subResult.path, reason: subResult.failureReason,
          });
          return this.buildResult({
            success: false, path: subResult.path, costMeter, startedAt, correlationId,
            text: subtasks.length > 1
              ? `Subtask ${i + 1}/${subtasks.length} failed ("${subtask}"): ${subResult.text}`
              : subResult.text,
            trace: aggregateTrace,
          });
        }

        // Brief settle between subtasks so the next preprocess sees the
        // correct active window.
        if (i < subtasks.length - 1) await delay(400);
      }

      this.recordSkillOnPass(input.task, aggregateTrace, outerActive?.processName).catch(() => {});
      const result = this.buildResult({
        success: true, path: lastPath, costMeter, startedAt, correlationId,
        text: subtasks.length > 1
          ? `All ${subtasks.length} subtasks completed. Last: ${lastText}`
          : lastText,
        trace: aggregateTrace,
      });
      log.info(EVENTS.PIPELINE_DONE, {
        success: result.success,
        path: result.path,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });
      return result;
    });
  }

  /**
   * Run one subtask through the escalation ladder.
   *
   * Verifier integration:
   *   - Capture a `before` state ONCE before the ladder runs (not per-rung).
   *     The verifier's job is "did the WHOLE work for this subtask result
   *     in the desired screen state?" — so we want to compare against the
   *     state at the start of the subtask, not the state at the start of
   *     each rung (which is what blind has potentially-already-changed to).
   *   - After each AGENT rung (blind / hybrid / vision) reports success,
   *     capture an `after` state and run `verifier.verify(...)`. If the
   *     verifier rejects, demote `success: false` with
   *     `failureReason: 'verifier_rejected'` and let the ladder climb.
   *   - The `router` rung is exempt — it already does its own deterministic
   *     window-list diff and emitting a screenshot for verification on
   *     every router success would be expensive (router is the fast path).
   *   - If the verifier itself throws (platform hiccup, etc.), log and
   *     accept the agent's claim — the verifier is supplementary, not
   *     authoritative. Adopt-don't-override on error.
   */
  private async runOneSubtask(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
  ): Promise<StrategyResult> {
    const ladder = this.buildLadder(decision.strategy);
    env.log.debug('pipeline.ladder', { ladder, strategy: decision.strategy });

    // Snapshot the "before" state ONCE per subtask, only if a verifier is
    // active. Skipped for tasks that can't escalate to an agent rung
    // (router-only ladder is the only such case, but those are quickly
    // followed by agent rungs anyway, so we still capture).
    const before = await this.captureVerifierState(env, 'before');

    let last: StrategyResult = {
      success: false, path: 'text-agent',
      text: 'no strategies tried', failureReason: 'no_ladder',
    };
    let rungsTried = 0;
    /** Last structured feedback from the verifier — carried into the next rung's agent call. */
    let lastFeedback: ReflectionFeedback | undefined;

    // Whether the Reflector override is active (gated env var — see PR9 spec).
    const reflectorEnabled = process.env.CLAWD_REFLECTOR === '1';

    for (let ladderIdx = 0; ladderIdx < ladder.length; ladderIdx++) {
      if (env.isAborted()) {
        return { success: false, path: last.path, text: 'aborted', failureReason: 'aborted' };
      }
      if (rungsTried >= this.maxEscalations) break;

      let rung = ladder[ladderIdx];

      // Reflector override: when CLAWD_REFLECTOR=1 and the previous verifier
      // run returned a `suggestedStrategy`, jump to that rung instead of the
      // default next-ladder entry. Log the override so we have telemetry for
      // the 0.9.1 graduation decision.
      if (reflectorEnabled && lastFeedback?.suggestedStrategy) {
        const overrideStrategy = lastFeedback.suggestedStrategy;
        // Only override if the suggestion maps to a real agent rung and we
        // haven't already tried it (don't loop forever).
        const agentRungs = new Set<string>(['router', 'blind', 'hybrid', 'vision']);
        if (agentRungs.has(overrideStrategy)) {
          const overrideRung = overrideStrategy as Strategy;
          if (!ladder.slice(0, ladderIdx).includes(overrideRung)) {
            env.log.info('pipeline.reflector.override', {
              fromRung: rung,
              toRung: overrideRung,
              cause: lastFeedback.causes[0]?.kind,
              suggestedStrategy: overrideStrategy,
            });
            rung = overrideRung;
          }
        }
        // wait_and_retry / change_target don't map to a specific ladder rung —
        // log them and fall through to the default rung.
        if (!agentRungs.has(overrideStrategy)) {
          env.log.info('pipeline.reflector.override', {
            fromRung: rung,
            toRung: 'default (non-rung strategy)',
            cause: lastFeedback.causes[0]?.kind,
            suggestedStrategy: overrideStrategy,
          });
        }
      }

      rungsTried++;
      env.log.info(EVENTS.PIPELINE_RUNG, { strategy: rung, attempt: rungsTried });

      const attempt = await this.executeStrategy(rung, task, decision, env, lastFeedback);
      last = attempt;

      // Verifier post-check. Only runs when:
      //   • a verifier is active (not disabled)
      //   • the rung claims success
      //   • the rung was an AGENT rung (router is exempt — it has its own
      //     deterministic window-diff verification baked in)
      //   • we managed to capture a `before` state earlier
      if (
        attempt.success
        && this.verifier
        && rung !== 'router'
        && before
      ) {
        const verdict = await this.runVerifier(
          task,
          rung,
          before,
          capabilityToTaskType(decision.hints.capability),
          env,
        );
        // Always stash feedback for the next rung's hint injection.
        if (verdict.kind !== 'skipped' && verdict.feedback) {
          lastFeedback = verdict.feedback;
        }
        if (verdict.kind === 'rejected') {
          env.log.warn('pipeline.verifier.rejected', {
            strategy: rung,
            attempt: rungsTried,
            confidence: verdict.confidence,
            reason: verdict.reason,
          });
          // Demote this rung to a failure so the ladder climbs.
          attempt.success = false;
          attempt.failureReason = 'verifier_rejected';
          attempt.text = `${attempt.text} (verifier rejected: ${verdict.reason})`;
          last = attempt;
          // Continue the loop — try the next rung.
          continue;
        }
        if (verdict.kind === 'verified') {
          env.log.info('pipeline.verifier.verified', {
            strategy: rung,
            attempt: rungsTried,
            confidence: verdict.confidence,
          });
        }
        // verdict.kind === 'skipped' (verifier threw / unavailable) →
        // adopt the agent's claim as-is and fall through to return.
      }

      if (attempt.success) return attempt;

      env.log.info('pipeline.rung.failed', {
        strategy: rung, reason: attempt.failureReason, attempt: rungsTried,
      });

      // If blind failed with cannot_read, that's an explicit escalation
      // signal from the agent — move to hybrid (or vision if hybrid also
      // misses). Don't attempt blind twice.
      if (rung === 'blind' && attempt.failureReason === 'cannot_read') {
        // Skip hybrid if we have no vision model — go straight to the
        // next different path (or give up).
      }
    }

    return last;
  }

  // ─── Verifier helpers ──────────────────────────────────────────────

  /**
   * Capture a `StateSnapshot` for the verifier, or null when the verifier
   * is disabled / capture fails. OCR text is left empty — the verifier's
   * window/focus/pixel signals work regardless, and OCR-dependent
   * assertions degrade gracefully (they just don't add weight to the
   * verdict). Adding OCR here would more than double the latency per
   * subtask; the cost trade-off is documented inline.
   */
  private async captureVerifierState(
    env: StrategyEnv,
    label: 'before' | 'after',
  ): Promise<StateSnapshot | null> {
    if (!this.verifier) return null;
    try {
      return await this.verifier.captureState('');
    } catch (err) {
      env.log.warn('pipeline.verifier.capture_failed', {
        label, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Run the verifier and classify the verdict into one of three actionable
   * outcomes:
   *   - 'verified'   → confidence ≥ 0.6, accept the agent's claim
   *   - 'rejected'   → low confidence, demote and escalate
   *   - 'skipped'    → after-state capture failed / verifier threw —
   *                    adopt the agent's claim as-is (defensive: don't
   *                    block the user on a verifier infra hiccup)
   *
   * Uses `verifyWithFeedback` when available so the pipeline always has
   * structured ReflectionFeedback for logging and (when CLAWD_REFLECTOR=1)
   * for ladder-override decisions.
   */
  private async runVerifier(
    task: string,
    rung: Strategy,
    before: StateSnapshot,
    taskType: TaskType | undefined,
    env: StrategyEnv,
  ): Promise<
    | { kind: 'verified'; confidence: number; reason: string; feedback?: ReflectionFeedback }
    | { kind: 'rejected'; confidence: number; reason: string; feedback?: ReflectionFeedback }
    | { kind: 'skipped'; reason: string }
  > {
    if (!this.verifier) return { kind: 'skipped', reason: 'verifier disabled' };
    const after = await this.captureVerifierState(env, 'after');
    if (!after) return { kind: 'skipped', reason: 'after-state capture failed' };
    try {
      // Prefer `verifyWithFeedback` (always present on GroundTruthVerifier and
      // any conforming test double) for structured Cause[]. Fall back to the
      // plain `verify` for legacy doubles that only implement the old interface.
      let feedback: ReflectionFeedback | undefined;
      if (typeof this.verifier.verifyWithFeedback === 'function') {
        feedback = await this.verifier.verifyWithFeedback({ task, before, after, taskType });
      }

      // Always log the structured feedback regardless of CLAWD_REFLECTOR flag —
      // the flag only gates the ladder-override behaviour, not observability.
      if (feedback) {
        env.log.debug('pipeline.verifier.verdict', {
          strategy: rung,
          pass: feedback.pass,
          confidence: feedback.confidence,
          hint: feedback.hint,
          causes: feedback.causes.map(c => c.kind),
          suggestedStrategy: feedback.suggestedStrategy,
        });
      } else {
        // Plain verify path (legacy test doubles).
        const verdict = await this.verifier.verify({ task, before, after, taskType });
        env.log.debug('pipeline.verifier.verdict', {
          strategy: rung,
          pass: verdict.pass,
          confidence: verdict.confidence,
          reason: verdict.reason,
          signals: verdict.signals.map(s => ({ name: s.name, value: s.value, weight: s.weight })),
        });
        return verdict.pass
          ? { kind: 'verified', confidence: verdict.confidence, reason: verdict.reason }
          : { kind: 'rejected', confidence: verdict.confidence, reason: verdict.reason };
      }

      return feedback.pass
        ? { kind: 'verified', confidence: feedback.confidence, reason: feedback.hint, feedback }
        : { kind: 'rejected', confidence: feedback.confidence, reason: feedback.hint, feedback };
    } catch (err) {
      env.log.warn('pipeline.verifier.threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'skipped', reason: 'verifier threw' };
    }
  }

  // ─── Strategy dispatch ──────────────────────────────────────────

  private buildLadder(initial: Strategy): Strategy[] {
    if (initial === 'router') {
      return ['router', 'blind', 'hybrid', 'vision'];
    }
    if (initial === 'blind') {
      return ['blind', 'hybrid', 'vision'];
    }
    if (initial === 'hybrid') {
      return ['hybrid', 'vision'];
    }
    return ['vision'];
  }

  private async executeStrategy(
    strategy: Strategy,
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
    prevFeedback?: ReflectionFeedback,
  ): Promise<StrategyResult> {
    switch (strategy) {
      case 'router':  return this.runRouter(task, env);
      case 'blind':   return this.runUnifiedAgent(task, decision, env, 'blind', prevFeedback);
      case 'hybrid':  return this.runUnifiedAgent(task, decision, env, 'hybrid', prevFeedback);
      case 'vision':  return this.runUnifiedAgent(task, decision, env, 'vision', prevFeedback);
    }
  }

  private async runRouter(task: string, env: StrategyEnv): Promise<StrategyResult> {
    void env;
    const r: RouteResult = await this.router.route(task);
    if (r.handled) {
      return { success: true, text: r.description ?? 'router handled', path: 'router' };
    }
    return {
      success: false,
      text: r.description ?? 'router miss',
      path: 'router',
      failureReason: 'router_miss',
    };
  }

  /**
   * Run the unified agent in the requested mode. Enforces vision-disable
   * config, wires DI into runAgent, projects the AgentResult into the
   * pipeline trace, and maps the exit code to a StrategyResult.
   *
   * When `prevFeedback` is supplied (from the previous rung's verifier
   * rejection), its `hint` is forwarded to the agent as a `reflectorHint`
   * so the planner understands why the prior step failed. The agent injects
   * it as a synthetic `tool_result` at the start of the next turn's history.
   */
  private async runUnifiedAgent(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
    mode: AgentMode,
    prevFeedback?: ReflectionFeedback,
  ): Promise<StrategyResult> {
    const path: PipelineTaskResult['path'] = mode === 'vision' || mode === 'hybrid'
      ? 'vision-agent'
      : 'text-agent';

    // ── Config availability & vision-disable gating
    if ((mode === 'vision' || mode === 'hybrid') && this.disableVision) {
      return {
        success: false,
        text: 'Vision disabled (--no-vision / OPENCLAW_DISABLE_VISION=1).',
        path,
        failureReason: 'vision_disabled',
      };
    }
    if (mode === 'blind' && !this.deps.llm.text) {
      return {
        success: false,
        text: 'No text model configured. Run `clawdcursor doctor` to set AI_TEXT_MODEL.',
        path,
        failureReason: 'no_text_model',
      };
    }
    if ((mode === 'vision' || mode === 'hybrid') && !this.deps.llm.vision && !this.deps.llm.text) {
      return {
        success: false,
        text: 'No vision or text model configured. Run `clawdcursor doctor`.',
        path,
        failureReason: 'no_llm',
      };
    }

    const llmDeps: AgentLlmDeps = {
      text: this.deps.llm.text,
      vision: this.disableVision ? undefined : this.deps.llm.vision,
    };

    const agentResult: AgentResult = await runAgent(
      {
        task,
        mode,
        guide: decision.hints.guide,
        capability: decision.hints.capability,
        maxTurns: this.maxTurnsPerRung,
        isAborted: env.isAborted,
        reflectorHint: prevFeedback?.hint,
      },
      { adapter: this.deps.adapter, llm: llmDeps },
    );

    // Cost approximation — crude but non-zero. Each turn ≈ 400 input +
    // 120 output tokens for blind; vision bumps that by ~1500 per screenshot.
    const turns = agentResult.steps.length;
    const inputTokens = turns * 400 + agentResult.screenshotsCaptured * 1500;
    const outputTokens = turns * 120;
    env.costMeter.record({
      model: mode === 'vision' || mode === 'hybrid' ? 'vision-agent' : 'text-agent',
      stage: mode,
      inputTokens,
      outputTokens,
    });

    // Project agent steps into the uniform pipeline trace.
    for (const step of agentResult.steps) {
      env.trace.push({
        action: synthActionFromStep(step.toolName, step.toolArgs),
        result: { success: step.result.success, text: step.result.text },
        durationMs: step.durationMs,
      });
    }

    if (agentResult.success) {
      return { success: true, text: agentResult.text, path };
    }

    // Map exit → failureReason so the escalator can make intelligent
    // decisions. `cannot_read` in blind mode should escalate cleanly.
    const failureReason = agentResult.exit === 'cannot_read' ? 'cannot_read'
      : agentResult.exit === 'give_up' ? 'give_up'
      : agentResult.exit === 'max_turns' ? 'max_turns'
      : agentResult.exit === 'stagnation' ? 'stagnation'
      : agentResult.exit === 'llm_error' ? 'llm_error'
      : agentResult.exit === 'aborted' ? 'aborted'
      : 'agent_failed';

    return { success: false, text: agentResult.text, path, failureReason };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async safeActiveWindow() {
    try { return await this.deps.adapter.getActiveWindow(); }
    catch { return null; }
  }

  private async recordSkillOnPass(
    task: string,
    trace: PipelineTaskResult['trace'],
    appName?: string,
  ): Promise<void> {
    if (!appName || trace.length === 0) return;
    const steps = trace
      .map(t => actionToCachedStep(t.action))
      .filter((s): s is NonNullable<ReturnType<typeof actionToCachedStep>> => s !== null);
    if (steps.length > 0) this.skillCache.record(task, appName, steps);
  }

  private buildResult(args: {
    success: boolean;
    path: PipelineTaskResult['path'];
    costMeter: CostMeter;
    startedAt: number;
    correlationId: string;
    text: string;
    trace: PipelineTaskResult['trace'];
  }): PipelineTaskResult {
    const cost = args.costMeter.snapshot();
    return {
      success: args.success,
      path: args.path,
      costUsd: cost.totalUsd,
      durationMs: Date.now() - args.startedAt,
      correlationId: args.correlationId,
      trace: args.trace,
      text: args.text,
    };
  }
}

// ─── Internal types ─────────────────────────────────────────────────

interface StrategyEnv {
  costMeter: CostMeter;
  log: ReturnType<typeof logger.with>;
  isAborted: () => boolean;
  trace: PipelineTaskResult['trace'];
}

interface StrategyResult {
  success: boolean;
  text: string;
  path: PipelineTaskResult['path'];
  failureReason?: string;
}

export type { TaskResult } from './types';

// ─── Private utilities ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function actionToCachedStep(action: PipelineAction): any | null {
  const src = 'pipeline.agent';
  switch (action.type) {
    case 'a11y_click':     return { type: 'click',  description: `a11y "${action.target}"`, producedBy: src };
    case 'a11y_set_value': return { type: 'type',   description: `a11y set "${action.target}"`, text: action.value, producedBy: src };
    case 'click':          return { type: 'click',  description: `click @${action.x},${action.y}`, x: action.x, y: action.y, producedBy: src };
    case 'type':           return { type: 'type',   description: 'type', text: action.text, producedBy: src };
    case 'press':          return { type: 'key',    description: `press ${action.combo}`, key: action.combo, producedBy: src };
    case 'scroll':         return { type: 'scroll', description: `scroll ${action.dir}`, direction: action.dir, amount: action.amount, producedBy: src };
    case 'wait':           return { type: 'wait',   description: `wait ${action.ms}ms`, ms: action.ms, producedBy: src };
    default:               return null;
  }
}

/**
 * Project a unified-agent tool call into the PipelineAction trace vocabulary
 * so the pipeline's trace stays uniform across router / playbook / agent.
 */
function synthActionFromStep(toolName: string, args: any): PipelineAction {
  switch (toolName) {
    case 'click':
      return { type: 'click', x: Number(args?.x ?? 0), y: Number(args?.y ?? 0) };
    case 'type':
      return { type: 'type', text: String(args?.text ?? '') };
    case 'key':
      return { type: 'press', combo: String(args?.combo ?? args?.key ?? '') };
    case 'scroll': {
      const dir = ['up', 'down', 'left', 'right'].includes(args?.direction) ? args.direction : 'down';
      return { type: 'scroll', dir, amount: args?.amount };
    }
    case 'drag':
      return {
        type: 'drag',
        startX: Number(args?.startX ?? 0),
        startY: Number(args?.startY ?? 0),
        endX:   Number(args?.endX ?? 0),
        endY:   Number(args?.endY ?? 0),
      };
    case 'wait':            return { type: 'wait', ms: Number(args?.ms ?? 0) };
    case 'screenshot':      return { type: 'screenshot' };
    case 'invoke_element':  return { type: 'a11y_click', target: String(args?.name ?? '') };
    case 'set_field_value': return { type: 'a11y_set_value', target: String(args?.name ?? ''), value: String(args?.value ?? '') };
    case 'done':            return { type: 'done', reason: String(args?.evidence ?? args?.reason ?? 'ok') };
    case 'give_up':         return { type: 'give_up', reason: String(args?.reason ?? 'unknown') };
    case 'cannot_read':     return { type: 'cannot_read', reason: String(args?.reason ?? 'a11y insufficient') };
    // Non-mutating tools don't have a dedicated PipelineAction type — they
    // read state only. We project them as `wait(0)` trace entries so the
    // trace stays truthful (the action ran) without polluting retry/replay
    // with a non-executable verb. Keeps skill-cache sane.
    case 'read_screen':
    case 'list_windows':
    case 'read_clipboard':
    case 'write_clipboard':
    case 'open_app':
    case 'focus_window':
      return { type: 'wait', ms: 0 };
    default:
      return { type: 'cannot_read', reason: `unmapped tool: ${toolName}` };
  }
}
