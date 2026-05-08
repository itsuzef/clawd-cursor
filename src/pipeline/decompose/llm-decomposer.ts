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

export const DECOMPOSE_SYSTEM_PROMPT = `You are a task decomposer. Read the ENTIRE input first, then break the natural-language desktop task into an ordered list of concrete, atomic subtasks.

Rules:
- Use ONE concrete action per subtask string.
- "type" subtasks MUST contain the literal text to type, never an instruction.
  Bad:  "Type the user's name"
  Good: "type John Smith"
- Subtasks must be in execution order.
- No more than 8 subtasks; if you need more, the task is too complex and you should collapse steps.
- Verbs to prefer: open, focus, click, type, press, navigate, select, scroll, wait, save, send.
- Do NOT invent information the task didn't provide. If an email address or value is missing, leave the subtask at the level of "type the recipient email".

INTERPRET INDEFINITE PHRASES (CRITICAL — agents below this layer take strings literally):
- "any X" / "a random X" / "some X" means "pick a representative X yourself" — RESOLVE it into a concrete step. Do NOT pass the indefinite phrase through.
    Bad:  "open any Wikipedia page"     →   Good: "navigate to https://en.wikipedia.org/wiki/Special:Random"
    Bad:  "search for any restaurant"   →   Good: "navigate to https://www.google.com/maps/search/restaurants near me"
    Bad:  "open a random YouTube video" →   Good: "navigate to https://www.youtube.com" then "click the first recommended video"
- "the latest X" / "today's X" means "the most recent visible X" — pick the topmost / first-listed item in the relevant view. Don't ask the user.
    Bad:  "summarize the latest email"   →   Good: "open Outlook" then "click the first email in the inbox"
- "an example" / "anything" — same rule: pick something concrete and proceed.

DO NOT EMIT SCAFFOLDING STEPS the OS does for free:
- A "navigate to <url>" subtask ALREADY launches the default browser as a side effect — the OS opens whichever browser is the registered http handler. Do NOT emit a separate "open default browser" / "open Chrome" / "open Edge" step before it. That makes the agent type the literal phrase "default browser" into a search bar.
    Bad:  ["open default browser", "navigate to https://github.com"]
    Good: ["navigate to https://github.com"]
- Same applies to "open default mail client" / "open the default editor" — drop the scaffolding, the OS routes the right app.
- If the user EXPLICITLY named a browser ("open Chrome and go to github.com"), you MAY emit "open Chrome" as a step — that's a concrete app name, not scaffolding.

App-name normalization (CRITICAL — wrong app names cause launch failures):
- Use the canonical short name. Strip filler words: "app", "application",
  "browser", "window", "program", and articles ("the", "a", "an") when they
  precede a brand name.
    Bad:  "open the Outlook app"     →   Good: "open Outlook"
    Bad:  "launch Edge browser"      →   Good: "open Edge"
    Bad:  "start the calculator app" →   Good: "open Calculator"
    Bad:  "run Microsoft Word app"   →   Good: "open Microsoft Word"
- Keep brand-qualified names that the user gave you ("Microsoft Word",
  "Google Chrome") — those are the canonical alias keys, not filler.

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
