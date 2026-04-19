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
}

export const PIPELINE_DEFAULTS: Required<Pick<PipelineDeps, 'disableVision' | 'maxTurnsPerRung' | 'maxEscalations'>> = {
  disableVision: false,
  maxTurnsPerRung: 20,
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
  private readonly disableVision: boolean;
  private readonly maxTurnsPerRung: number;
  private readonly maxEscalations: number;

  constructor(private readonly deps: PipelineDeps) {
    this.router = new Router(deps.adapter);
    this.skillCache = new SkillCache();
    this.disableVision = deps.disableVision ?? PIPELINE_DEFAULTS.disableVision;
    this.maxTurnsPerRung = deps.maxTurnsPerRung ?? PIPELINE_DEFAULTS.maxTurnsPerRung;
    this.maxEscalations = deps.maxEscalations ?? PIPELINE_DEFAULTS.maxEscalations;
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
        subtasks: outerDecision.subtasks.length,
      });

      const subtasks = outerDecision.subtasks.length > 0
        ? outerDecision.subtasks
        : [input.task];

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
   */
  private async runOneSubtask(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
  ): Promise<StrategyResult> {
    const ladder = this.buildLadder(decision.strategy);
    env.log.debug('pipeline.ladder', { ladder, strategy: decision.strategy });

    let last: StrategyResult = {
      success: false, path: 'text-agent',
      text: 'no strategies tried', failureReason: 'no_ladder',
    };
    let rungsTried = 0;

    for (const rung of ladder) {
      if (env.isAborted()) {
        return { success: false, path: last.path, text: 'aborted', failureReason: 'aborted' };
      }
      if (rungsTried >= this.maxEscalations) break;
      rungsTried++;

      env.log.info(EVENTS.PIPELINE_RUNG, { strategy: rung, attempt: rungsTried });

      const attempt = await this.executeStrategy(rung, task, decision, env);
      last = attempt;
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
  ): Promise<StrategyResult> {
    switch (strategy) {
      case 'router':  return this.runRouter(task, env);
      case 'blind':   return this.runUnifiedAgent(task, decision, env, 'blind');
      case 'hybrid':  return this.runUnifiedAgent(task, decision, env, 'hybrid');
      case 'vision':  return this.runUnifiedAgent(task, decision, env, 'vision');
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
   */
  private async runUnifiedAgent(
    task: string,
    decision: ReturnType<typeof preprocess>,
    env: StrategyEnv,
    mode: AgentMode,
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
        maxTurns: this.maxTurnsPerRung,
        isAborted: env.isAborted,
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
