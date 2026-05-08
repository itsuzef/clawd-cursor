/**
 * Capability classifier — finer-grained tagging of subtask INTENT.
 *
 * Lives alongside `classifyTask` but asks a different question.
 * `classifyTask` buckets into {mechanical, navigation, reasoning, spatial}
 * to pick a PIPELINE PATH (router / blind / hybrid / vision). The
 * capability classifier is the layer below: given this subtask's text,
 * which TOOLS does the LLM plausibly need?
 *
 * Pure regex, zero LLM, ~30 LOC. Falls back to `general` (full tool
 * catalog, same as pre-Tranche-2.5 behavior) when nothing matches, so
 * this change is safe by construction.
 *
 * Precedence (first match wins):
 *   spatial > window_mgmt > file_ops > form_fill > text_input >
 *   navigation > app_launch > general
 *
 * Why that order: the most specific verbs fire first. "drag file to
 * trash" matches both `spatial` (drag) and `file_ops` (file); spatial
 * wins because the user's INTENT is a physical gesture, and the
 * correct tool palette is the spatial one (needs drag/mouse tools,
 * not file APIs).
 */

export type Capability =
  /** `open Notepad`, `launch Chrome`, `focus Outlook`. Router usually handles — agent fallback needs launch + focus tools only. */
  | 'app_launch'
  /** `type hello`, `enter your email`, `write "foo"`. Focus + type + a11y set-value. */
  | 'text_input'
  /** `go to github.com`, `visit docs.anthropic.com`. Router handles — agent fallback wants key_press + switch_tab. */
  | 'navigation'
  /** `fill out the form`, `complete the signup`. Form iteration over named fields. */
  | 'form_fill'
  /** `draw a square`, `drag the file to trash`, `resize this element`. Needs pixel-level mouse primitives. */
  | 'spatial'
  /** `open the README`, `save as`, `open this URL`. System-open helpers + clipboard. */
  | 'file_ops'
  /** `maximize`, `minimize`, `close window`, `resize to 1280x720`. setWindowState + setWindowBounds. */
  | 'window_mgmt'
  /** Fallback — shows the full catalog. Same behavior as before this feature existed. */
  | 'general';

const CAPABILITY_RULES: Array<{ name: Capability; pattern: RegExp }> = [
  // spatial — physical gestures. Leading check so "drag file to trash" lands here.
  {
    name: 'spatial',
    pattern: /\b(draw|sketch|paint|drag\s+.*\b(to|onto|into)\b|resize\s+(the\s+)?(element|image|layer)|crop|rotate|annotate|illustrate|diagram)\b/i,
  },

  // window_mgmt — verbs about the window itself
  {
    name: 'window_mgmt',
    pattern: /\b(maximi[sz]e|minimi[sz]e|close\s+(the\s+)?(window|tab)|resize\s+(the\s+)?window|move\s+(the\s+)?window\s+to|restore\s+(the\s+)?window|snap\s+(to\s+)?(left|right|top|bottom))\b/i,
  },

  // file_ops — file system / URL targets
  {
    name: 'file_ops',
    pattern: /\b(open\s+(the\s+)?file|save\s+as|open\s+in\s+default|show\s+in\s+(finder|explorer)|open\s+(this\s+)?url|open\s+https?:|copy\s+(file|text|url)\s+to\s+clipboard)\b/i,
  },

  // form_fill — explicit form interaction
  {
    name: 'form_fill',
    pattern: /\b(fill\s+(in|out|the)|complete\s+(the\s+)?form|check\s+(the\s+)?box|select\s+(the\s+)?(option|item|radio)|submit\s+(the\s+)?form)\b/i,
  },

  // text_input — anything saying type / enter / write text
  {
    name: 'text_input',
    pattern: /\b(type\b|enter\s+["'\w]|write\s+["'\w]|paste\s+["'\w]|input\s+["'\w]|key\s*in\b)/i,
  },

  // navigation — URL or "go to" style
  {
    name: 'navigation',
    pattern: /\b(go\s+to|navigate\s+to|visit|browse\s+to|search\s+(for|on\s+page)|find\s+on\s+page|switch\s+to\s+.*tab)\b/i,
  },

  // app_launch — open/launch/focus app
  {
    name: 'app_launch',
    pattern: /^\s*(open|launch|start|run|focus|switch\s+to)\b/i,
  },
];

/**
 * Classify a subtask string into a Capability. Pure, zero-LLM.
 * Caller uses the result to scope the agent's tool catalog.
 */
export function classifyCapability(subtaskText: string): Capability {
  const t = subtaskText.trim();
  if (!t) return 'general';
  for (const rule of CAPABILITY_RULES) {
    if (rule.pattern.test(t)) return rule.name;
  }
  return 'general';
}
