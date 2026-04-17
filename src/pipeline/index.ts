/**
 * Unified pipeline (v0.8.1) — three layers, flexible order.
 *
 *   Layer 1 — PREPROCESSOR         ONE job: decide the shape per task
 *     └─ emits {strategy, subtasks, hints}
 *
 *   Layer 2 — EXECUTOR              ONE job: execute the chosen strategy
 *     ├─ router          0 LLM
 *     ├─ blind           text-agent over a11y (cheapest LLM path)
 *     ├─ hybrid          text-agent with screenshot() tool
 *     └─ vision          vision-agent with pixels + a11y seed
 *
 *   Layer 3 — ESCALATOR             ONE job: if current attempt failed,
 *                                   pick the next strategy and retry
 *                                   (blind → hybrid → vision, max 3)
 *
 * Vision is always the fallback. No premium retry tier. If all three
 * escalation rungs miss, the pipeline returns an honest structured
 * result and the MCP client decides what to do.
 *
 * Model-agnostic: LLM clients are injected. OS-agnostic: every I/O
 * goes through PlatformAdapter.
 */

import {
  newCorrelationId,
  runWithCorrelation,
} from './observability/correlation';
import { CostMeter } from './observability/cost-meter';
import { logger } from './observability/logger';
import type {
  TaskResult as PipelineTaskResult,
  PipelineAction,
  ActionResult,
} from './types';
import type { PlatformAdapter } from '../v2/platform/types';

import { preprocess, type Strategy } from './preprocessor/preprocessor';
import { Router, type RouteResult } from './router/router';
import { SkillCache } from './skills/skill-cache';
import { captureSnapshot } from './sense/snapshot';
import { runTextAgent, type TextAgentResult } from './text-agent/agent';
import { dispatchAction } from './dispatch';
import { VisionAgentImpl, type VisionLlmFn } from './vision-agent/agent';

// ─── Dependency injection contract ──────────────────────────────────

export type TextLlmFn = (args: {
  system: string;
  user: string;
  maxTokens?: number;
}) => Promise<string>;

export interface PipelineLlm {
  /** Text-agent. Undefined → blind + hybrid fall through to vision. */
  text?: TextLlmFn;
  /** Offline decomposer fallback (not wired yet — regex decomposer runs in L1). */
  decomposer?: TextLlmFn;
  /** Vision-agent. Undefined → vision strategy fails honestly. */
  vision?: VisionLlmFn;
}

export interface PipelineDeps {
  adapter: PlatformAdapter;
  llm: PipelineLlm;
  /** Refuse vision even if configured (high-security mode). */
  disableVision?: boolean;
  /** Cap inside text-agent loop. Default 12. */
  textAgentMaxIterations?: number;
  /** Cap inside vision-agent loop. Default 30. */
  visionAgentMaxIterations?: number;
  /** Maximum strategy escalations per task. Default 3. */
  maxEscalations?: number;
}

export const PIPELINE_DEFAULTS: Required<Pick<PipelineDeps, 'disableVision' | 'textAgentMaxIterations' | 'visionAgentMaxIterations' | 'maxEscalations'>> = {
  disableVision: false,
  textAgentMaxIterations: 12,
  visionAgentMaxIterations: 30,
  maxEscalations: 3,
};

export interface PipelineRunInput {
  task: string;
  isAborted?: () => boolean;
}

// ─── Pipeline class ─────────────────────────────────────────────────

export class Pipeline {
  private readonly router: Router;
  private readonly skillCache: SkillCache;
  private readonly visionAgent: VisionAgentImpl | null;
  private readonly disableVision: boolean;
  private readonly textAgentMaxIterations: number;
  private readonly visionAgentMaxIterations: number;
  private readonly maxEscalations: number;

  constructor(private readonly deps: PipelineDeps) {
    this.router = new Router(deps.adapter);
    this.skillCache = new SkillCache();
    this.disableVision = deps.disableVision ?? PIPELINE_DEFAULTS.disableVision;
    this.textAgentMaxIterations = deps.textAgentMaxIterations ?? PIPELINE_DEFAULTS.textAgentMaxIterations;
    this.visionAgentMaxIterations = deps.visionAgentMaxIterations ?? PIPELINE_DEFAULTS.visionAgentMaxIterations;
    this.maxEscalations = deps.maxEscalations ?? PIPELINE_DEFAULTS.maxEscalations;
    this.visionAgent = deps.llm.vision
      ? new VisionAgentImpl(deps.llm.vision, deps.adapter)
      : null;
  }

  async run(input: PipelineRunInput): Promise<PipelineTaskResult> {
    const correlationId = newCorrelationId();
    const startedAt = Date.now();
    const costMeter = new CostMeter();
    const log = logger.with({ correlationId, task: input.task });
    const isAborted = input.isAborted ?? (() => false);

    return runWithCorrelation({ correlationId, taskText: input.task }, async () => {
      log.info('pipeline.start');

      // ── LAYER 1 — PREPROCESSOR ───────────────────────────────────
      const active = await this.safeActiveWindow();
      const decision = preprocess(input.task, {
        activeWindowTitle: active?.title,
        activeWindowProcessName: active?.processName,
      });
      log.info('pipeline.preprocess', {
        strategy: decision.strategy,
        reason: decision.hints.reason,
        appKey: decision.hints.appKey,
        subtasks: decision.subtasks.length,
      });

      // ── LAYER 2 + 3 — EXECUTE with escalation ladder ─────────────
      // Ordered attempts: start at the preprocessor's pick, escalate up
      // to `maxEscalations` rungs, always ending at vision (unless gated).
      const ladder = this.buildLadder(decision.strategy);
      log.debug('pipeline.ladder', { ladder });

      const trace: PipelineTaskResult['trace'] = [];
      let lastText = '';
      let lastPath: PipelineTaskResult['path'] = 'text-agent';
      let rungsTried = 0;

      for (const rung of ladder) {
        if (isAborted()) {
          return this.buildResult({
            success: false, path: lastPath, costMeter, startedAt, correlationId,
            text: 'aborted', trace,
          });
        }
        if (rungsTried >= this.maxEscalations) break;
        rungsTried++;

        log.info('pipeline.rung', { strategy: rung, attempt: rungsTried });

        const attempt = await this.executeStrategy(
          rung,
          input.task,
          decision,
          { costMeter, log, isAborted, trace },
        );

        lastText = attempt.text;
        lastPath = attempt.path;
        // Each executeStrategy appends to trace directly (via dispatch
        // callbacks). Success ends the ladder immediately.
        if (attempt.success) {
          this.recordSkillOnPass(input.task, trace, active?.processName).catch(() => {});
          return this.buildResult({
            success: true, path: attempt.path, costMeter, startedAt, correlationId,
            text: attempt.text, trace,
          });
        }

        // On failure, log WHY so escalation is visible.
        log.info('pipeline.rung.failed', {
          strategy: rung,
          reason: attempt.failureReason,
          attempt: rungsTried,
        });
      }

      // All rungs exhausted — honest fail.
      return this.buildResult({
        success: false, path: lastPath, costMeter, startedAt, correlationId,
        text: lastText || 'All pipeline rungs failed to resolve the task.',
        trace,
      });
    });
  }

  // ─── Strategy dispatch ──────────────────────────────────────────

  private buildLadder(initial: Strategy): Strategy[] {
    // Router never escalates TO itself — it either handles or the
    // pipeline moves on. The other strategies can chain.
    if (initial === 'router') {
      // Router attempt first; if it misses, escalate blind → hybrid → vision.
      return ['router', 'blind', 'hybrid', 'vision'];
    }
    if (initial === 'blind') {
      return ['blind', 'hybrid', 'vision'];
    }
    if (initial === 'hybrid') {
      return ['hybrid', 'vision'];
    }
    // Vision-first task — no blind attempt, but allow a second vision try if
    // the first returned give_up (loop-level give_up is not necessarily fatal).
    return ['vision'];
  }

  private async executeStrategy(
    strategy: Strategy,
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
  ): Promise<StrategyResult> {
    switch (strategy) {
      case 'router':  return this.runRouter(task, env);
      case 'blind':   return this.runTextAgent(task, decision, env, /*allowScreenshot*/ false);
      case 'hybrid':  return this.runTextAgent(task, decision, env, /*allowScreenshot*/ true);
      case 'vision':  return this.runVisionAgent(task, decision, env);
    }
  }

  private async runRouter(task: string, env: StrategyEnv): Promise<StrategyResult> {
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

  private async runTextAgent(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
    allowScreenshot: boolean,
  ): Promise<StrategyResult> {
    if (!this.deps.llm.text) {
      return {
        success: false,
        text: 'No text model configured. Run `clawdcursor doctor`.',
        path: 'text-agent',
        failureReason: 'no_text_model',
      };
    }

    const result: TextAgentResult = await runTextAgent(
      {
        task,
        guide: decision.hints.guide,
        maxIterations: this.textAgentMaxIterations,
      },
      {
        callTextLlm: async (args) => {
          const out = await this.deps.llm.text!(args);
          env.costMeter.record({
            model: 'text-agent',
            stage: 'text-agent',
            inputTokens: estimateTokens(args.system, args.user),
            outputTokens: estimateTokens(out),
          });
          return out;
        },
        capture: async () => captureSnapshot(this.deps.adapter),
        dispatch: async (a) => {
          // In blind mode, refuse `screenshot` actions — the text-agent
          // shouldn't need them, and when it emits one it's usually a
          // sign it should have emitted cannot_read instead.
          if (!allowScreenshot && a.type === 'screenshot') {
            return {
              success: false,
              text: 'screenshot blocked in blind mode — emit cannot_read to escalate',
              errorCode: 'screenshot_blocked_in_blind',
            };
          }
          const res = await dispatchAction(a, { adapter: this.deps.adapter });
          env.trace.push({ action: a, result: res, durationMs: 0 });
          return res;
        },
        isAborted: env.isAborted,
      },
    );

    if (result.exit === 'done') {
      return { success: true, text: result.text, path: 'text-agent' };
    }
    return {
      success: false,
      text: result.text,
      path: 'text-agent',
      failureReason: `text_agent_${result.exit}`,
    };
  }

  private async runVisionAgent(
    _task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
  ): Promise<StrategyResult> {
    if (this.disableVision) {
      return {
        success: false,
        text: 'Vision fallback disabled (--no-vision).',
        path: 'vision-agent',
        failureReason: 'vision_disabled',
      };
    }
    if (!this.visionAgent) {
      return {
        success: false,
        text: 'No vision model configured. Run `clawdcursor doctor` to set AI_VISION_MODEL.',
        path: 'vision-agent',
        failureReason: 'no_vision_model',
      };
    }
    void decision;

    const result = await this.visionAgent.run({
      task: _task,
      isAborted: env.isAborted,
      maxIterations: this.visionAgentMaxIterations,
    });

    // Approximate cost — each turn ≈ 1500 input tokens (screenshot) + 150 output.
    env.costMeter.record({
      model: 'vision-agent',
      stage: 'vision-agent',
      inputTokens: result.steps.length * 1500,
      outputTokens: result.steps.length * 150,
    });

    // Project vision-agent steps into the uniform PipelineAction trace.
    for (const step of result.steps) {
      env.trace.push({
        action: synthActionFromStep(step.toolName, step.toolArgs),
        result: { success: step.toolResult.success, text: step.toolResult.text },
        durationMs: step.durationMs,
      });
    }

    if (result.success) {
      return { success: true, text: result.reason, path: 'vision-agent' };
    }
    return {
      success: false,
      text: result.reason,
      path: 'vision-agent',
      failureReason: 'vision_agent_failed',
    };
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
  /** Short machine-readable failure tag for telemetry + escalator. */
  failureReason?: string;
}

export type { TaskResult } from './types';

// ─── Private utilities ──────────────────────────────────────────────

function estimateTokens(...parts: string[]): number {
  const total = parts.reduce((n, s) => n + (s?.length ?? 0), 0);
  return Math.ceil(total / 4);
}

function actionToCachedStep(action: PipelineAction): any | null {
  const src = 'pipeline.text-agent';
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

function synthActionFromStep(toolName: string, args: any): PipelineAction {
  switch (toolName) {
    case 'click':
      return { type: 'click', x: Number(args?.x ?? 0), y: Number(args?.y ?? 0) };
    case 'type':
      return { type: 'type', text: String(args?.text ?? '') };
    case 'key':
      return { type: 'press', combo: String(args?.combo ?? args?.key ?? '') };
    case 'scroll': {
      const dir = ['up', 'down', 'left', 'right'].includes(args?.dir) ? args.dir : 'down';
      return { type: 'scroll', dir, amount: args?.amount };
    }
    case 'drag':
      return {
        type: 'drag',
        startX: Number(args?.startX ?? args?.x1 ?? 0),
        startY: Number(args?.startY ?? args?.y1 ?? 0),
        endX:   Number(args?.endX ?? args?.x2 ?? 0),
        endY:   Number(args?.endY ?? args?.y2 ?? 0),
      };
    case 'wait':       return { type: 'wait', ms: Number(args?.ms ?? 0) };
    case 'screenshot': return { type: 'screenshot' };
    case 'invoke_element':  return { type: 'a11y_click', target: String(args?.name ?? '') };
    case 'set_field_value': return { type: 'a11y_set_value', target: String(args?.name ?? ''), value: String(args?.value ?? '') };
    case 'done':       return { type: 'done', reason: String(args?.evidence ?? args?.reason ?? 'ok') };
    case 'give_up':    return { type: 'give_up', reason: String(args?.reason ?? 'unknown') };
    default:           return { type: 'cannot_read', reason: `unmapped vision tool: ${toolName}` };
  }
}
