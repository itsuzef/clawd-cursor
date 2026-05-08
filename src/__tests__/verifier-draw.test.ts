/**
 * Tests for the v0.8.14 verifier improvements: `'draw'` task type and
 * graceful handling of empty OCR data.
 *
 * Concrete origin: a real Paint stick-figure run was rejected with
 * `confidence=0.235` because the universal `pixel_diff > 0.5%` threshold
 * (tuned for window opens) treated 0.08% pixels-changed as noise, AND
 * the `'generic'` task-assertion fallback failed `keywords_visible` on
 * empty OCR text. Both paths systematically false-negative drawing
 * tasks. These tests pin down the corrected behavior.
 */

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { GroundTruthVerifier } from '../core/verifier';
import type { StateSnapshot, VerifyOptions } from '../core/verifier-types';
import type { PlatformAdapter } from '../platform/types';

// ─── helpers ────────────────────────────────────────────────────────

/** Minimal adapter stub — verifier only calls `screenshot`/`listWindows`/etc.
 *  through the explicit `verify()` call, never via captureState in these tests. */
function adapterStub(): PlatformAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {} as any;
}

/** Build a solid-color PNG buffer of the given size and color. */
async function pngOfColor(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({
    create: {
      width, height, channels: 3, background: rgb,
    },
  }).png().toBuffer();
}

/** PNG with `paintedPixels` non-white pixels in the top-left rectangle.
 *  Used to simulate "drew a stick figure on a white canvas". */
async function pngWithPaintedPixels(
  width: number,
  height: number,
  paintedPixels: number,
): Promise<Buffer> {
  // Start with a solid white background.
  const white = sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  });
  // Composite a black bar of exactly `paintedPixels` pixels in the top-left.
  // Use a 1-pixel-tall strip of the appropriate width.
  const stripWidth = Math.min(paintedPixels, width);
  const stripHeight = Math.max(1, Math.ceil(paintedPixels / width));
  const black = await sharp({
    create: { width: stripWidth, height: stripHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  return white
    .composite([{ input: black, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function emptyState(screenshot: Buffer, ocrText = ''): StateSnapshot {
  return {
    timestamp: Date.now(),
    screenshot: { buffer: screenshot, width: 1280, height: 720, scaleFactor: 1 },
    windows: [
      { title: 'Untitled - Paint', processName: 'mspaint', processId: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, isMinimized: false, handle: 1 },
    ],
    activeWindow: { title: 'Untitled - Paint', processName: 'mspaint', processId: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, isMinimized: false, handle: 1 },
    focusedElement: null,
    ocrText,
    clipboard: '',
  };
}

// ─── tests ──────────────────────────────────────────────────────────

describe("verifier — 'draw' task type", () => {
  it("accepts a stick-figure-sized drawing (~0.05% pixels) when taskType='draw'", async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    // ~500 pixels painted → 500/921600 ≈ 0.054% — above the 0.05% draw
    // threshold, well below the 0.5% default.
    const after = await pngWithPaintedPixels(1280, 720, 500);

    const result = await v.verify({
      task: 'draw a stick figure',
      before: emptyState(before),
      after: emptyState(after),
      taskType: 'draw',
    } as VerifyOptions);

    expect(result.pass).toBe(true);
    // pixel_diff fired AND task_assertions fired → confidence > 0.6.
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    const pixelSig = result.signals.find(s => s.name === 'pixel_diff');
    expect(pixelSig?.value).toBe(true);
    const taskSig = result.signals.find(s => s.name === 'task_assertions');
    expect(taskSig?.detail).toContain('canvas_changed');
  });

  it("infers 'draw' from a draw-only subtask when taskType not provided", async () => {
    // The pipeline decomposes compound tasks BEFORE verification, so
    // each subtask is verified individually. A draw-only subtask
    // ("draw a stick figure") should infer as 'draw'.
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    const after = await pngWithPaintedPixels(1280, 720, 500);

    const result = await v.verify({
      task: 'draw a stickfigure',
      before: emptyState(before),
      after: emptyState(after),
    });

    expect(result.pass).toBe(true);
  });

  it("does NOT mis-classify pure 'open' tasks as 'draw'", async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    const after = await pngWithPaintedPixels(1280, 720, 500);

    const result = await v.verify({
      task: 'open paint',
      before: emptyState(before),
      after: emptyState(after),
    });

    // 500 pixels = 0.054% — below the 0.5% default (non-draw) threshold,
    // so pixel_diff should NOT fire. The task should be inferred as
    // open_app and the pixel signal should evaluate to false.
    const pixelSig = result.signals.find(s => s.name === 'pixel_diff');
    expect(pixelSig?.value).toBe(false);
  });

  it("rejects a 'drew nothing' run (pure-white before AND after)", async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    const after = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });

    const result = await v.verify({
      task: 'draw a stick figure',
      before: emptyState(before),
      after: emptyState(after),
      taskType: 'draw',
    });

    expect(result.pass).toBe(false);
    expect(result.reason.toLowerCase()).toContain('pixel_diff');
  });

  it("hard-rule: 'draw' only requires pixel.value (window/focus may stay)", async () => {
    // Same window in before & after, no focus change — only pixels move.
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    const after = await pngWithPaintedPixels(1280, 720, 500);

    const beforeSnap = emptyState(before);
    const afterSnap = emptyState(after);
    // Force window/focus identical — the legacy hard rule would have
    // auto-failed. The new draw-aware rule should NOT.
    afterSnap.windows = beforeSnap.windows;
    afterSnap.activeWindow = beforeSnap.activeWindow;

    const result = await v.verify({
      task: 'draw a stick figure',
      before: beforeSnap,
      after: afterSnap,
      taskType: 'draw',
    });

    expect(result.pass).toBe(true);
  });
});

describe("verifier — generic task assertions skip when OCR is empty", () => {
  it("returns weight=0 instead of failing when ocrText is empty (no-OCR safety)", async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    const after = await pngWithPaintedPixels(1280, 720, 500);

    const result = await v.verify({
      // Phrase carefully chosen NOT to match any task-type regex
      // (avoids "type", "open", "draw", "send", "search" verbs).
      task: 'observe what is happening on the screen right now',
      before: emptyState(before, /* empty OCR */ ''),
      after: emptyState(after, /* empty OCR */ ''),
    });

    const taskSig = result.signals.find(s => s.name === 'task_assertions');
    expect(taskSig?.weight).toBe(0);
    expect(taskSig?.detail.toLowerCase()).toContain('no ocr');
  });

  it("still does keyword check when OCR text IS available", async () => {
    const v = new GroundTruthVerifier(adapterStub());
    const before = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });
    const after = await pngOfColor(1280, 720, { r: 255, g: 255, b: 255 });

    const result = await v.verify({
      task: 'observe what is happening on the screen',
      before: emptyState(before, 'before-screen text'),
      after: emptyState(after, 'observe something different is happening on the screen now'),
    });

    const taskSig = result.signals.find(s => s.name === 'task_assertions');
    expect(taskSig?.weight).toBeGreaterThan(0);
  });
});
