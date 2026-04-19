/**
 * Decompose tests — quote-aware compound split + verb-guard + LLM fallback parse.
 */

import { describe, it, expect, vi } from 'vitest';
import { decompose, splitCompound } from '../pipeline/decompose/parser';
import { decomposeWithLlm, extractJson } from '../pipeline/decompose/llm-decomposer';

describe('splitCompound', () => {
  it('splits on " and "', () => {
    expect(splitCompound('open notepad and type hello')).toEqual(['open notepad', 'type hello']);
  });
  it('splits on " then "', () => {
    expect(splitCompound('click File then click Save')).toEqual(['click File', 'click Save']);
  });
  it('splits on commas', () => {
    expect(splitCompound('click File, click Save, click Close')).toEqual(['click File', 'click Save', 'click Close']);
  });
  it('is quote-aware — single quotes', () => {
    expect(splitCompound("type 'hello, world' and press Enter")).toEqual(["type 'hello, world'", 'press Enter']);
  });
  it('is quote-aware — double quotes', () => {
    expect(splitCompound('type "and then some" and press Enter')).toEqual(['type "and then some"', 'press Enter']);
  });
  it('returns single-element array for non-compound', () => {
    expect(splitCompound('click Send')).toEqual(['click Send']);
  });
});

describe('decompose', () => {
  it('rejects empty input', () => {
    expect(decompose('')).toBeNull();
    expect(decompose('   ')).toBeNull();
  });

  it('returns subtasks when every part has a clear action verb', () => {
    const r = decompose('open notepad and type hello and press Ctrl+S');
    expect(r?.subtasks).toEqual(['open notepad', 'type hello', 'press Ctrl+S']);
    expect(r?.keptAsOne).toBe(false);
  });

  it('keeps as one unit when a split part lacks a verb', () => {
    // "through all emails" has no actionable verb → keep the whole task together
    const r = decompose('scroll through all emails and the unread ones');
    expect(r?.subtasks).toEqual(['scroll through all emails and the unread ones']);
    expect(r?.keptAsOne).toBe(true);
  });

  it('handles single-task input', () => {
    expect(decompose('open Chrome')?.subtasks).toEqual(['open Chrome']);
  });

  it('preserves quoted content across split', () => {
    const r = decompose('send "hello, this is urgent" and close the window');
    expect(r?.subtasks).toEqual(['send "hello, this is urgent"', 'close the window']);
  });
});

describe('extractJson', () => {
  it('extracts plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('extracts from fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts JSON embedded in prose', () => {
    expect(extractJson('Here is the output: {"subtasks":["x","y"]} done.')).toEqual({ subtasks: ['x', 'y'] });
  });
  it('returns null on garbage', () => {
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('decomposeWithLlm', () => {
  it('returns subtasks on good JSON response', async () => {
    const callTextLlm = vi.fn().mockResolvedValue('{"subtasks":["open notepad","type hello"]}');
    const r = await decomposeWithLlm('open notepad then type hello', { callTextLlm });
    expect(r).toEqual(['open notepad', 'type hello']);
    expect(callTextLlm).toHaveBeenCalledTimes(1);
  });

  it('returns null when model returns no json', async () => {
    const callTextLlm = vi.fn().mockResolvedValue('I do not know how to decompose');
    expect(await decomposeWithLlm('mystery task', { callTextLlm })).toBeNull();
  });

  it('returns null when subtasks is empty', async () => {
    const callTextLlm = vi.fn().mockResolvedValue('{"subtasks":[]}');
    expect(await decomposeWithLlm('x', { callTextLlm })).toBeNull();
  });

  it('strips non-string entries', async () => {
    const callTextLlm = vi.fn().mockResolvedValue('{"subtasks":["a", 42, "b", null, "", "c"]}');
    expect(await decomposeWithLlm('x', { callTextLlm })).toEqual(['a', 'b', 'c']);
  });
});
