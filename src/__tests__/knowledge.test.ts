/**
 * Knowledge-loader tests: domain detection + bundled guides + user override +
 * workflow → prompt fragment synthesis.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectApp } from '../llm/knowledge/domain-map';
import {
  loadGuide, clearCache, getWorkflowForTask,
  saveLearnedLesson, mergeIntoUserGuide, resolveAppKey,
} from '../llm/knowledge/loader';

describe('detectApp', () => {
  it.each([
    ['https://mail.google.com/mail/u/0/#inbox', 'gmail'],
    ['outlook.live.com/owa/',                    'outlook'],
    ['https://app.slack.com/client/TABC',        'slack'],
    ['https://www.figma.com/design/abc',         'figma'],
    ['https://github.com/AmrDab/clawdcursor',    'github'],
    ['https://notion.so/workspace',              'notion'],
  ])('%s → %s', (input, expected) => {
    expect(detectApp(input)).toBe(expected);
  });

  it('falls back to title patterns when URL fails', () => {
    expect(detectApp('Gmail - mailbox of user')).toBe('gmail');
    expect(detectApp('Outlook: Inbox (12)')).toBe('outlook');
  });

  it('returns null for unknown targets', () => {
    expect(detectApp('some random custom app')).toBeNull();
    expect(detectApp('')).toBeNull();
  });
});

describe('loadGuide — bundled guides', () => {
  beforeEach(() => clearCache());

  it('loads gmail.json from the bundle', () => {
    const g = loadGuide('gmail');
    expect(g).not.toBeNull();
    expect(g!.app).toBe('gmail');
    expect(g!.shortcuts?.compose).toBe('c');
    expect(g!.workflows?.compose_and_send).toBeDefined();
  });

  it('loads outlook.json from the bundle', () => {
    const g = loadGuide('outlook');
    expect(g).not.toBeNull();
    expect(g!.shortcuts?.send).toBe('mod+Return');
  });

  it('loads slack.json from the bundle', () => {
    const g = loadGuide('slack');
    expect(g).not.toBeNull();
    expect(g!.shortcuts?.quick_switcher).toBe('mod+k');
  });

  it('returns null for unknown app', () => {
    expect(loadGuide('made-up-app-xyz')).toBeNull();
  });

  it('caches — second call returns the same reference', () => {
    const a = loadGuide('gmail');
    const b = loadGuide('gmail');
    expect(a).toBe(b);
  });
});

describe('loadGuide — user override takes precedence', () => {
  let tmpHome: string;
  const origClawdHome = process.env.CLAWD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-knowledge-test-'));
    fs.mkdirSync(path.join(tmpHome, '.clawdcursor', 'ui-knowledge'), { recursive: true });
    process.env.CLAWD_HOME = tmpHome;
    clearCache();
  });

  afterEach(() => {
    if (origClawdHome === undefined) delete process.env.CLAWD_HOME;
    else process.env.CLAWD_HOME = origClawdHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    clearCache();
  });

  it('user override wins over bundled', () => {
    const overridePath = path.join(tmpHome, '.clawdcursor', 'ui-knowledge', 'gmail.json');
    fs.writeFileSync(overridePath, JSON.stringify({
      app: 'gmail',
      name: 'Gmail (user-override)',
      shortcuts: { compose: 'C-OVERRIDE' },
    }));

    const g = loadGuide('gmail');
    expect(g!.name).toBe('Gmail (user-override)');
    expect(g!.shortcuts?.compose).toBe('C-OVERRIDE');
  });
});

describe('learn_app write path (saveLearnedLesson + mergeIntoUserGuide)', () => {
  let tmpHome: string;
  const origClawdHome = process.env.CLAWD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-knowledge-write-test-'));
    process.env.CLAWD_HOME = tmpHome;
    clearCache();
  });

  afterEach(() => {
    if (origClawdHome === undefined) delete process.env.CLAWD_HOME;
    else process.env.CLAWD_HOME = origClawdHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    clearCache();
  });

  it('resolveAppKey maps process names to canonical app keys', () => {
    expect(resolveAppKey('Notepad')).toBe('notepad');
    expect(resolveAppKey('EXCEL')).toBe('excel');
    expect(resolveAppKey('mail.google.com')).toBe('gmail');
    expect(resolveAppKey('SomeRandomApp_v3')).toBe('somerandomapp_v3');
  });

  it('saveLearnedLesson writes to user-override dir, not the bundle', () => {
    saveLearnedLesson('Notepad', 'create haiku poem', [
      { action: 'key',   description: 'press: Ctrl+N' },
      { action: 'type',  description: 'type haiku text' },
      { action: 'key',   description: 'press: Ctrl+S' },
      { action: 'done',  description: 'finished' },
    ]);

    const overridePath = path.join(tmpHome, '.clawdcursor', 'ui-knowledge', 'notepad.json');
    expect(fs.existsSync(overridePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    expect(written.learnedWorkflows.create_haiku_poem).toMatch(/Press Ctrl\+N/);
    expect(written.learnedWorkflows.create_haiku_poem).not.toMatch(/finished/); // 'done' filtered
    // Seeded from bundled — preserves curated shortcuts.
    expect(written.shortcuts.save).toBe('Ctrl+S');
  });

  it('mergeIntoUserGuide merges shortcuts + dedupes tips', () => {
    const app = mergeIntoUserGuide('Notepad', {
      shortcuts: { word_count: 'Ctrl+Shift+W' },
      tips: ['Save before exit', 'Save before exit'], // duplicate
    });
    expect(app).toBe('notepad');

    const overridePath = path.join(tmpHome, '.clawdcursor', 'ui-knowledge', 'notepad.json');
    const written = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    expect(written.shortcuts.word_count).toBe('Ctrl+Shift+W');
    expect(written.shortcuts.save).toBe('Ctrl+S'); // bundled preserved
    expect(written.tips.filter((t: string) => t === 'Save before exit')).toHaveLength(1);
  });

  it('saveLearnedLesson caps at 20 entries FIFO', () => {
    for (let i = 0; i < 25; i++) {
      saveLearnedLesson('Notepad', `task number ${i}`, [
        { action: 'type', description: 'typing' },
      ]);
    }
    const overridePath = path.join(tmpHome, '.clawdcursor', 'ui-knowledge', 'notepad.json');
    const written = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    const keys = Object.keys(written.learnedWorkflows);
    expect(keys.length).toBe(20);
    expect(keys).not.toContain('task_number_0'); // oldest evicted
    expect(keys).toContain('task_number_24');    // newest kept
  });

  it('saveLearnedLesson ignores empty / done-only action logs', () => {
    saveLearnedLesson('Notepad', 'no-op task', [
      { action: 'done', description: 'finished' },
    ]);
    const overridePath = path.join(tmpHome, '.clawdcursor', 'ui-knowledge', 'notepad.json');
    expect(fs.existsSync(overridePath)).toBe(false);
  });

  it('subsequent loadGuide picks up learned workflows after write', () => {
    saveLearnedLesson('Notepad', 'find and replace text', [
      { action: 'key', description: 'press: Ctrl+H' },
      { action: 'type', description: 'replacement text' },
    ]);
    const g = loadGuide('notepad') as any;
    expect(g.learnedWorkflows.find_and_replace_text).toMatch(/Ctrl\+H/);
  });
});

describe('getWorkflowForTask', () => {
  it('matches "send email" to compose_and_send in Gmail (★-highlighted)', () => {
    const r = getWorkflowForTask(
      'send email to bob@acme.com about lunch',
      'https://mail.google.com/mail',
    );
    expect(r).not.toBeNull();
    expect(r!.guide.app).toBe('gmail');
    expect(r!.workflow).not.toBeNull();
    // Gmail's compose_and_send is a structured AppWorkflow.
    const wf = r!.workflow as { name: string };
    expect(wf.name).toMatch(/compose/i);
    expect(r!.promptFragment).toContain('APP KNOWLEDGE — GMAIL');
    expect(r!.promptFragment).toContain('★ compose_and_send'); // marked as the active workflow
    expect(r!.promptFragment).toContain('pressKey c');
  });

  it('matches "reply" to reply workflow in Outlook', () => {
    const r = getWorkflowForTask('reply to the last email', 'outlook.live.com');
    expect(r).not.toBeNull();
    expect(r!.guide.app).toBe('outlook');
    expect(r!.promptFragment).toContain('mod+r');
    expect(r!.promptFragment).toContain('★ reply');
  });

  it('still returns the guide when no keyword matches (richer-by-default)', () => {
    // The legacy behavior was to return null on no keyword match, silently
    // suppressing all app context. v0.9: return the full guide with no
    // ★ marker. The agent gets context; the matcher just couldn't pick
    // a single workflow.
    const r = getWorkflowForTask('schedule a meeting tomorrow', 'mail.google.com');
    expect(r).not.toBeNull();
    expect(r!.workflow).toBeNull();
    expect(r!.promptFragment).toContain('APP KNOWLEDGE — GMAIL');
    expect(r!.promptFragment).not.toContain('★ '); // no workflow promoted
  });

  it('returns null when no app is detected', () => {
    expect(getWorkflowForTask('send email', 'unknown-site.com')).toBeNull();
  });

  it('prompt fragment ends with a prefer-keyboard nudge', () => {
    const r = getWorkflowForTask('search for invoice', 'mail.google.com')!;
    expect(r.promptFragment).toContain('Prefer keyboard over mouse');
  });

  it('matches "play" on youtube.com → search_and_play workflow', () => {
    const r = getWorkflowForTask(
      'play a song by adele',
      'https://www.youtube.com',
    );
    expect(r).not.toBeNull();
    expect(r!.guide.app).toBe('youtube');
    expect(r!.promptFragment).toContain('APP KNOWLEDGE — YOUTUBE');
    expect(r!.promptFragment).toContain('★ search_and_play');
    // Layout and tips are surfaced too — guide is rich, not a script.
    expect(r!.promptFragment).toMatch(/LAYOUT:/);
    expect(r!.promptFragment).toMatch(/SHORTCUTS:/);
    expect(r!.promptFragment).toMatch(/TIPS:/);
  });
});
