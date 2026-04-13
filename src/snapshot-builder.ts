/**
 * SnapshotBuilder — Stage 1 of the v0.7.5 pipeline.
 *
 * Runs OCR + A11y (+ CDP for browser) in PARALLEL, merges into a single
 * structured ScreenSnapshot. Every element carries pre-computed click
 * coordinates in real screen pixels.
 *
 * Consumers: TextNavigator (OCR Reasoner), agent.ts pipeline
 */

import { OcrEngine, type OcrResult, type OcrElement } from './ocr-engine';
import { AccessibilityBridge, type UIElement } from './accessibility';
import { NativeDesktop } from './native-desktop';
import type { PipelineConfig } from './providers';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SnapshotElement {
  id: number;
  text: string;
  cx: number;              // center x in real screen pixels
  cy: number;              // center y in real screen pixels
  controlType?: string;    // "Button", "Edit", etc. from A11y
  a11yName?: string;       // UIA name
  a11yId?: string;         // UIA automation ID
  isEnabled?: boolean;
  confidence?: number;     // OCR confidence (1.0 = high)
  isEmptyField?: boolean;  // A11y-only empty input field
}

export interface ScreenSnapshot {
  elements: SnapshotElement[];
  windowTitle: string;
  windowProcess: string;
  windowPid: number;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  a11yTree: string;        // truncated raw a11y tree
  fingerprint: string;     // for stagnation detection
  formatted: string;       // LLM-ready text representation
  captureMs: number;       // how long the parallel capture took
}

interface A11yCaptureResult {
  win: { processName: string; title: string; processId: number; bounds: { x: number; y: number; width: number; height: number }; isMinimized?: boolean } | null;
  tree: string | null;
  elements: UIElement[];
}

interface A11yMetadata {
  controlType: string;
  name: string;
  automationId: string;
  isEnabled: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CAPTURE_OCR_TIMEOUT = 8000;
const CAPTURE_A11Y_TIMEOUT = 8000;  // 8s — same budget as OCR. If A11y can't finish in time, proceed without it.

// ─── SnapshotBuilder ─────────────────────────────────────────────────────────

export class SnapshotBuilder {
  private a11yConsecutiveFailures = 0;
  private a11yDisabled = false;

  constructor(
    private ocr: OcrEngine,
    private a11y: AccessibilityBridge,
    private desktop: NativeDesktop,
    private pipelineConfig: PipelineConfig,
  ) {}

  /**
   * Build a complete screen snapshot by running OCR + A11y in parallel.
   * Returns a structured ScreenSnapshot with all elements and a formatted string.
   */
  async build(targetProcessId?: number): Promise<ScreenSnapshot> {
    const start = Date.now();

    // Invalidate caches before capture
    this.ocr.invalidateCache();
    this.a11y.invalidateCache();

    // PARALLEL CAPTURE — OCR + A11y simultaneously
    // Skip A11y if: shell unavailable, OR 2+ consecutive failures (auto-disable to avoid stalling pipeline)
    const a11yAvailable = !this.a11yDisabled && await this.a11y.isShellAvailable();
    const [ocrSettled, a11ySettled] = await Promise.allSettled([
      Promise.race([
        this.ocr.recognizeScreen(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('OCR capture timeout')), CAPTURE_OCR_TIMEOUT)),
      ]),
      a11yAvailable
        ? Promise.race([
            this.captureA11y(targetProcessId ?? 0),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('A11y capture timeout')), CAPTURE_A11Y_TIMEOUT)),
          ])
        : Promise.resolve({ win: null, tree: null, elements: [] } as A11yCaptureResult),
    ]);

    const ocrResult: OcrResult = ocrSettled.status === 'fulfilled'
      ? ocrSettled.value
      : { elements: [], fullText: '', durationMs: 0 };
    const a11yData: A11yCaptureResult = a11ySettled.status === 'fulfilled'
      ? a11ySettled.value
      : { win: null, tree: null, elements: [] };

    if (ocrSettled.status === 'rejected') console.warn(`   [Snapshot] ⚠️ OCR failed: ${ocrSettled.reason?.message ?? 'unknown'}`);
    if (a11yAvailable) {
      const a11yFailed = a11ySettled.status === 'rejected' || a11yData.elements.length === 0;
      if (a11yFailed) {
        this.a11yConsecutiveFailures++;
        if (a11ySettled.status === 'rejected') {
          console.warn(`   [Snapshot] ⚠️ A11y failed (${this.a11yConsecutiveFailures}x): ${a11ySettled.reason?.message ?? 'unknown'}`);
        }
        if (this.a11yConsecutiveFailures >= 2 && !this.a11yDisabled) {
          this.a11yDisabled = true;
          console.warn(`   [Snapshot] 🔇 A11y auto-disabled after ${this.a11yConsecutiveFailures} consecutive failures — OCR-only mode`);
        }
      } else {
        this.a11yConsecutiveFailures = 0; // Reset on success
      }
    }

    // Extract window info
    let windowTitle = '';
    let windowProcess = '';
    let windowPid = 0;
    let windowBounds: { x: number; y: number; width: number; height: number } | null = null;
    let a11yTree = '';
    const a11yElements = a11yData.elements;

    if (a11yData.win) {
      windowTitle = a11yData.win.title || '';
      windowProcess = a11yData.win.processName || '';
      windowPid = a11yData.win.processId || 0;

      // Resolve window bounds — prefer target window if different from active
      if (targetProcessId && a11yData.win.processId !== targetProcessId) {
        const wins = await this.a11y.getWindows().catch(() => []);
        const targetWin = wins.find(w => w.processId === targetProcessId);
        windowBounds = targetWin?.bounds ?? a11yData.win.bounds;
      } else {
        windowBounds = a11yData.win.bounds;
      }

      if (a11yData.tree) {
        a11yTree = a11yData.tree.substring(0, 1000);
      }
    }

    // Filter OCR elements to active window bounds
    let filteredOcr = ocrResult;
    if (windowBounds && windowBounds.width > 0) {
      const wb = windowBounds;
      const pad = 20;
      const filtered = ocrResult.elements.filter(el => {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        return cx >= (wb.x - pad) && cx <= (wb.x + wb.width + pad)
            && cy >= (wb.y - pad) && cy <= (wb.y + wb.height + pad);
      });
      if (filtered.length > 0) {
        filteredOcr = { ...ocrResult, elements: filtered };
      }
      // If all filtered out, keep unfiltered as fallback
    }

    console.log(`   [Snapshot] ${filteredOcr.elements.length} OCR + ${a11yElements.length} A11y elements (${Date.now() - start}ms)`);

    // Build merged elements
    const elements = this.mergeElements(filteredOcr, a11yElements);

    // Fingerprint for stagnation detection
    const fingerprint = filteredOcr.elements.map(el => el.text).join('|').substring(0, 800);

    // Format for LLM
    const formatted = this.formatForLLM(elements, a11yTree, windowTitle, windowProcess);

    return {
      elements,
      windowTitle,
      windowProcess,
      windowPid,
      windowBounds,
      a11yTree,
      fingerprint,
      formatted,
      captureMs: Date.now() - start,
    };
  }

  /**
   * Merge OCR elements with A11y metadata into SnapshotElements.
   */
  private mergeElements(ocrResult: OcrResult, a11yElements: UIElement[]): SnapshotElement[] {
    const result: SnapshotElement[] = [];
    let elementId = 0;

    // Process OCR elements — attach A11y metadata where bounds overlap
    for (const el of ocrResult.elements) {
      const cx = Math.round(el.x + el.width / 2);
      const cy = Math.round(el.y + el.height / 2);
      const a11yMeta = this.findA11yMatch(el, a11yElements);

      result.push({
        id: elementId++,
        text: el.text,
        cx,
        cy,
        controlType: a11yMeta?.controlType,
        a11yName: a11yMeta?.name,
        a11yId: a11yMeta?.automationId,
        isEnabled: a11yMeta?.isEnabled,
        confidence: el.confidence < 1.0 ? el.confidence : undefined,
      });
    }

    // Add empty interactive A11y elements not covered by OCR
    const interactiveTypes = new Set(['Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'Button']);
    for (const a11y of a11yElements) {
      const shortType = a11y.controlType.replace('ControlType.', '');
      if (!interactiveTypes.has(shortType)) continue;
      if (a11y.bounds.width <= 0 || a11y.bounds.height <= 0) continue;

      // Skip if OCR already covers this area
      const hasOverlap = ocrResult.elements.some(el => {
        const elCx = el.x + el.width / 2;
        const elCy = el.y + el.height / 2;
        return elCx >= a11y.bounds.x && elCx <= a11y.bounds.x + a11y.bounds.width
            && elCy >= a11y.bounds.y && elCy <= a11y.bounds.y + a11y.bounds.height;
      });

      if (!hasOverlap && a11y.name) {
        result.push({
          id: elementId++,
          text: a11y.name,
          cx: a11y.bounds.x + Math.round(a11y.bounds.width / 2),
          cy: a11y.bounds.y + Math.round(a11y.bounds.height / 2),
          controlType: shortType,
          a11yName: a11y.name,
          a11yId: a11y.automationId || undefined,
          isEnabled: a11y.isEnabled !== false,
          isEmptyField: true,
        });
      }
    }

    return result;
  }

  /**
   * Find matching A11y element for an OCR element via bounding-box overlap.
   */
  private findA11yMatch(el: OcrElement, a11yElements: UIElement[]): A11yMetadata | null {
    const elCx = el.x + el.width / 2;
    const elCy = el.y + el.height / 2;

    for (const a11y of a11yElements) {
      const b = a11y.bounds;
      if (elCx >= b.x && elCx <= b.x + b.width && elCy >= b.y && elCy <= b.y + b.height) {
        const shortType = a11y.controlType.replace('ControlType.', '');
        if (shortType === 'Text' || shortType === 'Pane' || shortType === 'Custom') continue;
        return {
          controlType: shortType,
          name: a11y.name,
          automationId: a11y.automationId,
          isEnabled: a11y.isEnabled !== false,
        };
      }
    }
    return null;
  }

  /**
   * Format snapshot elements as LLM-ready text.
   */
  formatForLLM(
    elements: SnapshotElement[],
    a11yTree: string,
    windowTitle: string,
    windowProcess: string,
  ): string {
    // Build element lines
    const lines: string[] = [];
    for (const el of elements) {
      const conf = el.confidence !== undefined ? `,conf:${el.confidence.toFixed(2)}` : '';
      const typeTag = el.controlType ? `,${el.controlType}` : '';
      let a11yAnnotation = '';
      if (el.a11yName || el.a11yId) {
        const parts: string[] = [];
        if (el.a11yName) parts.push(`name:"${el.a11yName}"`);
        if (el.a11yId) parts.push(`id:${el.a11yId}`);
        if (el.isEnabled === false) parts.push('DISABLED');
        if (el.isEmptyField) parts.push('empty field');
        if (parts.length > 0) a11yAnnotation = ` [${parts.join(', ')}]`;
      }
      lines.push(`[${el.id}] @(${el.cx},${el.cy}${conf}${typeTag}) "${el.text}"${a11yAnnotation}`);
    }

    // Truncate to fit context window
    const truncatedLines = this.truncateToContextWindow(lines);

    const a11ySnippet = a11yTree
      ? `\n=== A11Y TREE (${windowProcess}: ${windowTitle}) ===\n${a11yTree}`
      : '';

    const ocrText = truncatedLines.length > 0
      ? truncatedLines.join('\n')
      : '(no text detected — screen may be blank or contain only images)';

    return `=== SCREEN SNAPSHOT (OCR — coordinates in real screen pixels) ===
Window: ${windowProcess} — "${windowTitle}"
${ocrText}
${a11ySnippet}`;
  }

  /**
   * Truncate snapshot lines to fit within the LLM's context window.
   * Prioritizes interactive elements (buttons, inputs) over static text.
   */
  private truncateToContextWindow(lines: string[]): string[] {
    const providerContextWindow = this.pipelineConfig.provider?.textContextWindow;
    const modelName = (this.pipelineConfig.layer2?.model || this.pipelineConfig.layer3?.model) || '';
    const contextWindow = providerContextWindow ||
      (/128k/i.test(modelName) ? 128000 :
      /32k/i.test(modelName)  ? 32000 :
      /16k/i.test(modelName)  ? 16000 :
      /8k/i.test(modelName)   ? 8000 :
      /gpt-4o|claude|gemini|k2/i.test(modelName) ? 128000 :
      32000);

    const reservedTokens = 3500;
    const maxTokensForElements = contextWindow - reservedTokens;
    const tokensPerLine = 100;
    const maxLines = Math.max(20, Math.min(200, Math.floor(maxTokensForElements / tokensPerLine)));

    if (lines.length <= maxLines) return lines;

    // Prioritize interactive elements
    const interactive: string[] = [];
    const other: string[] = [];
    for (const line of lines) {
      if (/,Button\)|,Edit\)|,ComboBox\)|,CheckBox\)|,RadioButton\)|,Link\)|empty field\]/.test(line)) {
        interactive.push(line);
      } else {
        other.push(line);
      }
    }

    const remaining = maxLines - interactive.length;
    const kept = [...interactive, ...other.slice(0, Math.max(0, remaining))];
    kept.push(`... (${lines.length - kept.length} more elements — scroll if needed)`);
    return kept;
  }

  /**
   * Parallel A11y capture — getActiveWindow + getScreenContext + findElement.
   */
  private async captureA11y(targetPid: number): Promise<A11yCaptureResult> {
    try {
      // If we already know the target PID, skip getActiveWindow and run everything in parallel.
      // getActiveWindow adds ~4s of osascript overhead on macOS — avoid when possible.
      if (targetPid > 0) {
        const [win, tree, rawElements] = await Promise.all([
          this.a11y.getActiveWindow().catch(() => null),
          this.a11y.getScreenContext(targetPid).catch(() => null),
          this.a11y.findElement({ processId: targetPid }).catch(() => []),
        ]);

        const elements: UIElement[] = (Array.isArray(rawElements) ? rawElements : []).map(el => ({
          name: el.name || '',
          automationId: el.automationId || '',
          controlType: el.controlType || '',
          className: el.className || '',
          isEnabled: el.isEnabled,
          bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
        }));

        return { win, tree, elements };
      }

      // Fallback: no target PID — must get active window first
      const win = await this.a11y.getActiveWindow().catch(() => null);
      if (!win) return { win: null, tree: null, elements: [] };

      const pid = win.processId;
      const [tree, rawElements] = await Promise.all([
        this.a11y.getScreenContext(pid).catch(() => null),
        this.a11y.findElement({ processId: pid }).catch(() => []),
      ]);

      const elements: UIElement[] = (Array.isArray(rawElements) ? rawElements : []).map(el => ({
        name: el.name || '',
        automationId: el.automationId || '',
        controlType: el.controlType || '',
        className: el.className || '',
        isEnabled: el.isEnabled,
        bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
      }));

      return { win, tree, elements };
    } catch {
      return { win: null, tree: null, elements: [] };
    }
  }
}
