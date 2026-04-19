/**
 * Playbook tests — registry, match routing, keyboard choreography assertions,
 * keys-blocklist.
 */

import { describe, it, expect, vi } from 'vitest';
import { PLAYBOOKS, matchPlaybook } from '../pipeline/playbooks/index';
import { outlookSend } from '../pipeline/playbooks/outlook-send';
import { macMailSend } from '../pipeline/playbooks/mac-mail-send';
import { findReplace } from '../pipeline/playbooks/find-replace';
import { isBlockedKey, normalizeCombo, BLOCKED_KEYS } from '../pipeline/playbooks/keys-blocklist';
import type { PlatformAdapter } from '../v2/platform/types';

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
  it('exposes three canonical playbooks', () => {
    expect(Object.keys(PLAYBOOKS).sort()).toEqual(['find-replace', 'mac-mail-send', 'outlook-send']);
  });
});

describe('matchPlaybook', () => {
  it('routes outlook "send email" to outlook-send', () => {
    expect(matchPlaybook('send email to bob', 'outlook')).toBe('outlook-send');
    expect(matchPlaybook('compose an email',   'OUTLOOK')).toBe('outlook-send');
  });
  it('routes mac Mail.app to mac-mail-send', () => {
    expect(matchPlaybook('send email to bob', 'mail')).toBe('mac-mail-send');
  });
  it('routes find-and-replace to find-replace', () => {
    expect(matchPlaybook('find and replace X with Y', 'vscode')).toBe('find-replace');
  });
  it('returns null when nothing matches', () => {
    expect(matchPlaybook('summarize this article', 'chrome')).toBeNull();
  });
});

describe('outlook-send keystroke sequence', () => {
  it('fires mod+n, Tab×2, subject, Tab, body, mod+Return in order', async () => {
    const { adapter, calls } = makeAdapter();
    const r = await outlookSend({
      adapter,
      input: { to: 'bob@acme.com', subject: 'hi', body: 'body text' },
    });
    expect(r.success).toBe(true);
    const keys = calls.filter(c => c.kind === 'key').map(c => c.combo);
    // mod+n → Tab → Tab (past Cc/Bcc) → Tab (into body) → mod+Return
    expect(keys[0]).toBe('mod+n');
    expect(keys).toContain('mod+Return');
    const types = calls.filter(c => c.kind === 'type').map(c => c.text);
    expect(types).toContain('bob@acme.com');
    expect(types).toContain('hi');
    expect(types).toContain('body text');
  });
});

describe('mac-mail-send keystroke sequence', () => {
  it('uses mod+shift+d as primary send', async () => {
    const { adapter, calls } = makeAdapter();
    await macMailSend({ adapter, input: { to: 'a@b.c', subject: 's', body: 'b' } });
    const keys = calls.filter(c => c.kind === 'key').map(c => c.combo);
    expect(keys).toContain('mod+shift+d');
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
