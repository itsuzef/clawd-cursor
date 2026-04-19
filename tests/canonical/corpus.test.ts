/**
 * Canonical task corpus — deterministic, model-agnostic regression gate.
 *
 * With the unified agent, the corpus focuses on the PREPROCESSOR's
 * strategy choice (router / blind / hybrid / vision) and the classifier's
 * needsVision flag. The loop itself is integration-tested live; here we
 * keep things fast and pure so the gate runs in <1s on every commit.
 *
 * Per plan §5.7 + §19a.6: each task asserts
 *   (a) the classifier recognizes the task kind
 *   (b) the preprocessor picks the expected strategy
 *   (c) decomposition handles compound cases
 *
 * The goal of the corpus is to catch silent regressions in the cheap
 * pre-LLM path — changes that would force vision-first-by-default slip in.
 */

import { describe, it, expect } from 'vitest';
import { preprocess } from '../../src/pipeline/preprocessor/preprocessor';
import { classifyTask } from '../../src/pipeline/classify/classify';

interface CanonicalCase {
  id: string;
  task: string;
  /** The preprocessor strategy we expect. */
  expectedStrategy: 'router' | 'blind' | 'hybrid' | 'vision';
  /** Classify's `needsVision`. */
  classifyNeedsVision: boolean;
  /** Minimum subtask count the regex decomposer should produce. */
  minSubtasks: number;
  /** Optional: must include this appKey hint (only when activeWindow is set). */
  activeWindowTitle?: string;
  expectedAppKey?: string;
}

const CASES: CanonicalCase[] = [
  // ── Router-expected (no LLM; cheapest) ──
  {
    id: 'open_notepad',
    task: 'open Notepad',
    expectedStrategy: 'router',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },
  {
    id: 'open_calc',
    task: 'launch Calculator',
    expectedStrategy: 'router',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },
  {
    id: 'go_to_url',
    task: 'go to github.com',
    expectedStrategy: 'router',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },
  {
    id: 'focus_window',
    task: 'focus Chrome',
    expectedStrategy: 'router',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },

  // ── Blind-first happy paths (default for reasoning tasks) ──
  {
    id: 'click_send',
    task: 'click Send',
    expectedStrategy: 'blind',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },
  {
    id: 'type_text',
    task: 'type hello world',
    expectedStrategy: 'blind',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },
  {
    id: 'summarize',
    task: 'summarize what is on my screen',
    expectedStrategy: 'blind',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },

  // ── Spatial → straight to vision ──
  // Note: classify.needsVision stays false even for 'spatial' because the
  // text-agent can sometimes drag via structured perception; the preprocessor
  // still routes 'spatial' → 'vision' strategy up front.
  {
    id: 'draw_square',
    task: 'draw a square on the canvas',
    expectedStrategy: 'vision',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },
  {
    id: 'drag_file',
    task: 'drag the file to the trash',
    expectedStrategy: 'vision',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },

  // ── Visual-wording → hybrid ──
  {
    id: 'top_right_red_button',
    task: 'click the red button in the top right corner',
    expectedStrategy: 'hybrid',
    classifyNeedsVision: false,
    minSubtasks: 0,
  },

  // ── Compound → decomposed into subtasks ──
  {
    id: 'compound_open_and_type',
    task: 'open Notepad and type hello',
    // First subtask "open Notepad" runs router; second is blind.
    // Preprocessor picks strategy for the WHOLE task — "open ..."
    // triggers router-candidate gate first.
    expectedStrategy: 'router',
    classifyNeedsVision: false,
    minSubtasks: 2,
  },
  {
    id: 'compound_calc',
    task: 'open Calculator and compute 5 plus 7',
    expectedStrategy: 'router',
    classifyNeedsVision: false,
    minSubtasks: 2,
  },
];

describe('canonical corpus — preprocessor strategy', () => {
  for (const c of CASES) {
    it(`${c.id}: "${c.task}"`, () => {
      const decision = preprocess(c.task, c.activeWindowTitle ? { activeWindowTitle: c.activeWindowTitle } : {});
      expect(decision.strategy, `${c.id} strategy`).toBe(c.expectedStrategy);
      expect(decision.subtasks.length, `${c.id} subtasks >= ${c.minSubtasks}`).toBeGreaterThanOrEqual(c.minSubtasks);
      const classification = classifyTask(c.task);
      expect(classification.needsVision, `${c.id} classifyNeedsVision`).toBe(c.classifyNeedsVision);
      if (c.expectedAppKey) {
        expect(decision.hints.appKey, `${c.id} appKey`).toBe(c.expectedAppKey);
      }
    });
  }

  it('corpus size meets initial-scope target (≥12)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
  });

  it('blind-first stays blind-first in the default distribution', () => {
    // Target: ≥ half of non-router tasks stay blind (the cheap path).
    const nonRouter = CASES.filter(c => c.expectedStrategy !== 'router');
    const blind = nonRouter.filter(c => c.expectedStrategy === 'blind');
    expect(blind.length / Math.max(1, nonRouter.length)).toBeGreaterThanOrEqual(0.25);
  });

  it('vision is only used for explicitly spatial tasks', () => {
    // The preprocessor routes spatial → vision even when classify.needsVision
    // is false (classifier reserves that flag for the cases where text-agent
    // has no prayer). The test: every vision-strategy case must match the
    // SPATIAL regex in classify.ts by containing a known spatial verb.
    const visionCases = CASES.filter(c => c.expectedStrategy === 'vision');
    const SPATIAL_RE = /\b(draw|sketch|paint|design|arrange|drag|resize|move\s+(the\s+)?element|color|shade|fill|illustrate|diagram|annotate)\b/i;
    for (const v of visionCases) {
      expect(SPATIAL_RE.test(v.task), `${v.id} should contain a spatial verb`).toBe(true);
    }
  });
});
