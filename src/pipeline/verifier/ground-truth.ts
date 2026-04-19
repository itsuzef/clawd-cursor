/**
 * GroundTruthVerifier — independent verification using actual screen state.
 *
 * Signals (combined with weighted voting):
 *   1. Pixel diff:       did the screen change at all?
 *   2. Window state:     did windows open/close/focus change?
 *   3. Focused element:  did keyboard focus move?
 *   4. OCR delta:        did visible text change?
 *   5. Task assertions:  did task-specific conditions hold?
 *   6. Anti-signals:     known failure patterns absent?
 *
 * The verdict is a weighted sum, NOT an LLM self-report.
 */

import sharp from 'sharp';
import type { PlatformAdapter } from '../../v2/platform/types';
import type {
  Verifier,
  VerifyOptions,
  VerifyResult,
  VerifySignal,
  StateSnapshot,
  TaskType,
} from './types';

export class GroundTruthVerifier implements Verifier {
  constructor(private platform: PlatformAdapter) {}

  async captureState(ocrText: string): Promise<StateSnapshot> {
    const [screenshot, windows, activeWindow, focusedElement, clipboard] = await Promise.all([
      this.platform.screenshot({ maxWidth: 1280 }),
      this.platform.listWindows(),
      this.platform.getActiveWindow(),
      this.platform.getFocusedElement().catch(() => null),
      this.platform.readClipboard().catch(() => ''),
    ]);
    return {
      timestamp: Date.now(),
      screenshot,
      windows,
      activeWindow,
      focusedElement,
      ocrText,
      clipboard,
    };
  }

  async verify(opts: VerifyOptions): Promise<VerifyResult> {
    const signals: VerifySignal[] = [];

    // Run all signals in parallel.
    const [pixel, windowSig, focus, ocrDelta, taskSig, antiSig] = await Promise.all([
      this.signalPixelDiff(opts),
      this.signalWindowChange(opts),
      this.signalFocusChange(opts),
      this.signalOcrDelta(opts),
      this.signalTaskAssertions(opts),
      this.signalAntiPatterns(opts),
    ]);

    signals.push(pixel, windowSig, focus, ocrDelta, taskSig, antiSig);

    // Weighted vote.
    const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
    const passWeight = signals.filter(s => s.value).reduce((s, x) => s + x.weight, 0);
    const confidence = totalWeight > 0 ? passWeight / totalWeight : 0;

    // Hard rules:
    //  - If anti-pattern fired, fail regardless of other signals.
    //  - If pixel diff = 0, almost certainly nothing happened.
    let pass = confidence >= 0.6;
    if (!antiSig.value) pass = false;
    if (!pixel.value && !windowSig.value && !focus.value) pass = false;

    const reason = pass
      ? `Verified: ${signals.filter(s => s.value).map(s => s.name).join(', ')}`
      : `Failed: ${signals.filter(s => !s.value).map(s => `${s.name} (${s.detail})`).join('; ')}`;

    return { pass, confidence, reason, signals };
  }

  // ─── SIGNALS ──────────────────────────────────────────────────────

  /** Did the pixels change at all? */
  private async signalPixelDiff(opts: VerifyOptions): Promise<VerifySignal> {
    try {
      const diff = await this.computePixelDiff(opts.before.screenshot.buffer, opts.after.screenshot.buffer);
      const value = diff > 0.005; // >0.5% of pixels changed
      return {
        name: 'pixel_diff',
        weight: 0.15,
        value,
        detail: `${(diff * 100).toFixed(2)}% pixels changed`,
      };
    } catch (err: any) {
      return { name: 'pixel_diff', weight: 0, value: false, detail: `error: ${err.message}` };
    }
  }

  /** Did the window state change (open/close/focus)? */
  private async signalWindowChange(opts: VerifyOptions): Promise<VerifySignal> {
    const before = opts.before;
    const after = opts.after;

    const beforeKeys = new Set(before.windows.map(w => `${w.processId}:${w.title}`));
    const afterKeys = new Set(after.windows.map(w => `${w.processId}:${w.title}`));

    const opened = [...afterKeys].filter(k => !beforeKeys.has(k));
    const closed = [...beforeKeys].filter(k => !afterKeys.has(k));
    const focusChanged = before.activeWindow?.title !== after.activeWindow?.title
                       || before.activeWindow?.processId !== after.activeWindow?.processId;

    const changed = opened.length > 0 || closed.length > 0 || focusChanged;
    const detail = changed
      ? `+${opened.length} window(s), -${closed.length} window(s)${focusChanged ? ', focus moved' : ''}`
      : 'no window changes';

    return { name: 'window_change', weight: 0.2, value: changed, detail };
  }

  /** Did keyboard focus move to a different element? */
  private async signalFocusChange(opts: VerifyOptions): Promise<VerifySignal> {
    const beforeFocus = opts.before.focusedElement;
    const afterFocus = opts.after.focusedElement;

    if (!beforeFocus && !afterFocus) {
      return { name: 'focus_change', weight: 0.1, value: false, detail: 'no focus info' };
    }

    const changed = beforeFocus?.name !== afterFocus?.name
                  || beforeFocus?.controlType !== afterFocus?.controlType;

    return {
      name: 'focus_change',
      weight: 0.1,
      value: changed,
      detail: changed ? `focus moved to "${afterFocus?.name ?? 'unknown'}"` : 'focus unchanged',
    };
  }

  /** Did visible text on screen change? */
  private async signalOcrDelta(opts: VerifyOptions): Promise<VerifySignal> {
    const beforeText = opts.before.ocrText.toLowerCase();
    const afterText = opts.after.ocrText.toLowerCase();

    if (!beforeText || !afterText) {
      return { name: 'ocr_delta', weight: 0, value: false, detail: 'no OCR data' };
    }

    // Simple Jaccard distance on words.
    const beforeWords = new Set(beforeText.split(/\s+/).filter(w => w.length > 2));
    const afterWords = new Set(afterText.split(/\s+/).filter(w => w.length > 2));
    const intersection = new Set([...beforeWords].filter(w => afterWords.has(w)));
    const union = new Set([...beforeWords, ...afterWords]);
    const similarity = union.size > 0 ? intersection.size / union.size : 1;
    const delta = 1 - similarity;

    const value = delta > 0.05; // >5% word change
    return {
      name: 'ocr_delta',
      weight: 0.15,
      value,
      detail: `${(delta * 100).toFixed(1)}% text changed`,
    };
  }

  /** Task-type-specific assertions. */
  private async signalTaskAssertions(opts: VerifyOptions): Promise<VerifySignal> {
    const taskType = opts.taskType ?? this.inferTaskType(opts.task);
    const after = opts.after;

    const checks: { name: string; pass: boolean }[] = [];

    switch (taskType) {
      case 'send_email': {
        // Must have: compose window closed, in inbox/sent view.
        const composeKeywords = /(new message|compose|untitled|draft)/i;
        const composeOpen = !!after.activeWindow?.title.match(composeKeywords);
        checks.push({ name: 'compose_closed', pass: !composeOpen });

        const inboxKeywords = /(inbox|sent|mailbox|all mail|messages)/i;
        const inInbox = inboxKeywords.test(after.activeWindow?.title ?? '') || inboxKeywords.test(after.ocrText);
        checks.push({ name: 'in_inbox_or_sent', pass: inInbox });

        // The recipient address must be visible somewhere if the task mentioned one.
        const emailMatch = opts.task.match(/[\w.-]+@[\w.-]+\.\w+/);
        if (emailMatch) {
          const recipientVisible = after.ocrText.toLowerCase().includes(emailMatch[0].toLowerCase());
          checks.push({ name: 'recipient_visible', pass: recipientVisible });
        }
        break;
      }

      case 'compose_message': {
        // For a composed (but not sent) message, content must appear in screen.
        const taskBody = this.extractQuotedContent(opts.task);
        if (taskBody) {
          const visible = after.ocrText.toLowerCase().includes(taskBody.toLowerCase().slice(0, 30));
          checks.push({ name: 'body_visible', pass: visible });
        }
        break;
      }

      case 'navigate_url': {
        // URL or domain should appear in active window title or OCR.
        const urlMatch = opts.task.match(/(?:https?:\/\/)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/i);
        if (urlMatch) {
          const domain = urlMatch[1];
          const inTitle = after.activeWindow?.title.toLowerCase().includes(domain.toLowerCase());
          const inOcr = after.ocrText.toLowerCase().includes(domain.toLowerCase());
          checks.push({ name: 'url_visible', pass: !!(inTitle || inOcr) });
        }
        break;
      }

      case 'open_app': {
        // The app's window must exist.
        const appMatch = opts.task.match(/open\s+(?:the\s+)?([a-z0-9 ]+?)(?:\s+app)?$/i);
        if (appMatch) {
          const appName = appMatch[1].trim().toLowerCase();
          const found = after.windows.some(w =>
            w.processName.toLowerCase().includes(appName) ||
            w.title.toLowerCase().includes(appName),
          );
          checks.push({ name: 'app_window_present', pass: found });
        }
        break;
      }

      case 'type_text': {
        const text = this.extractQuotedContent(opts.task);
        if (text) {
          // Either the text appears on screen, or it's in the focused element value, or in clipboard.
          const visible = after.ocrText.toLowerCase().includes(text.toLowerCase().slice(0, 25))
                       || (after.focusedElement?.value?.toLowerCase().includes(text.toLowerCase().slice(0, 25)) ?? false);
          checks.push({ name: 'text_appeared', pass: visible });
        }
        break;
      }

      case 'search': {
        // Search results must appear: presence of 'results', '1-10 of', 'showing', etc.
        const resultIndicators = /(\d+\s+results?|showing\s+\d+|about\s+[\d,]+|search results)/i;
        checks.push({ name: 'results_shown', pass: resultIndicators.test(after.ocrText) });
        break;
      }

      case 'generic':
      default:
        // Generic: at least one keyword from the task appears on screen.
        const keywords = this.extractTaskKeywords(opts.task);
        const matches = keywords.filter(k => after.ocrText.toLowerCase().includes(k));
        const ratio = keywords.length > 0 ? matches.length / keywords.length : 1;
        checks.push({ name: 'keywords_visible', pass: ratio >= 0.5 });
        break;
    }

    if (checks.length === 0) {
      return { name: 'task_assertions', weight: 0, value: false, detail: 'no assertions for task type' };
    }

    const passed = checks.filter(c => c.pass).length;
    const allPass = passed === checks.length;
    const detail = checks.map(c => `${c.name}=${c.pass ? '✓' : '✗'}`).join(' ');

    return {
      name: 'task_assertions',
      weight: 0.3, // task assertions are the biggest signal
      value: allPass,
      detail: `[${taskType}] ${detail} (${passed}/${checks.length})`,
    };
  }

  /** Anti-patterns: explicit signs of failure. Returns TRUE if no failure detected. */
  private async signalAntiPatterns(opts: VerifyOptions): Promise<VerifySignal> {
    const after = opts.after.ocrText.toLowerCase();
    const failures: string[] = [];

    // Common error indicators on screen.
    const errorPatterns: { pattern: RegExp; label: string }[] = [
      { pattern: /draft\s+saved/i, label: 'draft saved (not sent)' },
      { pattern: /(?:unable|failed|cannot)\s+to\s+send/i, label: 'send failed' },
      { pattern: /cannot\s+send\s+(?:the\s+)?message/i, label: 'cannot send message' },
      { pattern: /delivery\s+failed|message\s+not\s+(?:sent|delivered)/i, label: 'delivery failed' },
      { pattern: /server\s+(?:rejected|refused|error)/i, label: 'server error' },
      { pattern: /\berror\s*(?:[:!]|occurred|encountered)/i, label: 'error message' },
      { pattern: /try\s+again|retry/i, label: 'retry prompt' },
      { pattern: /permission\s+denied|access\s+denied/i, label: 'permission denied' },
      { pattern: /not\s+responding/i, label: 'app not responding' },
      { pattern: /invalid\s+(?:email|address|recipient)/i, label: 'invalid recipient' },
      { pattern: /authentication\s+(?:failed|required)/i, label: 'auth failed' },
    ];

    for (const { pattern, label } of errorPatterns) {
      if (pattern.test(after)) failures.push(label);
    }

    const value = failures.length === 0;
    return {
      name: 'anti_patterns',
      weight: 0.1, // small weight, but note: also a HARD failure if value=false
      value,
      detail: failures.length > 0 ? `detected: ${failures.join(', ')}` : 'no failure indicators',
    };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────

  /** Compute fraction of pixels that differ between two PNG buffers. */
  private async computePixelDiff(a: Buffer, b: Buffer): Promise<number> {
    // Both should already be at the same resolution (1280px-wide). Decode and compare.
    const [aRaw, bRaw] = await Promise.all([
      sharp(a).raw().toBuffer({ resolveWithObject: true }),
      sharp(b).raw().toBuffer({ resolveWithObject: true }),
    ]);

    if (aRaw.info.width !== bRaw.info.width || aRaw.info.height !== bRaw.info.height) {
      // Different sizes — definitely changed.
      return 1.0;
    }

    const len = Math.min(aRaw.data.length, bRaw.data.length);
    const channels = aRaw.info.channels;
    const totalPixels = len / channels;
    let diffPixels = 0;
    const threshold = 30; // per-channel difference threshold

    for (let i = 0; i < len; i += channels) {
      const dr = Math.abs(aRaw.data[i] - bRaw.data[i]);
      const dg = Math.abs(aRaw.data[i + 1] - bRaw.data[i + 1]);
      const db = Math.abs(aRaw.data[i + 2] - bRaw.data[i + 2]);
      if (dr + dg + db > threshold * 3) diffPixels++;
    }

    return totalPixels > 0 ? diffPixels / totalPixels : 0;
  }

  /** Heuristic task type inference from the task string. */
  private inferTaskType(task: string): TaskType {
    const t = task.toLowerCase();
    if (/send.*email|email.*to|reply.*to|forward.*email/.test(t)) return 'send_email';
    if (/compose|draft.*message|write.*message/.test(t)) return 'compose_message';
    if (/(?:open|launch|start).*(?:app|application)|open\s+\w+$/.test(t)) return 'open_app';
    if (/navigate|go to.*\.|visit.*\.|open\s+(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/.test(t)) return 'navigate_url';
    if (/type|enter.*text|write.*"|input/.test(t)) return 'type_text';
    if (/create.*file|save.*as|new\s+document/.test(t)) return 'create_file';
    if (/search|find|look up|google/.test(t)) return 'search';
    return 'generic';
  }

  /** Extract quoted text from a task (for type-text or compose tasks). */
  private extractQuotedContent(task: string): string | null {
    const quoted = task.match(/["'](.+?)["']/);
    if (quoted) return quoted[1];
    // Fallback: text after "type" or "write"
    const after = task.match(/(?:type|write|enter)[: ]+(.+?)(?:$|\s+(?:then|and|to)\b)/i);
    return after?.[1].trim() ?? null;
  }

  /** Extract meaningful keywords from a task (skipping common verbs). */
  private extractTaskKeywords(task: string): string[] {
    const NOISE = new Set([
      'open', 'click', 'type', 'then', 'with', 'select', 'press', 'into',
      'from', 'that', 'this', 'should', 'make', 'please', 'text', 'field',
      'enter', 'write', 'app', 'application', 'and', 'the', 'a', 'an',
    ]);
    return task.toLowerCase()
      .replace(/[^\w\s@.-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !NOISE.has(w) && !/^\d+$/.test(w));
  }
}
