/**
 * Pipeline introspection tools — exercises the 4 read-only tools that
 * give external brains the planning context the autonomous loop gets
 * injected automatically.
 *
 * These are thin wrappers over the existing preprocessor / loader /
 * prompt builder, so the tests focus on:
 *   - shape of the returned JSON (callers parse and rely on it)
 *   - parameter validation (clear error on bad input)
 *   - that the wrappers don't drift from the underlying modules
 *     (resolving the same task here as in the autonomous loop should
 *     produce the same strategy / capability / appKey)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { getIntrospectionTools } from '../tools/introspection';
import type { ToolContext } from '../tools/types';

function findTool(name: string) {
  const t = getIntrospectionTools().find(t => t.name === name);
  if (!t) throw new Error('tool not found: ' + name);
  return t;
}

function makeCtx(): ToolContext {
  return {
    desktop: null, a11y: null, cdp: null,
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
  } as unknown as ToolContext;
}

// Point the bundled-guides resolver at the seed-registry copies for the
// gmail / outlook / youtube tests — same pattern other tests use.
const SEED_REGISTRY = path.resolve(__dirname, '../../seed-registry/guides');
const ORIG_BUNDLED  = process.env.CLAWD_BUNDLED_GUIDES_DIR;
const ORIG_OFF      = process.env.CLAWD_GUIDES_REGISTRY_OFF;
beforeAll(() => {
  process.env.CLAWD_BUNDLED_GUIDES_DIR = SEED_REGISTRY;
  process.env.CLAWD_GUIDES_REGISTRY_OFF = '1';
});
afterAll(() => {
  if (ORIG_BUNDLED === undefined) delete process.env.CLAWD_BUNDLED_GUIDES_DIR;
  else process.env.CLAWD_BUNDLED_GUIDES_DIR = ORIG_BUNDLED;
  if (ORIG_OFF === undefined) delete process.env.CLAWD_GUIDES_REGISTRY_OFF;
  else process.env.CLAWD_GUIDES_REGISTRY_OFF = ORIG_OFF;
});

describe('introspection — tool surface', () => {
  it('exposes 4 tools, all in the `system` compound, all tier 0', () => {
    const tools = getIntrospectionTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'classify_task', 'detect_app', 'get_app_guide', 'get_system_prompt',
    ]);
    for (const t of tools) {
      expect(t.compactGroup).toBe('system');
      expect(t.safetyTier).toBe(0);
      expect(t.category).toBe('orchestration');
    }
  });
});

describe('detect_app', () => {
  it('resolves a known URL to the canonical app key', async () => {
    const r = await findTool('detect_app').handler({ urlOrTitle: 'mail.google.com' }, makeCtx());
    expect(JSON.parse(r.text).appKey).toBe('gmail');
  });

  it('resolves a window title via the title-fallback patterns', async () => {
    const r = await findTool('detect_app').handler({ urlOrTitle: 'Inbox — Outlook' }, makeCtx());
    expect(JSON.parse(r.text).appKey).toBe('outlook');
  });

  it('returns appKey=null for unknown input', async () => {
    const r = await findTool('detect_app').handler({ urlOrTitle: 'SomeRandomApp_v3' }, makeCtx());
    expect(JSON.parse(r.text).appKey).toBeNull();
  });

  it('handles empty / missing input gracefully', async () => {
    const r = await findTool('detect_app').handler({ urlOrTitle: '' }, makeCtx());
    expect(JSON.parse(r.text).appKey).toBeNull();
  });
});

describe('get_app_guide', () => {
  it('returns full guide content + prompt fragment for an explicit app key', async () => {
    const r = await findTool('get_app_guide').handler({ app: 'gmail' }, makeCtx());
    const out = JSON.parse(r.text);
    expect(out.appKey).toBe('gmail');
    expect(out.resolved).toBe(true);
    expect(out.hasGuide).toBe(true);
    expect(out.shortcuts).toBeDefined();
    expect(typeof out.promptFragment).toBe('string');
    expect(out.promptFragment).toContain('APP KNOWLEDGE');
    expect(out.promptFragment).toContain('GMAIL');
  });

  it('resolves via urlOrTitle when app is not given', async () => {
    const r = await findTool('get_app_guide').handler(
      { urlOrTitle: 'https://www.youtube.com/watch?v=abc' },
      makeCtx(),
    );
    const out = JSON.parse(r.text);
    expect(out.appKey).toBe('youtube');
    expect(out.hasGuide).toBe(true);
    expect(Object.keys(out.shortcuts).length).toBeGreaterThan(20); // youtube has 39
  });

  it('returns hasGuide=false for a resolved key with no guide on disk', async () => {
    // detectApp returns 'sharepoint' for 'sharepoint.com' but no sharepoint guide
    // ships today.
    const r = await findTool('get_app_guide').handler(
      { urlOrTitle: 'https://my.sharepoint.com/foo' },
      makeCtx(),
    );
    const out = JSON.parse(r.text);
    expect(out.appKey).toBe('sharepoint');
    expect(out.resolved).toBe(true);
    expect(out.hasGuide).toBe(false);
    expect(out.promptFragment).toBe('');
  });

  it('errors when neither app nor urlOrTitle is given', async () => {
    const r = await findTool('get_app_guide').handler({}, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/either `app` or `urlOrTitle`/);
  });
});

describe('classify_task', () => {
  it('routes "open chrome" as a router pick', async () => {
    const r = await findTool('classify_task').handler({ task: 'open chrome' }, makeCtx());
    const out = JSON.parse(r.text);
    expect(out.strategy).toBe('router');
    expect(out.reason).toMatch(/router/i);
  });

  it('classifies "send email to bob@acme.com" as the compose-send playbook', async () => {
    const r = await findTool('classify_task').handler({ task: 'send email to bob@acme.com' }, makeCtx());
    const out = JSON.parse(r.text);
    expect(out.strategy).toBe('playbook');
    expect(out.playbookName).toBe('compose-send');
  });

  it('attaches Gmail guide when activeWindowTitle is Gmail', async () => {
    const r = await findTool('classify_task').handler(
      { task: 'compose new email', activeWindowTitle: 'Gmail - Inbox' },
      makeCtx(),
    );
    const out = JSON.parse(r.text);
    expect(out.appKey).toBe('gmail');
    expect(out.guide).not.toBeNull();
    expect(out.guide.appName).toBeDefined();
    expect(typeof out.guide.promptFragment).toBe('string');
  });

  it('rejects empty task with a clear error', async () => {
    const r = await findTool('classify_task').handler({ task: '' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/non-empty/);
  });
});

describe('get_system_prompt', () => {
  it('returns a populated prompt for the default (blind) mode', async () => {
    const r = await findTool('get_system_prompt').handler({}, makeCtx());
    const out = JSON.parse(r.text);
    expect(out.mode).toBe('blind');
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt.length).toBeGreaterThan(500);
    // Should contain the v0.9 web-service policy section we added.
    expect(out.prompt).toMatch(/WEB-SERVICE POLICY/i);
  });

  it('switches phrasing for vision mode', async () => {
    const blind  = JSON.parse((await findTool('get_system_prompt').handler({ mode: 'blind'  }, makeCtx())).text).prompt;
    const vision = JSON.parse((await findTool('get_system_prompt').handler({ mode: 'vision' }, makeCtx())).text).prompt;
    expect(blind).not.toBe(vision);
    expect(vision).toMatch(/initial screenshot/i);
  });

  it('coerces unknown mode to blind', async () => {
    const r = await findTool('get_system_prompt').handler({ mode: 'bogus' }, makeCtx());
    expect(JSON.parse(r.text).mode).toBe('blind');
  });
});
