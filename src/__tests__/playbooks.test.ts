/**
 * Playbook tests \u2014 registry, capability-based match routing, keyboard
 * choreography assertions, keys-blocklist.
 *
 * The v0.9 redesign: playbooks are capability-keyed, NOT app-keyed.
 * matchPlaybook returns 'compose-send' for any mail-shaped intent regardless
 * of which app is active. The old outlook-send / mac-mail-send pair was
 * merged into one app-agnostic compose-send playbook.
 */

import { describe, it, expect, vi } from 'vitest';
import { PLAYBOOKS, matchPlaybook } from '../tools/playbooks/index';
import { composeSend } from '../tools/playbooks/compose-send';
import { findReplace } from '../tools/playbooks/find-replace';
import { isBlockedKey, normalizeCombo, BLOCKED_KEYS } from '../tools/playbooks/keys-blocklist';
import type { PlatformAdapter } from '../platform/types';

function makeAdapter(): { adapter: PlatformAdapter; calls: any[] } {
  const calls: any[] = [];
  const adapter = {
    platform: 'win32' as const,
    init: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    checkPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    requestPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    getScreenSize: () => Promise.resolve({ physicalWidth: 1920, physicalHeight: 1080, logicalWidth: 1920, logicalHeight: 1080, dpiRatio: 1 }),
    screenshot: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    screenshotRegion: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    listWindows: () => Promise.resolve([]),
    getActiveWindow: () => Promise.resolve(null),
    focusWindow: () => Promise.resolve(true),
    maximizeWindow: () => Promise.resolve(),
    getUiTree: () => Promise.resolve([]),
    findElements: () => Promise.resolve([]),
    getFocusedElement: () => Promise.resolve(null),
    invokeElement: () => Promise.resolve({ success: true }),
    mouseClick: () => Promise.resolve(),
    mouseMove: () => Promise.resolve(),
    mouseDrag: () => Promise.resolve(),
    mouseScroll: () => Promise.resolve(),
    typeText: vi.fn((text: string) => { calls.push({ kind: 'type', text }); return Promise.resolve(); }),
    keyPress: vi.fn((combo: string) => { calls.push({ kind: 'key', combo }); return Promise.resolve(); }),
    readClipboard: () => Promise.resolve(''),
    writeClipboard: () => Promise.resolve(),
    openApp: () => Promise.resolve({}),
    launchApp: () => Promise.resolve({}),
  } as unknown as PlatformAdapter;
  return { adapter, calls };
}

describe('PLAYBOOKS registry', () => {
  it('exposes capability-keyed playbooks (NOT app-keyed)', () => {
    // Keys are capabilities. App names like 'outlook-send' or 'mac-mail-send'
    // are explicit antipatterns and must never appear here.
    const keys = Object.keys(PLAYBOOKS).sort();
    expect(keys).toEqual(['compose-send', 'find-replace']);
    for (const k of keys) {
      expect(k).not.toMatch(/outlook|mail\.app|gmail|thunderbird|spark|mac-/i);
    }
  });
});

describe('matchPlaybook (capability-based, app-agnostic)', () => {
  it('routes mail-shaped intents to compose-send regardless of active app', () => {
    expect(matchPlaybook('send email to bob', 'outlook')).toBe('compose-send');
    expect(matchPlaybook('send email to bob', 'mail')).toBe('compose-send');
    expect(matchPlaybook('send email to bob', 'thunderbird')).toBe('compose-send');
    expect(matchPlaybook('send email to bob', 'spark')).toBe('compose-send');
    expect(matchPlaybook('compose an email',   'anything')).toBe('compose-send');
    // No app name in the task either \u2014 still routes by intent.
    expect(matchPlaybook('send a message to alice@example.com', '')).toBe('compose-send');
  });
  it('routes find-and-replace to find-replace regardless of active app', () => {
    expect(matchPlaybook('find and replace X with Y', 'vscode')).toBe('find-replace');
    expect(matchPlaybook('find and replace X with Y', 'word')).toBe('find-replace');
    expect(matchPlaybook('replace all "foo" with "bar"', 'anything')).toBe('find-replace');
  });
  it('returns null when no capability matches', () => {
    expect(matchPlaybook('summarize this article', 'chrome')).toBeNull();
    expect(matchPlaybook('open paint',             'desktop')).toBeNull();
  });
});

describe('compose-send keystroke sequence', () => {
  it('fires mod+n, types To, Tab*2, types Subject, Tab, types Body, mod+Return', async () => {
    const { adapter, calls } = makeAdapter();
    const r = await composeSend({
      adapter,
      input: { to: 'bob@acme.com', subject: 'hi', body: 'body text' },
    });
    expect(r.success).toBe(true);
    const keys = calls.filter(c => c.kind === 'key').map(c => c.combo);
    expect(keys[0]).toBe('mod+n');
    expect(keys).toContain('mod+Return');
    // Last key fired must be the submit shortcut, not a stray Tab.
    expect(keys[keys.length - 1]).toBe('mod+Return');
    const types = calls.filter(c => c.kind === 'type').map(c => c.text);
    expect(types).toEqual(['bob@acme.com', 'hi', 'body text']);
  });

  it('skips a field when its value is empty', async () => {
    const { adapter, calls } = makeAdapter();
    const r = await composeSend({
      adapter,
      input: { to: 'a@b.c', body: 'only body' },
    });
    expect(r.success).toBe(true);
    const types = calls.filter(c => c.kind === 'type').map(c => c.text);
    expect(types).toEqual(['a@b.c', 'only body']);
  });
});

describe('find-replace', () => {
  it('refuses without find text', async () => {
    const { adapter } = makeAdapter();
    const r = await findReplace({ adapter, input: {} });
    expect(r.success).toBe(false);
  });
  it('fires mod+h, types find, Tab, types replace, alt+a, Escape', async () => {
    const { adapter, calls } = makeAdapter();
    const r = await findReplace({ adapter, input: { find: 'old', replace: 'new' } });
    expect(r.success).toBe(true);
    const keys = calls.filter(c => c.kind === 'key').map(c => c.combo);
    expect(keys[0]).toBe('mod+h');
    expect(keys).toContain('alt+a');
    expect(keys[keys.length - 1]).toBe('Escape');
    const types = calls.filter(c => c.kind === 'type').map(c => c.text);
    expect(types).toEqual(['old', 'new']);
  });
});

describe('keys-blocklist', () => {
  it('blocks alt+F4 regardless of casing/whitespace', () => {
    expect(isBlockedKey('Alt+F4')).toBe(true);
    expect(isBlockedKey('alt +f4')).toBe(true);
    expect(isBlockedKey('ALT-F4')).toBe(true);
  });
  it('blocks win+l, win+r, cmd+q, cmd+shift+q, ctrl+w, cmd+w', () => {
    expect(isBlockedKey('win+l')).toBe(true);
    expect(isBlockedKey('win+r')).toBe(true);
    expect(isBlockedKey('cmd+q')).toBe(true);
    expect(isBlockedKey('cmd+shift+q')).toBe(true);
    expect(isBlockedKey('ctrl+w')).toBe(true);
    expect(isBlockedKey('cmd+w')).toBe(true);
  });
  it('does not block safe combos', () => {
    expect(isBlockedKey('mod+s')).toBe(false);
    expect(isBlockedKey('Tab')).toBe(false);
    expect(isBlockedKey('Return')).toBe(false);
  });
  it('normalizes underscores and dashes', () => {
    expect(normalizeCombo('ctrl-alt-delete')).toBe('ctrl+alt+delete');
  });
  it('has at least 15 entries (was 3 in v0.8.0)', () => {
    expect(BLOCKED_KEYS.size).toBeGreaterThanOrEqual(15);
  });
});
