/**
 * Unified agent loop — replaces text-agent + vision-agent with ONE harness.
 *
 * Design summary:
 *   • ONE tool vocabulary built by `tools.ts` (mode-parameterized).
 *   • Perception: accessibility snapshot EVERY turn (cheap, structured).
 *     Screenshots only when:
 *       (a) mode === 'vision' (turn 1 seed), or
 *       (b) the model explicitly calls the `screenshot` tool, or
 *       (c) a screen-changing tool ran AND mode is hybrid/vision
 *           (so the model sees the result before its next turn).
 *   • LLM: native tool_use via callLLMWithTools (Anthropic tool_use / OpenAI
 *     tool_calls). JSON-from-prose fallback for providers without native support.
 *   • Safety: every tool call runs through `safety.evaluate()` BEFORE its
 *     execute() fires. Single chokepoint.
 *   • Stagnation: FingerprintHistory tracks screen state; 3 identical
 *     fingerprints = force the agent to try something different or give_up.
 *   • Streaming logs: tree-shaped turn logs via the observability logger
 *     so the user can watch what the agent is thinking/doing in real time.
 *
 * Model-agnostic + OS-agnostic by construction: provider config comes from
 * AgentLlmDeps, I/O goes through PlatformAdapter, zero `process.platform`
 * branching here.
 */

import type { ScreenshotResult } from '../../v2/platform/types';
import { FingerprintHistory } from '../sense/fingerprint';
import { captureSnapshot } from '../sense/snapshot';
import { logger, EVENTS, beginSpan } from '../observability/logger';
import { getCorrelationId } from '../observability/correlation';
import { evaluate as safetyEvaluate, isAllowed } from '../safety/layer';
import {
  callLLMWithTools,
  type LLMTool,
  type LLMToolTurn,
  type LLMUserBlock,
  type ToolUseResult,
  type LLMAssistantBlock,
} from '../../llm-client';
import { buildSystemPrompt, renderSnapshot, renderHistory, wrapUntrustedScreenContent } from './prompt';
import { buildUnifiedTools } from './tools';
import type {
  AgentInput,
  AgentLlmConfig,
  AgentLlmDeps,
  AgentResult,
  AgentStep,
  AgentToolContext,
  UnifiedTool,
  AgentExit,
  AgentMode,
} from './types';

const DEFAULT_MAX_TURNS = 20;
const STAGNATION_WINDOW = 3;
const MAX_HISTORY_SCREENSHOTS = 2;

export interface AgentDeps {
  adapter: import('../../v2/platform/types').PlatformAdapter;
  llm: AgentLlmDeps;
}

/**
 * Run the unified agent against a task.
 *
 * The function is a pure orchestrator — no side effects outside the
 * tool calls themselves. Returns an AgentResult even on failure.
 */
export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const startedAt = Date.now();
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const isAborted = input.isAborted ?? (() => false);
  const correlationId = getCorrelationId();
  const log = correlationId ? logger.with({ correlationId }) : logger;

  // Select the LLM config per mode. Vision mode REQUIRES a vision model;
  // hybrid prefers vision if available but falls back to text if not
  // (text models with tool_use still work — they just can't see pixels).
  const llmConfig = selectLlmConfig(input.mode, deps.llm);
  if (!llmConfig) {
    const text = input.mode === 'vision'
      ? 'No vision model configured. Run `clawdcursor doctor` to set AI_VISION_MODEL.'
      : 'No text model configured. Run `clawdcursor doctor` to set AI_TEXT_MODEL.';
    return earlyExit('give_up', text, startedAt);
  }

  // Set up perception state.
  const fph = new FingerprintHistory(8);
  const screenshotsCaptured = { n: 0 };

  // Cache screen size once — used for scroll center coordinates.
  let screen: AgentToolContext['screen'];
  try {
    screen = await deps.adapter.getScreenSize();
  } catch {
    screen = { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 };
  }

  // Build the tool catalog for this mode + capability. When capability is
  // set (text modes only), serves a scoped palette; vision mode always
  // collapses mouse/keyboard/window into compound tools. See
  // `buildUnifiedTools` for the selection logic.
  const tools = buildUnifiedTools(input.mode, input.capability);
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const llmTools = toUnifiedLLMTools(tools);

  const systemPrompt = buildSystemPromptWithGuide(input);

  // Seed the conversation.
  const history: LLMToolTurn[] = [];
  const steps: AgentStep[] = [];
  let llmCalls = 0;
  let activeApp: string | undefined;

  // Turn-1 perception — always an a11y snapshot. In vision mode, also a
  // screenshot. The blind mode gets text-only snapshot.
  try {
    const firstSnapshot = await captureSnapshot(deps.adapter);
    activeApp = firstSnapshot.activeWindow?.processName;
    fph.push(firstSnapshot.fingerprint);

    const snapshotText = renderSnapshot(firstSnapshot, {
      screenWidth: screen.physicalWidth,
      screenHeight: screen.physicalHeight,
      focusProcessId: firstSnapshot.activeWindow?.processId,
    });

    const initialBlocks: LLMUserBlock[] = [
      {
        type: 'text',
        text: `TASK: ${input.task}\n\nACCESSIBILITY SNAPSHOT:\n${wrapUntrustedScreenContent(snapshotText)}\n\nPICK ONE TOOL CALL.`,
      },
    ];

    if (input.mode === 'vision') {
      const shot = await deps.adapter.screenshot({ maxWidth: 1280 });
      screenshotsCaptured.n += 1;
      initialBlocks.push({ type: 'text', text: '\nINITIAL SCREENSHOT:' });
      initialBlocks.push(shotToBlock(shot));
    }

    history.push({ role: 'user', content: initialBlocks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('agent.perception.initial.failed', { error: msg });
    return earlyExit('cannot_read', `initial perception failed: ${msg}`, startedAt);
  }

  // ─── Main turn loop ─────────────────────────────────────────
  const outerSpan = beginSpan();
  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (isAborted()) return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);

      log.info(EVENTS.AGENT_TURN_START, { turn, mode: input.mode, historyTurns: history.length });
      const turnStart = Date.now();

      // 1. Call the LLM with tools.
      let llmResult: ToolUseResult;
      try {
        llmResult = await callLLMWithTools({
          baseUrl: llmConfig.baseUrl,
          model: llmConfig.model,
          apiKey: llmConfig.apiKey,
          isAnthropic: llmConfig.isAnthropic,
          system: systemPrompt,
          tools: llmTools,
          messages: history,
          maxTokens: llmConfig.maxTokens ?? 1024,
          timeoutMs: 45_000,
          toolChoice: 'auto',
        });
        llmCalls += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('agent.llm.failed', { turn, error: msg });
        return finish('llm_error', `LLM call failed: ${msg}`, steps, llmCalls, screenshotsCaptured.n, startedAt);
      }

      // 2. Log the agent's thinking, if any.
      if (llmResult.text && llmResult.text.trim()) {
        log.info(EVENTS.AGENT_THINK, { turn, text: truncate(llmResult.text.trim(), 160) });
      }

      // 3. Record the assistant turn in history so the next turn sees it.
      history.push({ role: 'assistant', content: llmResult.raw });

      // 4. No tool call → treat as parse failure (re-prompt once).
      if (llmResult.toolCalls.length === 0) {
        log.warn('agent.no_tool_call', { turn, stopReason: llmResult.stopReason, text: truncate(llmResult.text, 200) });
        history.push({
          role: 'user',
          content: [{ type: 'text', text: 'You must call exactly one tool per turn. Try again with a tool call.' }],
        });
        steps.push({
          turn,
          toolName: '(no-tool)',
          toolArgs: {},
          result: { success: false, text: llmResult.text.slice(0, 200) || '(empty response)' },
          durationMs: Date.now() - turnStart,
          fingerprintChanged: false,
          thought: llmResult.text,
        });
        continue;
      }

      // 5. Process every tool call the model emitted this turn. Most
      //    models return exactly one; if more, we process them in order
      //    and all results flow back on the next turn.
      const toolResults: Array<{ id: string; text: string; isError: boolean; screenshot?: ScreenshotResult; stop?: boolean; terminalExit?: AgentExit }> = [];
      let terminal: { exit: AgentExit; text: string } | null = null;

      for (const call of llmResult.toolCalls) {
        if (isAborted()) return finish('aborted', 'aborted by user', steps, llmCalls, screenshotsCaptured.n, startedAt);

        const tool = toolMap.get(call.name);
        if (!tool) {
          log.warn('agent.unknown_tool', { turn, tool: call.name });
          toolResults.push({
            id: call.id,
            text: `Unknown tool "${call.name}". Available: ${tools.map(t => t.name).join(', ')}`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: 'unknown tool' },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        const targetLabel = typeof call.args.name === 'string' ? call.args.name
          : typeof call.args.target === 'string' ? call.args.target
          : undefined;

        // 5a. Safety gate — single chokepoint.
        const decision = safetyEvaluate({
          tool: call.name,
          args: call.args,
          targetLabel,
          activeApp,
        });
        if (!isAllowed(decision)) {
          const reason = decision.decision === 'block'
            ? decision.reason
            : `requires ${decision.decision}: ${decision.tier}`;
          log.info('agent.tool.blocked', { turn, tool: call.name, decision: decision.decision, reason });
          toolResults.push({
            id: call.id,
            text: `[${decision.decision}] ${reason}`,
            isError: true,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: { success: false, text: `safety_${decision.decision}: ${reason}` },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          continue;
        }

        // 5a' v0.8.3 RUNAWAY GUARD. If the agent has issued the SAME
        // tool+args combination more than REPEAT_THRESHOLD times in the
        // last REPEAT_WINDOW turns, force-exit with `give_up`. This is the
        // fix for the "Outlook keeps opening" class of bug — when the
        // agent can't see the result of its own action (sparse WebView2
        // a11y, for example) it sometimes re-issues the same action every
        // turn. Platform-level idempotency on open_app already prevents
        // duplicate Outlook windows; this guard protects against the same
        // anti-pattern generalized to every tool.
        const REPEAT_THRESHOLD = 3;
        const REPEAT_WINDOW = 6;
        const argKey = JSON.stringify(call.args ?? {});
        const recentRepeats = steps
          .slice(-REPEAT_WINDOW)
          .filter(s => s.toolName === call.name && JSON.stringify(s.toolArgs ?? {}) === argKey)
          .length;
        if (recentRepeats >= REPEAT_THRESHOLD) {
          log.warn('agent.runaway_guard', {
            turn, tool: call.name, repeats: recentRepeats, window: REPEAT_WINDOW,
          });
          steps.push({
            turn,
            toolName: call.name,
            toolArgs: call.args,
            result: {
              success: false,
              text: `runaway-guard: ${call.name} called ${recentRepeats} times in last ${REPEAT_WINDOW} turns with same args — aborting to prevent infinite loop`,
            },
            durationMs: Date.now() - turnStart,
            fingerprintChanged: false,
            thought: llmResult.text,
          });
          return finish(
            'give_up',
            `runaway-guard: repeated ${call.name} with identical args (${recentRepeats}× in last ${REPEAT_WINDOW} turns). The agent is likely unable to see whether the action succeeded — try a different approach or use detect_webview_apps + CDP bridge if the target is an Electron/WebView2 app.`,
            steps, llmCalls, screenshotsCaptured.n, startedAt,
          );
        }

        // 5a''. cannot_read soft-guard. cannot_read is meant for genuinely
        // unreadable screens (CAPTCHA, blank canvas, OCR garbage). Some models
        // — especially safety-trained text models on irreversible actions like
        // "Send" — try to use it as a "can I have a moment to think" pause AFTER
        // they already located an interactive target. That stalls the pipeline
        // for no good reason. If a perception/locator tool succeeded in the
        // last few turns, refuse cannot_read and tell the model to act on what
        // it already found. Pattern-based; doesn't care which model is asking.
        if (call.name === 'cannot_read') {
          const LOOKBACK = 4;
          const RESOLVERS = new Set([
            'wait_for_element', 'find_element', 'invoke_element', 'set_field_value',
            'read_screen', 'a11y_snapshot', 'screenshot',
            'list_windows', 'focus_window',
          ]);
          const recentSuccessfulResolution = steps
            .slice(-LOOKBACK)
            .some(s => RESOLVERS.has(s.toolName) && s.result.success);
          if (recentSuccessfulResolution) {
            log.info('agent.cannot_read.suppressed', {
              turn, reason: 'recent successful element resolution within lookback',
              lookback: LOOKBACK,
            });
            toolResults.push({
              id: call.id,
              text: 'cannot_read refused: a recent perception/locator tool succeeded in this run, so the screen IS readable. Act on what you already located (invoke_element / mouse_click / key) instead. cannot_read is for blank/garbled screens only.',
              isError: true,
            });
            steps.push({
              turn,
              toolName: call.name,
              toolArgs: call.args,
              result: { success: false, text: 'cannot_read suppressed (perception just succeeded)' },
              durationMs: Date.now() - turnStart,
              fingerprintChanged: false,
              thought: llmResult.text,
            });
            continue;
          }
        }

        // 5b. Log and execute.
        log.info(EVENTS.AGENT_TOOL_CALL, { turn, tool: call.name, args: compactArgs(call.args) });
        const toolStart = Date.now();
        const ctx: AgentToolContext = {
          platform: deps.adapter,
          task: input.task,
          mode: input.mode,
          screen,
          screenshotsCaptured,
          activeApp,
        };

        let result: Awaited<ReturnType<UnifiedTool['execute']>>;
        try {
          result = await tool.execute(call.args, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { success: false, text: `tool threw: ${msg}` };
        }

        const toolMs = Date.now() - toolStart;
        log.info(EVENTS.AGENT_TOOL_RESULT, {
          turn,
          tool: call.name,
          success: result.success,
          ms: toolMs,
          text: truncate(result.text, 120),
        });

        // 5c. Re-capture perception if the tool changed the screen. We do
        // this AFTER the tool, BEFORE stagnation detection.
        let postSnapshot: Awaited<ReturnType<typeof captureSnapshot>> | null = null;
        if (tool.changesScreen) {
          try {
            postSnapshot = await captureSnapshot(deps.adapter);
            activeApp = postSnapshot.activeWindow?.processName ?? activeApp;
          } catch {
            postSnapshot = null;
          }
        }

        const fingerprintChanged = postSnapshot ? fph.getHistory().slice(-1)[0] !== postSnapshot.fingerprint : false;
        if (postSnapshot) fph.push(postSnapshot.fingerprint);

        steps.push({
          turn,
          toolName: call.name,
          toolArgs: call.args,
          result: { success: result.success, text: result.text },
          durationMs: toolMs,
          fingerprintChanged,
          thought: llmResult.text,
        });

        toolResults.push({
          id: call.id,
          text: result.text,
          isError: !result.success,
          screenshot: result.screenshot,
          stop: result.stop,
          terminalExit: result.terminalExit,
        });

        // Terminal action → wrap up after this turn.
        if (result.stop && result.terminalExit) {
          terminal = { exit: result.terminalExit, text: result.text };
          break;
        }
      }

      // 6. Build next-turn user payload: tool_result blocks + fresh
      //    perception + (for hybrid/vision) optional screenshot of the
      //    post-action state.
      const nextBlocks: LLMUserBlock[] = [];

      // 6a. tool_result blocks preserve the Anthropic contract and feed
      //     OpenAI's `tool` messages when we normalize in llm-client.
      for (const tr of toolResults) {
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [
          { type: 'text', text: tr.text },
        ];
        if (tr.screenshot && (input.mode === 'hybrid' || input.mode === 'vision')) {
          content.push(shotToInnerBlock(tr.screenshot));
        }
        nextBlocks.push({ type: 'tool_result', tool_use_id: tr.id, content, is_error: tr.isError });
      }

      // 6b. If any tool changed the screen, append a fresh snapshot for
      //     the next turn. This is the "per-turn refresh" the old
      //     vision-agent lacked.
      const anyChanged = toolResults.some(r => !!r.screenshot) || steps[steps.length - 1]?.fingerprintChanged;
      if (anyChanged || toolResults.length > 0) {
        try {
          const snap = await captureSnapshot(deps.adapter);
          activeApp = snap.activeWindow?.processName ?? activeApp;
          const snapText = renderSnapshot(snap, {
            screenWidth: screen.physicalWidth,
            screenHeight: screen.physicalHeight,
            focusProcessId: snap.activeWindow?.processId,
          });
          nextBlocks.push({
            type: 'text',
            text: `\nFRESH ACCESSIBILITY SNAPSHOT:\n${wrapUntrustedScreenContent(snapText)}`,
          });
          nextBlocks.push({
            type: 'text',
            text: `\nRECENT ACTIONS:\n${renderHistory(steps, 6)}`,
          });
        } catch {
          nextBlocks.push({
            type: 'text',
            text: '\n(perception refresh failed — rely on tool results above)',
          });
        }
      }

      // 6c. Stagnation check — force the agent to change approach if the
      //     same fingerprint has repeated. We do this AFTER the history
      //     is updated so the model can see it.
      if (fph.isStagnant(STAGNATION_WINDOW)) {
        log.warn(EVENTS.AGENT_STAGNATION, {
          turn,
          window: STAGNATION_WINDOW,
          fingerprint: fph.getHistory().slice(-1)[0],
        });
        nextBlocks.push({
          type: 'text',
          text: `\n⚠ STAGNATION: the last ${STAGNATION_WINDOW} actions did not change the screen. Try a DIFFERENT approach (keyboard shortcut, different target, wait, list_windows to check focus) or give_up with a reason.`,
        });
      }

      history.push({ role: 'user', content: nextBlocks });

      // 7. Trim old screenshots to stay under the token budget.
      trimOldScreenshots(history, MAX_HISTORY_SCREENSHOTS);

      const turnMs = Date.now() - turnStart;
      log.info(EVENTS.AGENT_TURN_END, {
        turn,
        ms: turnMs,
        tools: toolResults.length,
        changed: !!anyChanged,
      });

      if (terminal) {
        return finish(terminal.exit, terminal.text, steps, llmCalls, screenshotsCaptured.n, startedAt);
      }
    }
  } finally {
    outerSpan.end();
  }

  return finish('max_turns', `hit max turns (${maxTurns}) without a terminal action`, steps, llmCalls, screenshotsCaptured.n, startedAt);
}

// ─── Helpers ────────────────────────────────────────────────────────

function selectLlmConfig(mode: AgentMode, llm: AgentLlmDeps): AgentLlmConfig | undefined {
  if (mode === 'vision') return llm.vision;
  // blind/hybrid: prefer text, fall back to vision if text isn't there
  // (vision models can still drive tool_use without images).
  return llm.text || llm.vision;
}

function buildSystemPromptWithGuide(input: AgentInput): string {
  const base = buildSystemPrompt(input.mode);
  if (!input.guide) return base;
  return `${base}\n\n--- APP KNOWLEDGE (from bundled guide / user override) ---\n${input.guide.promptFragment}`;
}

function toUnifiedLLMTools(tools: UnifiedTool[]): LLMTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  // Deep-safe compact — strings over 60 chars are truncated for logs.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 60) out[k] = v.slice(0, 57) + '…';
    else out[k] = v;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function shotToBlock(shot: ScreenshotResult): LLMUserBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: shot.buffer.toString('base64') },
  };
}

function shotToInnerBlock(shot: ScreenshotResult): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: shot.buffer.toString('base64') },
  };
}

/**
 * Remove image content from all but the most recent N user turns. Keeps
 * the agent in budget when many screenshots accumulate.
 */
function trimOldScreenshots(history: LLMToolTurn[], keepLast: number): void {
  const imageTurnIndices: number[] = [];
  history.forEach((turn, i) => {
    if (Array.isArray(turn.content)) {
      const hasImage = (turn.content as any[]).some(
        b => b.type === 'image' || b.type === 'image_url' ||
             (b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c: any) => c.type === 'image')),
      );
      if (hasImage) imageTurnIndices.push(i);
    }
  });

  if (imageTurnIndices.length <= keepLast) return;

  const dropSet = new Set(imageTurnIndices.slice(0, imageTurnIndices.length - keepLast));
  for (const i of dropSet) {
    const turn = history[i];
    if (!Array.isArray(turn.content)) continue;
    turn.content = (turn.content as any[]).map(b => {
      if (b.type === 'image' || b.type === 'image_url') {
        return { type: 'text', text: '[earlier screenshot removed to save tokens]' };
      }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        b.content = b.content.map((c: any) =>
          c.type === 'image' ? { type: 'text', text: '[earlier tool screenshot removed]' } : c,
        );
        return b;
      }
      return b;
    }) as any;
  }
}

function finish(
  exit: AgentExit,
  text: string,
  steps: AgentStep[],
  llmCalls: number,
  screenshotsCaptured: number,
  startedAt: number,
): AgentResult {
  return {
    success: exit === 'done',
    exit,
    text,
    steps,
    llmCalls,
    screenshotsCaptured,
    durationMs: Date.now() - startedAt,
  };
}

function earlyExit(exit: AgentExit, text: string, startedAt: number): AgentResult {
  return {
    success: exit === 'done',
    exit,
    text,
    steps: [],
    llmCalls: 0,
    screenshotsCaptured: 0,
    durationMs: Date.now() - startedAt,
  };
}
