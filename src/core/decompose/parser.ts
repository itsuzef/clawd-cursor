/**
 * Offline task decomposer — regex + quote-aware compound split.
 *
 * Ported from src/local-parser.ts. Zero LLM calls, zero dependencies. Returns
 * the task split into subtask strings, or null when the task is too ambiguous
 * to split safely (caller falls back to the LLM decomposer).
 *
 * v0.6.3 product knowledge preserved:
 *   - The `actionVerb` validator is the guard against dangerous splits like
 *     "scroll through and read" where one half lacks a terminal condition and
 *     would infinite-loop the text-agent.
 *   - Quote-aware splitter so "send 'hello, world' to Bob" isn't broken.
 */

export interface DecomposeResult {
  subtasks: string[];
  /** True when the parser chose to keep the task as one unit despite
   *  encountering delimiters — signals "we deliberately did not split". */
  keptAsOne: boolean;
}

const ACTION_VERB = /^(open|close|click|tap|type|press|save|go|navigate|visit|search|find|create|delete|write|send|copy|paste|select|drag|scroll(\s+up|\s+down)?(\s+and)?|download|upload|install|run|set|change|turn|enable|disable|check|uncheck|fill|submit|compose|reply|forward|focus|switch|minimize|maximize|summarize|read|extract|draw|paint|sketch|resize|compute|calculate|add|subtract|multiply|divide|highlight|describe|enter|show|display|play|pause|stop|start|restart|refresh|reload|zoom|expand|collapse|rename|move|sort|filter|attach|insert|remove|undo|redo|cut)\b/i;

/**
 * Split a compound task on ` and `, ` then `, or `,` — quote-aware.
 */
export function splitCompound(task: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar: '"' | "'" | '' = '';
  const len = task.length;

  for (let i = 0; i < len; ) {
    const ch = task[i];

    if ((ch === '"' || ch === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = ch as '"' | "'";
      current += ch;
      i++;
      continue;
    }
    if (ch === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
      current += ch;
      i++;
      continue;
    }
    if (inQuotes) {
      current += ch;
      i++;
      continue;
    }

    const rest = task.slice(i).toLowerCase();
    if (rest.startsWith(' and ')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += 5;
      continue;
    }
    if (rest.startsWith(' then ')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += 6;
      continue;
    }
    if (ch === ',') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Decompose a task. Null → ambiguous, caller escalates to LLM decomposer.
 */
export function decompose(task: string): DecomposeResult | null {
  if (!task || typeof task !== 'string') return null;
  const trimmed = task.trim();
  if (trimmed.length === 0) return null;

  const parts = splitCompound(trimmed);

  if (parts.length > 1) {
    const filtered = parts.map(p => p.trim()).filter(p => p.length > 0);
    // Guard: every subtask must start with a real action verb — otherwise
    // keep as one task. This prevents the "scroll through" infinite-loop bug.
    const allHaveVerbs = filtered.every(p => ACTION_VERB.test(p));
    if (allHaveVerbs) return { subtasks: filtered, keptAsOne: false };
    // Deliberately kept as one unit — caller should run the whole thing
    // through the text-agent as-is, not escalate to LLM decomposer.
    return { subtasks: [trimmed], keptAsOne: true };
  }

  return { subtasks: [trimmed], keptAsOne: false };
}
