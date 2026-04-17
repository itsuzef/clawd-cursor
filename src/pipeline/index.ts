/**
 * Unified pipeline (v0.8.1) — blind-first by construction.
 *
 * One ordered path. Every stage does one thing. No premium retry tier,
 * no "maybe a different model" escape hatch — if a11y and OCR can't
 * resolve the task, vision tries; if vision can't resolve it, we return
 * honestly and let the caller decide what to do next.
 *
 *   classify → router → knowledge → sense (a11y) → text-agent
 *                                                      │ cannot_read / spatial
 *                                                      ▼
 *                                                  vision-agent
 *                                                      │
 *                                                      ▼
 *                                                   (return)
 *
 * Model-agnostic: LLM clients are injected as callbacks. Pipeline has no
 * idea which provider is live. Any tool-calling text model + any
 * vision-capable tool-calling model (Anthropic, OpenAI, Gemini, Groq,
 * DeepSeek, Kimi, Ollama, custom OpenAI-compat) works.
 *
 * OS-agnostic: every I/O goes through PlatformAdapter. `if (process.platform)`
 * branches are forbidden in this file.
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

import { classifyTask } from './classify/classify';
import { Router } from './router/router';
import { SkillCache } from './skills/skill-cache';
import { loadGuide, getWorkflowForTask, detectApp } from './knowledge/loader';
import { captureSnapshot } from './sense/snapshot';
import { runTextAgent } from './text-agent/agent';
import { dispatchAction } from './dispatch';
import { VisionAgentImpl, type VisionLlmFn } from './vision-agent/agent';

// ─── Dependency injection contract ──────────────────────────────────

/**
 * Text LLM callback — used by the text-agent and the offline decomposer
 * fallback. Single-turn prompt/response. Pipeline does not know or care
 * which provider is live.
 */
export type TextLlmFn = (args: {
  system: string;
  user: string;
  maxTokens?: number;
}) => Promise<string>;

export interface PipelineLlm {
  /** Text-agent inner loop. Undefined → text-agent is skipped. */
  text?: TextLlmFn;
  /** Offline decomposer fallback. Defaults to `text` when absent. */
  decomposer?: TextLlmFn;
  /** Vision-fallback loop. Undefined → vision-agent is skipped. */
  vision?: VisionLlmFn;
}

export interface PipelineDeps {
  adapter: PlatformAdapter;
  llm: PipelineLlm;
  /**
   * Refuse the vision fallback even if a vision model is configured.
   * For high-security environments where pixels must never be sent
   * to an LLM. Corresponds to `--no-vision` / OPENCLAW_DISABLE_VISION=1.
   */
  disableVision?: boolean;
  /** Max iterations inside the text-agent loop. Default 12. */
  textAgentMaxIterations?: number;
  /** Max iterations inside the vision-agent loop. Default 30. */
  visionAgentMaxIterations?: number;
}

export const PIPELINE_DEFAULTS: Required<Pick<PipelineDeps, 'disableVision' | 'textAgentMaxIterations' | 'visionAgentMaxIterations'>> = {
  disableVision: false,
  textAgentMaxIterations: 12,
  visionAgentMaxIterations: 30,
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

  constructor(private readonly deps: PipelineDeps) {
    this.router = new Router(deps.adapter);
    this.skillCache = new SkillCache();
    this.disableVision = deps.disableVision ?? PIPELINE_DEFAULTS.disableVision;
    this.textAgentMaxIterations = deps.textAgentMaxIterations ?? PIPELINE_DEFAULTS.textAgentMaxIterations;
    this.visionAgentMaxIterations = deps.visionAgentMaxIterations ?? PIPELINE_DEFAULTS.visionAgentMaxIterations;
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

      // ── 1. Classify (0 LLM) ─────────────────────────────────────
      const classification = classifyTask(input.task);
      log.debug('pipeline.classified', classification as any);

      // ── 2. Router (0 LLM) ───────────────────────────────────────
      if (!isAborted()) {
        const routed = await this.router.route(input.task);
        if (routed.handled) {
          log.info('pipeline.router.handled', { path: routed.path });
          return this.buildResult({
            success: true,
            path: 'router',
            costMeter,
            startedAt,
            correlationId,
            text: routed.description ?? 'router handled',
            trace: [],
          });
        }
      }

      // ── 3. Knowledge injection ──────────────────────────────────
      const guide = await this.resolveGuide(input.task);
      if (guide) log.info('pipeline.knowledge.matched', { app: guide.appName });

      // Spatial tasks skip the text-agent — a11y can't describe canvas pixels.
      const textAgentWorthwhile =
        classification.kind !== 'spatial' && !!this.deps.llm.text;

      // ── 4. Text agent (cheap, no screenshots) ───────────────────
      if (textAgentWorthwhile) {
        const textResult = await runTextAgent(
          {
            task: input.task,
            guide,
            maxIterations: this.textAgentMaxIterations,
          },
          {
            callTextLlm: async (args) => {
              const out = await this.deps.llm.text!(args);
              costMeter.record({
                model: 'text-agent',
                stage: 'text-agent',
                inputTokens: estimateTokens(args.system, args.user),
                outputTokens: estimateTokens(out),
              });
              return out;
            },
            capture: async () => captureSnapshot(this.deps.adapter),
            dispatch: async (a) => this.dispatch(a),
            isAborted,
          },
        );

        log.info('pipeline.text_agent.exit', {
          exit: textResult.exit,
          actions: textResult.trace.length,
        });

        if (textResult.exit === 'done') {
          this.recordSkill(input.task, textResult.trace);
          return this.buildResult({
            success: true,
            path: 'text-agent',
            costMeter,
            startedAt,
            correlationId,
            text: textResult.text,
            trace: traceFor(textResult.trace),
          });
        }

        if (textResult.exit === 'give_up' || textResult.exit === 'aborted') {
          // Terminal — no point escalating to vision.
          return this.buildResult({
            success: false,
            path: 'text-agent',
            costMeter,
            startedAt,
            correlationId,
            text: textResult.text,
            trace: traceFor(textResult.trace),
          });
        }
        // cannot_read / max_iterations → fall through to vision.
      }

      // ── 5. Vision fallback ──────────────────────────────────────
      if (this.disableVision) {
        return this.buildResult({
          success: false,
          path: 'text-agent',
          costMeter,
          startedAt,
          correlationId,
          text: 'Text-agent could not resolve and vision is disabled (--no-vision).',
          trace: [],
        });
      }

      if (!this.visionAgent) {
        // No vision model configured. Honest structured result — the caller
        // (or the MCP client driving the task) can retry with their own
        // strategy. No premium-retry escape hatch, by design.
        return this.buildResult({
          success: false,
          path: 'vision-agent',
          costMeter,
          startedAt,
          correlationId,
          text: 'No vision model configured. Run `clawdcursor doctor` to set AI_VISION_MODEL (any vision-capable OpenAI-compatible endpoint).',
          trace: [],
        });
      }

      const visionResult = await this.visionAgent.run({
        task: input.task,
        isAborted,
        maxIterations: this.visionAgentMaxIterations,
      });

      costMeter.record({
        model: 'vision-agent',
        stage: 'vision-agent',
        // Approximation — the vision model usage gets tracked here in one
        // aggregate call; per-turn usage surfaces when the LLM client adds it.
        inputTokens: visionResult.steps.length * 1500,
        outputTokens: visionResult.steps.length * 150,
      });

      log.info('pipeline.vision_agent.exit', {
        success: visionResult.success,
        steps: visionResult.steps.length,
      });

      return this.buildResult({
        success: visionResult.success,
        path: 'vision-agent',
        costMeter,
        startedAt,
        correlationId,
        text: visionResult.reason,
        trace: visionResult.steps.map(s => ({
          action: synthActionFromStep(s.toolName, s.toolArgs),
          result: { success: s.toolResult.success, text: s.toolResult.text },
          durationMs: s.durationMs,
        })),
      });
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async dispatch(action: PipelineAction): Promise<ActionResult> {
    return dispatchAction(action, { adapter: this.deps.adapter });
  }

  private async resolveGuide(task: string): Promise<{ promptFragment: string; appName: string } | undefined> {
    try {
      const win = await this.deps.adapter.getActiveWindow();
      const hint = win?.title ?? win?.processName ?? '';
      if (!hint) return undefined;

      const workflow = getWorkflowForTask(task, hint);
      if (workflow) {
        return { promptFragment: workflow.promptFragment, appName: workflow.guide.app };
      }
      const appKey = detectApp(hint);
      if (!appKey) return undefined;
      const g = loadGuide(appKey);
      if (!g) return undefined;

      const shortcuts = g.shortcuts && Object.keys(g.shortcuts).length
        ? `Known shortcuts: ${Object.entries(g.shortcuts).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(', ')}`
        : '';
      return {
        promptFragment: [`APP: ${g.name}`, shortcuts].filter(Boolean).join('\n'),
        appName: g.app,
      };
    } catch {
      return undefined;
    }
  }

  private async recordSkill(
    task: string,
    trace: Array<{ action: PipelineAction; result: ActionResult }>,
  ): Promise<void> {
    if (trace.length === 0) return;
    try {
      const win = await this.deps.adapter.getActiveWindow();
      const appName = win?.processName;
      if (!appName) return;

      const steps = trace
        .map(t => actionToCachedStep(t.action))
        .filter((s): s is NonNullable<ReturnType<typeof actionToCachedStep>> => s !== null);

      if (steps.length > 0) this.skillCache.record(task, appName, steps);
    } catch {
      // Non-fatal — skill-cache is a perf optimization, not correctness.
    }
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

export type { TaskResult } from './types';

// ─── Private utilities ──────────────────────────────────────────────

/** 4 chars/token is the canonical Anthropic / OpenAI guidance. */
function estimateTokens(...parts: string[]): number {
  const total = parts.reduce((n, s) => n + (s?.length ?? 0), 0);
  return Math.ceil(total / 4);
}

/** Normalize a text-agent trace for the public TaskResult shape. */
function traceFor(
  trace: Array<{ action: PipelineAction; result: ActionResult }>,
): PipelineTaskResult['trace'] {
  return trace.map(t => ({ action: t.action, result: t.result, durationMs: 0 }));
}

/** Map a cached text-agent action back into a step descriptor for the
 *  skill-cache on successful runs. Returns null for actions that aren't
 *  worth caching (screenshot, cannot_read, done). */
function actionToCachedStep(action: PipelineAction): any | null {
  const src = 'pipeline.text-agent';
  switch (action.type) {
    case 'a11y_click':     return { type: 'click',  description: `a11y "${action.target}"`, producedBy: src };
    case 'a11y_set_value': return { type: 'type',   description: `set "${action.target}"`, text: action.value, producedBy: src };
    case 'click':          return { type: 'click',  description: `click @${action.x},${action.y}`, x: action.x, y: action.y, producedBy: src };
    case 'type':           return { type: 'type',   description: 'type', text: action.text, producedBy: src };
    case 'press':          return { type: 'key',    description: `press ${action.combo}`, key: action.combo, producedBy: src };
    case 'scroll':         return { type: 'scroll', description: `scroll ${action.dir}`, direction: action.dir, amount: action.amount, producedBy: src };
    case 'wait':           return { type: 'wait',   description: `wait ${action.ms}ms`, ms: action.ms, producedBy: src };
    default:               return null;
  }
}

/**
 * Synthesize a `PipelineAction` from a vision-agent step for trace reporting.
 * The vision-agent speaks its own tool vocabulary ({click, drag, ...});
 * we lossily project it into PipelineAction so the outer trace is uniform.
 * Unknown tool names become `cannot_read`-shaped markers.
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
    case 'wait':
      return { type: 'wait', ms: Number(args?.ms ?? 0) };
    case 'screenshot':
      return { type: 'screenshot' };
    case 'invoke_element':
      return { type: 'a11y_click', target: String(args?.name ?? '') };
    case 'set_field_value':
      return { type: 'a11y_set_value', target: String(args?.name ?? ''), value: String(args?.value ?? '') };
    case 'done':
      return { type: 'done', reason: String(args?.evidence ?? args?.reason ?? 'ok') };
    case 'give_up':
      return { type: 'give_up', reason: String(args?.reason ?? 'unknown') };
    default:
      return { type: 'cannot_read', reason: `unmapped vision tool: ${toolName}` };
  }
}
