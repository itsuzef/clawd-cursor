/**
 * LLM task decomposer — fallback when the offline parser returns null.
 *
 * Ported from src/ai-brain.ts::decomposeTask + DECOMPOSE_SYSTEM_PROMPT.
 * Pure text LLM call, no screenshots, no tool calls. One input/output round.
 *
 * v0.8.1 scaffold: exposes a clean interface the pipeline can wire. The
 * actual LLM call is injected — the text-agent's LLM client and this
 * module's client share infrastructure. Keeps this file pure/testable.
 */

export const DECOMPOSE_SYSTEM_PROMPT = `You are a task decomposer. Break a natural-language desktop task into an ordered list of concrete, atomic subtasks.

Rules:
- Use ONE concrete action per subtask string.
- "type" subtasks MUST contain the literal text to type, never an instruction.
  Bad:  "Type the user's name"
  Good: "type John Smith"
- Subtasks must be in execution order.
- No more than 8 subtasks; if you need more, the task is too complex and you should collapse steps.
- Verbs to prefer: open, focus, click, type, press, navigate, select, scroll, wait, save, send.
- Do NOT invent information the task didn't provide. If an email address or value is missing, leave the subtask at the level of "type the recipient email".

Output FORMAT — JSON only, no prose:
{ "subtasks": ["...", "..."] }`;

export interface LlmDecomposerDeps {
  /**
   * Text-only LLM call. Returns the raw model output. Caller is responsible
   * for retries and timeouts — this module just composes the prompt and parses.
   */
  callTextLlm: (systemPrompt: string, userPrompt: string, opts?: { maxTokens?: number }) => Promise<string>;
}

/** Extracts the first JSON object from a possibly-messy LLM response. */
export function extractJson(raw: string): unknown | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Decompose via LLM. Returns the subtasks array on success, null when the
 * response can't be parsed or is empty (caller falls through to one-shot
 * text-agent).
 */
export async function decomposeWithLlm(
  task: string,
  deps: LlmDecomposerDeps,
): Promise<string[] | null> {
  const raw = await deps.callTextLlm(DECOMPOSE_SYSTEM_PROMPT, task, { maxTokens: 400 });
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const subtasks = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(subtasks)) return null;
  const filtered = subtasks.filter(s => typeof s === 'string' && s.trim().length > 0).map(s => (s as string).trim());
  return filtered.length > 0 ? filtered : null;
}
