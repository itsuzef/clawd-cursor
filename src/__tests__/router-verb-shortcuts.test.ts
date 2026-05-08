/**
 * Tests for the v0.8.16 router verb-shortcut dispatch.
 *
 * Background: the LLM decomposer produces atomic verb-level subtasks
 * ("copy", "paste", "save", "press Enter", "type John"). v0.7.x had
 * deterministic handlers for these in the legacy router; v0.8.1 unification
 * dropped them, forcing every verb to run a full blind→hybrid→vision
 * agent climb (~30s+, 1+ LLM call) for what should be a single
 * `keyPress('mod+c')`. These tests pin down the restored dispatch.
 */

import { describe, it, expect, vi } from 'vitest';
import { Router } from '../core/router/router';
import type { PlatformAdapter } from '../platform/types';

function makeStubAdapter(): PlatformAdapter & { keyPress: ReturnType<typeof vi.fn>; typeText: ReturnType<typeof vi.fn> } {
  const keyPress = vi.fn(async (_combo: string) => {});
  const typeText = vi.fn(async (_text: string) => {});

  return {
    platform: 'win32',
    keyPress,
    typeText,
    listWindows: () => Promise.resolve([]),
    getActiveWindow: () => Promise.resolve(null),
    getScreenSize: () => Promise.resolve({ physicalWidth: 1920, physicalHeight: 1080, logicalWidth: 1920, logicalHeight: 1080, dpiRatio: 1 }),
    focusWindow: () => Promise.resolve(true),
    openApp: () => Promise.resolve({}),
    launchApp: () => Promise.resolve({}),
  } as unknown as PlatformAdapter & { keyPress: ReturnType<typeof vi.fn>; typeText: ReturnType<typeof vi.fn> };
}

describe('Router — verb shortcuts (deterministic dispatch)', () => {
  it.each([
    ['copy',                     'mod+c'],
    ['Copy',                     'mod+c'],
    ['copy the selection',       'mod+c'],
    ['copy that',                'mod+c'],
    ['copy the line',            'mod+c'],
    ['paste',                    'mod+v'],
    ['paste it',                 'mod+v'],
    ['paste here',               'mod+v'],
    ['cut',                      'mod+x'],
    ['cut the selection',        'mod+x'],
    ['select all',               'mod+a'],
    ['select all text',          'mod+a'],
    ['save',                     'mod+s'],
    ['save the file',            'mod+s'],
    ['save the document',        'mod+s'],
    ['undo',                     'mod+z'],
    ['redo',                     'mod+shift+z'],
    ['find',                     'mod+f'],
    ['find in document',         'mod+f'],
  ])('routes "%s" → keyPress("%s") with no LLM', async (subtask, expected) => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const result = await router.route(subtask);

    expect(result.handled).toBe(true);
    expect(result.path).toBe('shortcut');
    expect(adapter.keyPress).toHaveBeenCalledWith(expected);
    expect(adapter.keyPress).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['press Enter',                  'Enter'],
    ['press the Tab key',            'Tab'],
    ['press Escape',                 'Escape'],
    ['press the Escape key',         'Escape'],
    ['press F5',                     'F5'],
    ['press Ctrl+S',                 'Ctrl+S'],
    ['press shift+tab',              'shift+tab'],
  ])('routes "%s" → keyPress("%s")', async (subtask, expected) => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const result = await router.route(subtask);

    expect(result.handled).toBe(true);
    expect(adapter.keyPress).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['type Hello world',         'Hello world'],
    ['type "John Smith"',        'John Smith'],
    ["type 'foo bar'",           'foo bar'],
  ])('routes "%s" → typeText with stripped quotes', async (subtask, expected) => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const result = await router.route(subtask);

    expect(result.handled).toBe(true);
    expect(adapter.typeText).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['wait 200',                  200],
    ['wait 200ms',                200],
    ['wait 1s',                   1000],
    ['wait 2 seconds',            2000],
  ])('routes "%s" as bounded delay (%d ms)', async (subtask, expectedMs) => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const start = Date.now();
    const result = await router.route(subtask);
    const elapsed = Date.now() - start;

    expect(result.handled).toBe(true);
    expect(result.path).toBe('shortcut');
    // Allow slack — we just want to confirm it actually waited a noticeable
    // duration in the right ballpark.
    expect(elapsed).toBeGreaterThanOrEqual(expectedMs - 50);
    // Cap at 5s — anything longer is router-clamped.
    expect(elapsed).toBeLessThan(Math.min(expectedMs, 5000) + 200);
  });

  it('clamps "wait 30 seconds" to 5s ceiling', async () => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const start = Date.now();
    await router.route('wait 30 seconds');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5500); // 5s + slack
  });

  it.each([
    'click the submit button',     // not a router-handled verb
    'scroll down',
    'highlight the third row',
    'screenshot the active window',
  ])('does NOT match unrelated verbs ("%s") — falls through to LLM', async (subtask) => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const result = await router.route(subtask);

    expect(result.handled).toBe(false);
    expect(adapter.keyPress).not.toHaveBeenCalled();
    expect(adapter.typeText).not.toHaveBeenCalled();
  });

  it('does NOT match compound tasks ("copy and paste")', async () => {
    const adapter = makeStubAdapter();
    const router = new Router(adapter);
    const result = await router.route('copy and paste');
    expect(result.handled).toBe(false);
    expect(result.description?.toLowerCase()).toContain('compound');
  });

  it('keyPress error returns handled:false with reason — caller can escalate', async () => {
    const adapter = makeStubAdapter();
    adapter.keyPress.mockRejectedValueOnce(new Error('keyboard busy'));
    const router = new Router(adapter);
    const result = await router.route('copy');

    expect(result.handled).toBe(false);
    expect(result.description?.toLowerCase()).toContain('keyboard busy');
  });
});
