/**
 * Agent v2 — Unified tool-calling agent for clawdcursor v0.8.0
 *
 * One loop. Same 40 tools that serve/mcp expose.
 * The model sees the screen, picks a tool, we execute it, repeat.
 *
 * Supports Anthropic (native tool_use) and OpenAI-compat (function calling).
 * No preprocessor. No decomposer. No classifier. No separate vision fallback.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { getAllTools, getTool, toOpenAiFunctions } from './tools';
import type { ToolContext, ToolResult, ToolDefinition } from './tools';
import type { PipelineConfig } from './providers';
import { LLMAuthError, LLMBillingError, LLMError } from './llm-client';
import type { StepResult, TaskResult } from './types';

const IS_MAC = os.platform() === 'darwin';
const IS_WIN = os.platform() === 'win32';
const PLATFORM = IS_MAC ? 'macOS' : IS_WIN ? 'Windows' : 'Linux';

// ── Limits ──────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 25;         // max tool calls per task
const MAX_CONTEXT_MESSAGES = 30;   // evict old messages beyond this
const STAGNATION_LIMIT = 3;        // bail after N identical consecutive results
const LLM_TIMEOUT_MS = 45_000;     // per-call timeout

// ── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ClawdCursor, a desktop automation agent on ${PLATFORM}.
You have tools to control this computer. Use them to complete the user's task.

## Workflow
1. Call smart_read ONCE to orient yourself
2. Then BATCH all your actions — call multiple tools in ONE response
3. Only smart_read again if something unexpected happened
4. When done, say DONE immediately — do NOT verify unless the task specifically asks

## Tool Preferences (fastest → slowest)
- smart_read → structured screen text (preferred for reading)
- smart_click → click by element text (preferred for clicking)
- smart_type → type into a field by name (preferred for typing)
- key_press → keyboard shortcuts (preferred for navigation)
- shortcuts_list/shortcuts_execute → discover and use app shortcuts
- desktop_screenshot → visual confirmation (use when smart_read isn't enough)
- mouse_click → click by coordinates (only when smart_click can't find the element)
- find_element → search for specific UI elements by name/type
- read_screen → full accessibility tree (verbose, use smart_read first)

## SPEED RULES (critical)
- BATCH multiple tool calls in ONE response whenever possible
- Example: open_app + wait + smart_type + key_press → all in ONE response
- Do NOT call smart_read between every action — only read when you need to see something new
- Do NOT verify completion unless the task explicitly requires it
- After open_app, include a wait(seconds=1) in the SAME batch, then continue acting
- Prefer key_press shortcuts over smart_click for menus (faster)
- If smart_click fails, try desktop_screenshot + mouse_click (coordinates)
- Never repeat a failed action — try a different approach
- If stuck 3 times, say BLOCKED

## File Save Dialogs (Windows)
- To save a file: use key_press("ctrl+s") for Save, or key_press("ctrl+shift+s") for Save As
- In the Save As dialog, the filename field is already focused — just type_text the FULL path (e.g. "C:\\tmp\\file.txt") and press Enter
- Do NOT try to navigate folders by clicking — type the full path directly in the filename field
- If a "confirm overwrite" dialog appears, smart_click "Yes" or key_press "Return"

## Completion
When the task is done, respond with text starting with "DONE:" — no extra verification needed.
If blocked, respond with "BLOCKED:" and what's wrong.
Be FAST. A simple open-type-save should be 3-5 tool calls total, not 20.`;

// ── Types ───────────────────────────────────────────────────────────────────

interface AgentV2Config {
  pipelineConfig: PipelineConfig;
  toolCtx: ToolContext;
  debugDir?: string | null;
  onStep?: (step: StepResult) => void;
}

export interface AgentV2Result {
  success: boolean;
  steps: StepResult[];
  llmCalls: number;
  duration: number;
  message: string;
}

// ── Anthropic types ─────────────────────────────────────────────────────────

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

// ── Main agent ──────────────────────────────────────────────────────────────

export class AgentV2 {
  private config: AgentV2Config;
  private tools: ToolDefinition[];
  private isAnthropic: boolean;

  constructor(config: AgentV2Config) {
    this.config = config;
    // Filter out delegate_to_agent (would recurse) and get all available tools
    this.tools = getAllTools().filter(t => t.name !== 'delegate_to_agent');
    this.isAnthropic = !config.pipelineConfig.provider.openaiCompat
      && !config.pipelineConfig.layer2.baseUrl.includes('localhost')
      && !config.pipelineConfig.layer2.baseUrl.includes('11434');
  }

  async executeTask(task: string): Promise<AgentV2Result> {
    const startTime = Date.now();
    const steps: StepResult[] = [];
    let llmCalls = 0;

    // Pick the best model available — vision model preferred (can see screenshots)
    const modelConfig = this.getModelConfig();
    const toolSchemas = this.buildToolSchemas();

    console.log(`\n🐾 [v2] Task: "${task}"`);
    console.log(`   Model: ${modelConfig.model} (${this.isAnthropic ? 'Anthropic' : 'OpenAI-compat'})`);
    console.log(`   Tools: ${this.tools.length}`);

    // Messages array — we'll manage context window by eviction
    const messages: any[] = [];
    const addUserMessage = (content: any) => messages.push({ role: 'user', content });

    addUserMessage(task);

    const recentResults: string[] = [];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // ── Context window management ──
      if (messages.length > MAX_CONTEXT_MESSAGES) {
        this.evictOldMessages(messages, task);
      }

      // ── Call LLM ──
      llmCalls++;
      let response: LLMResponse;
      try {
        response = await this.callLLM(messages, toolSchemas, modelConfig);
      } catch (err) {
        if (err instanceof LLMAuthError || err instanceof LLMBillingError) {
          const msg = `API error: ${err.message}`;
          steps.push({ action: 'error', description: msg, success: false, timestamp: Date.now() });
          return { success: false, steps, llmCalls, duration: Date.now() - startTime, message: msg };
        }
        console.warn(`   ⚠️ LLM call failed: ${err}`);
        steps.push({ action: 'error', description: `LLM error: ${err}`, success: false, timestamp: Date.now() });
        // Retry once after a brief pause
        if (i < MAX_ITERATIONS - 1) {
          await this.delay(2000);
          continue;
        }
        return { success: false, steps, llmCalls, duration: Date.now() - startTime, message: `LLM failed: ${err}` };
      }

      // ── Check for text-only response (done or blocked) ──
      if (response.text && response.toolCalls.length === 0) {
        const text = response.text.trim();
        const isDone = /^DONE:/i.test(text);
        const isBlocked = /^BLOCKED:/i.test(text);

        if (isDone) {
          const msg = text.replace(/^DONE:\s*/i, '');
          console.log(`   ✅ ${msg}`);
          steps.push({ action: 'done', description: msg, success: true, timestamp: Date.now() });
          return { success: true, steps, llmCalls, duration: Date.now() - startTime, message: msg };
        }
        if (isBlocked) {
          const msg = text.replace(/^BLOCKED:\s*/i, '');
          console.log(`   🚫 ${msg}`);
          steps.push({ action: 'blocked', description: msg, success: false, timestamp: Date.now() });
          return { success: false, steps, llmCalls, duration: Date.now() - startTime, message: msg };
        }

        // Model responded with text but no DONE/BLOCKED — nudge it
        this.appendAssistantMessage(messages, response);
        addUserMessage('Continue with the task. Use tools to interact with the desktop. When done, start your message with "DONE:"');
        continue;
      }

      // ── Execute tool calls ──
      this.appendAssistantMessage(messages, response);

      // Collect all tool results for this turn (Anthropic needs them in one message)
      const toolResults: Array<{ toolCall: ToolCallInfo; result: ToolResult }> = [];

      for (const toolCall of response.toolCalls) {
        const tool = getTool(toolCall.name);
        if (!tool) {
          const errMsg = `Unknown tool: ${toolCall.name}`;
          console.warn(`   ❌ ${errMsg}`);
          toolResults.push({ toolCall, result: { text: errMsg, isError: true } });
          steps.push({ action: toolCall.name, description: errMsg, success: false, timestamp: Date.now() });
          continue;
        }

        // Execute the tool
        const toolStart = Date.now();
        let result: ToolResult;
        try {
          await this.config.toolCtx.ensureInitialized();
          result = await tool.handler(toolCall.args, this.config.toolCtx);
        } catch (err) {
          result = { text: `Error executing ${toolCall.name}: ${String(err).substring(0, 200)}`, isError: true };
        }
        const toolDuration = Date.now() - toolStart;

        const desc = `${toolCall.name}(${this.summarizeArgs(toolCall.args)}) → ${result.text.substring(0, 120)}`;
        const success = !result.isError;
        console.log(`   ${success ? '✓' : '✗'} ${desc} (${toolDuration}ms)`);

        steps.push({
          action: toolCall.name,
          description: desc,
          success,
          timestamp: Date.now(),
          latencyMs: toolDuration,
        });
        this.config.onStep?.(steps[steps.length - 1]);
        toolResults.push({ toolCall, result });

        // ── Stagnation detection ──
        const resultKey = `${toolCall.name}:${result.text.substring(0, 100)}`;
        recentResults.push(resultKey);
        if (recentResults.length > STAGNATION_LIMIT) recentResults.shift();
        if (recentResults.length === STAGNATION_LIMIT && recentResults.every(r => r === recentResults[0])) {
          console.warn(`   ⚠️ Stagnation detected — same result ${STAGNATION_LIMIT} times`);
          // Add warning as text in the last tool result
          toolResults[toolResults.length - 1].result = {
            text: toolResults[toolResults.length - 1].result.text +
              `\n\nWARNING: You have repeated the same action ${STAGNATION_LIMIT} times with the same result. Try a completely different approach, or report BLOCKED if the task cannot be completed.`,
          };
          recentResults.length = 0;
        }

        // Brief settle after UI-changing actions
        if (['smart_click', 'mouse_click', 'key_press', 'type_text', 'smart_type',
             'mouse_double_click', 'mouse_right_click', 'shortcuts_execute',
             'invoke_element', 'open_app'].includes(toolCall.name)) {
          await this.delay(300);
        }

        // Save debug screenshots
        if (this.config.debugDir && result.image) {
          const imgPath = path.join(this.config.debugDir, `step-${i}-${toolCall.name}.jpg`);
          try {
            fs.writeFileSync(imgPath, Buffer.from(result.image.data, 'base64'));
          } catch { /* non-fatal */ }
        }
      }

      // Append all tool results to messages at once
      this.appendToolResults(messages, toolResults);
    }

    // Hit iteration limit
    const msg = `Reached maximum ${MAX_ITERATIONS} iterations`;
    console.warn(`   ⚠️ ${msg}`);
    steps.push({ action: 'timeout', description: msg, success: false, timestamp: Date.now() });
    return { success: false, steps, llmCalls, duration: Date.now() - startTime, message: msg };
  }

  // ── LLM Calling ────────────────────────────────────────────────────────────

  private getModelConfig() {
    const pc = this.config.pipelineConfig;
    // Prefer vision model (can see screenshots), fall back to text model
    const useVision = pc.layer3?.enabled && pc.layer3?.model;
    return {
      model: useVision ? pc.layer3.model : pc.layer2.model,
      baseUrl: useVision ? pc.layer3.baseUrl : pc.layer2.baseUrl,
      apiKey: useVision ? (pc.layer3.apiKey || pc.apiKey) : pc.apiKey,
    };
  }

  private buildToolSchemas(): any[] {
    if (this.isAnthropic) {
      // Anthropic format: { name, description, input_schema }
      return this.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: this.toolToJsonSchema(t),
      }));
    } else {
      // OpenAI format (already provided by toOpenAiFunctions)
      return toOpenAiFunctions(this.tools);
    }
  }

  private toolToJsonSchema(t: ToolDefinition): Record<string, any> {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const [name, def] of Object.entries(t.parameters)) {
      properties[name] = {
        type: def.type,
        description: def.description,
        ...(def.enum ? { enum: def.enum } : {}),
      };
      if (def.required !== false) required.push(name);
    }
    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  private async callLLM(messages: any[], toolSchemas: any[], modelConfig: { model: string; baseUrl: string; apiKey: string }): Promise<LLMResponse> {
    const pc = this.config.pipelineConfig;
    const authHeaders: Record<string, string> = this.isAnthropic
      ? { 'x-api-key': modelConfig.apiKey, 'anthropic-version': '2023-06-01' }
      : modelConfig.apiKey
        ? { 'Authorization': `Bearer ${modelConfig.apiKey}` }
        : {};

    // Add provider-specific extra headers
    if (pc.provider.extraHeaders) {
      Object.assign(authHeaders, pc.provider.extraHeaders);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      if (this.isAnthropic) {
        return await this.callAnthropic(messages, toolSchemas, modelConfig, authHeaders, controller.signal);
      } else {
        return await this.callOpenAI(messages, toolSchemas, modelConfig, authHeaders, controller.signal);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callAnthropic(
    messages: any[],
    tools: AnthropicTool[],
    modelConfig: { model: string; baseUrl: string },
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    const body = {
      model: modelConfig.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools,
    };

    const bodyStr = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetch(`${modelConfig.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: bodyStr,
        signal,
      });
    } catch (fetchErr: any) {
      throw new LLMError(`Fetch failed: ${fetchErr.message}`);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) throw new LLMAuthError(`Auth failed (401)`);
      if (response.status === 402) throw new LLMBillingError(`Credits exhausted (402)`);
      throw new LLMError(`API error (${response.status}): ${errBody.substring(0, 300)}`);
    }

    const data = await response.json() as any;
    if (data.error) throw new LLMError(data.error.message);

    // Parse Anthropic response: content blocks can be text or tool_use
    const text = (data.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    const toolCalls = (data.content || [])
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => ({
        id: b.id,
        name: b.name,
        args: b.input || {},
      }));

    return { text, toolCalls, raw: data };
  }

  private async callOpenAI(
    messages: any[],
    tools: any[],
    modelConfig: { model: string; baseUrl: string },
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    const body: Record<string, any> = {
      model: modelConfig.model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
      tools,
    };
    // Some models don't support temperature 0
    if (!modelConfig.model.startsWith('kimi-k2')) {
      body.temperature = 0;
    }

    const response = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) throw new LLMAuthError(`Auth failed (401)`);
      if (response.status === 402) throw new LLMBillingError(`Credits exhausted (402)`);
      throw new LLMError(`API error (${response.status}): ${errBody.substring(0, 200)}`);
    }

    const data = await response.json() as any;
    if (data.error) throw new LLMError(data.error.message);

    const msg = data.choices?.[0]?.message;
    const text = msg?.content || '';
    const toolCalls = (msg?.tool_calls || []).map((tc: any) => {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* malformed */ }
      return {
        id: tc.id,
        name: tc.function?.name,
        args,
      };
    });

    return { text, toolCalls, raw: data };
  }

  // ── Message Management ─────────────────────────────────────────────────────

  private appendAssistantMessage(messages: any[], response: LLMResponse) {
    if (this.isAnthropic) {
      // Anthropic: reconstruct the content blocks
      const content: any[] = [];
      if (response.text) content.push({ type: 'text', text: response.text });
      for (const tc of response.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      messages.push({ role: 'assistant', content });
    } else {
      // OpenAI: standard format
      const msg: any = { role: 'assistant', content: response.text || null };
      if (response.toolCalls.length > 0) {
        msg.tool_calls = response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      // Preserve reasoning_content for providers with thinking mode
      if (response.raw?.choices?.[0]?.message?.reasoning_content !== undefined) {
        msg.reasoning_content = response.raw.choices[0].message.reasoning_content;
      }
      messages.push(msg);
    }
  }

  private appendToolResults(messages: any[], results: Array<{ toolCall: ToolCallInfo; result: ToolResult }>) {
    if (this.isAnthropic) {
      // Anthropic: ALL tool results for one turn must be in ONE user message
      const contentBlocks: any[] = [];
      for (const { toolCall, result } of results) {
        const innerContent: any[] = [];
        if (result.image) {
          innerContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: result.image.mimeType || 'image/jpeg',
              data: result.image.data,
            },
          });
        }
        innerContent.push({ type: 'text', text: result.text });
        contentBlocks.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: innerContent,
        });
      }
      messages.push({ role: 'user', content: contentBlocks });
    } else {
      // OpenAI: each tool result is a separate message
      for (const { toolCall, result } of results) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.text,
        });
        // For images, add a follow-up user message
        if (result.image) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${result.image.mimeType || 'image/jpeg'};base64,${result.image.data}`,
                  detail: 'low',
                },
              },
              { type: 'text', text: `[Screenshot from ${toolCall.name}]` },
            ],
          });
        }
      }
    }
  }

  private evictOldMessages(messages: any[], task: string) {
    // Keep first message (task) + last N messages
    const keepLast = MAX_CONTEXT_MESSAGES - 2;
    const kept = messages.slice(-keepLast);
    messages.length = 0;
    messages.push({ role: 'user', content: `[Context refreshed — original task: "${task}"]\nContinue from where you left off. Call smart_read to see the current screen state.` });
    messages.push(...kept);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private summarizeArgs(args: Record<string, any>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      const val = typeof v === 'string' ? `"${v.substring(0, 40)}"` : String(v);
      parts.push(`${k}=${val}`);
    }
    return parts.join(', ').substring(0, 100);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ── Response types ──────────────────────────────────────────────────────────

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, any>;
}

interface LLMResponse {
  text: string;
  toolCalls: ToolCallInfo[];
  raw?: any;
}
