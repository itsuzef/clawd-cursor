/**
 * Knowledge-loader tests: domain detection + bundled guides + user override +
 * workflow → prompt fragment synthesis.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectApp } from '../pipeline/knowledge/domain-map';
import { loadGuide, clearCache, getWorkflowForTask } from '../pipeline/knowledge/loader';

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

describe('getWorkflowForTask', () => {
  it('matches "send email" to compose_and_send in Gmail', () => {
    const r = getWorkflowForTask(
      'send email to bob@acme.com about lunch',
      'https://mail.google.com/mail',
    );
    expect(r).not.toBeNull();
    expect(r!.guide.app).toBe('gmail');
    expect(r!.workflow.name).toMatch(/compose/i);
    expect(r!.promptFragment).toContain('APP KNOWLEDGE — GMAIL:');
    expect(r!.promptFragment).toContain('pressKey c');
  });

  it('matches "reply" to reply workflow in Outlook', () => {
    const r = getWorkflowForTask('reply to the last email', 'outlook.live.com');
    expect(r).not.toBeNull();
    expect(r!.guide.app).toBe('outlook');
    expect(r!.promptFragment).toContain('mod+r');
  });

  it('returns null when the task has no matching workflow', () => {
    expect(getWorkflowForTask('schedule a meeting tomorrow', 'mail.google.com')).toBeNull();
  });

  it('returns null when no app is detected', () => {
    expect(getWorkflowForTask('send email', 'unknown-site.com')).toBeNull();
  });

  it('prompt fragment ends with a prefer-keyboard nudge', () => {
    const r = getWorkflowForTask('search for invoice', 'mail.google.com')!;
    expect(r.promptFragment).toContain('Prefer keyboard over mouse');
  });
});
