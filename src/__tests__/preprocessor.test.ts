/**
 * Preprocessor tests — strategy decisions per task shape.
 */

import { describe, it, expect } from 'vitest';
import { preprocess, requiresLlm, usesVision } from '../pipeline/preprocessor/preprocessor';

describe('preprocess — strategy selection', () => {
  it.each([
    ['open notepad',              'router'],
    ['launch Chrome',             'router'],
    ['go to github.com',          'router'],
    ['navigate to https://x.com', 'router'],
    ['focus Slack',               'router'],
    ['switch to Outlook',         'router'],
  ])('%s → router', (task, expected) => {
    expect(preprocess(task).strategy).toBe(expected);
  });

  it.each([
    'draw a square on the canvas',
    'sketch a house',
    'drag the icon to the trash',
    'paint the background red',
  ])('%s → vision (spatial)', (task) => {
    expect(preprocess(task).strategy).toBe('vision');
  });

  it.each([
    'click the blue button in the top right',
    'click the red area at the bottom left',
  ])('%s → hybrid (visual wording)', (task) => {
    expect(preprocess(task).strategy).toBe('hybrid');
  });

  it.each([
    'type hello world',
    'click Send',
    'compute 5 plus 7 in calculator',
    'summarize this screen',
    'fill out the registration form',
    'send email to bob@x.com',
  ])('%s → blind', (task) => {
    expect(preprocess(task).strategy).toBe('blind');
  });
});

describe('preprocess — subtasks', () => {
  it('splits compound tasks when each part has an action verb', () => {
    const r = preprocess('open notepad and type hello');
    expect(r.subtasks).toEqual(['open notepad', 'type hello']);
  });

  it('keeps non-splittable compound as one task', () => {
    const r = preprocess('scroll through all emails and the unread ones');
    expect(r.subtasks).toEqual([]); // kept as one — executor runs whole
  });
});

describe('preprocess — knowledge injection', () => {
  it('attaches Gmail guide when active window is Gmail', () => {
    const r = preprocess('send email to bob@acme.com', {
      activeWindowTitle: 'mail.google.com - Inbox',
    });
    expect(r.hints.appKey).toBe('gmail');
    expect(r.hints.guide).toBeDefined();
    expect(r.hints.guide?.promptFragment).toMatch(/gmail/i);
  });

  it('attaches Outlook guide when active window is Outlook', () => {
    const r = preprocess('reply to the last email', {
      activeWindowTitle: 'Inbox — Outlook',
    });
    expect(r.hints.appKey).toBe('outlook');
  });

  it('no guide when app is unknown', () => {
    const r = preprocess('type something', {
      activeWindowTitle: 'Notepad',
    });
    expect(r.hints.guide).toBeUndefined();
  });
});

describe('preprocess — hints include telemetry reason', () => {
  it('router pick carries reason', () => {
    expect(preprocess('open chrome').hints.reason).toMatch(/router-pattern/i);
  });
  it('spatial pick carries reason', () => {
    expect(preprocess('draw a circle').hints.reason).toMatch(/spatial/i);
  });
  it('default pick carries reason', () => {
    expect(preprocess('summarize the article').hints.reason).toMatch(/default/i);
  });
});

describe('requiresLlm / usesVision predicates', () => {
  it('router is the only no-LLM strategy', () => {
    expect(requiresLlm('router')).toBe(false);
    expect(requiresLlm('blind')).toBe(true);
    expect(requiresLlm('hybrid')).toBe(true);
    expect(requiresLlm('vision')).toBe(true);
  });
  it('vision and hybrid use screenshots', () => {
    expect(usesVision('vision')).toBe(true);
    expect(usesVision('hybrid')).toBe(true);
    expect(usesVision('blind')).toBe(false);
    expect(usesVision('router')).toBe(false);
  });
});
