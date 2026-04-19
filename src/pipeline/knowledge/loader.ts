/**
 * App-knowledge loader.
 *
 * Ported from src/ui-knowledge.ts. Two key changes over the legacy:
 *
 *   1. **Bundled guides ship with the package** (`pipeline/knowledge/guides/*.json`)
 *      so a fresh install has real app-knowledge from day one. The legacy layer
 *      pointed at `~/.clawdcursor/ui-knowledge/` which shipped empty — making
 *      the whole feature stubbed. We now bundle and overlay.
 *
 *   2. **User override directory** at `${home}/.clawdcursor/ui-knowledge/`
 *      (still controlled by `CLAWD_HOME`). A file there takes precedence over
 *      the bundled version — users or Cloudana can ship updated guides
 *      without a clawdcursor release.
 *
 * The Cloudana DB hook (`TODO` in legacy L91) stays dormant. When it lands,
 * this file grows a remote-fetch pathway *before* the user-override check.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AppGuide, AppWorkflow } from '../types';
import { detectApp } from './domain-map';

export { detectApp };

function bundledGuidesDir(): string {
  // Module is at src/pipeline/knowledge/loader.ts → bundled guides live next to it.
  return path.join(__dirname, 'guides');
}

function userGuidesDir(): string {
  const home = process.env.CLAWD_HOME || os.homedir();
  return path.join(home, '.clawdcursor', 'ui-knowledge');
}

/** Cache keyed on app name. null = previously-attempted miss (don't re-read disk). */
const cache = new Map<string, AppGuide | null>();

/**
 * Load an `AppGuide` by app key. User override (if present) wins over bundled.
 * Returns null if neither exists. Cached for the life of the process.
 */
export function loadGuide(app: string): AppGuide | null {
  if (cache.has(app)) return cache.get(app) ?? null;

  const userPath    = path.join(userGuidesDir(), `${app}.json`);
  const bundledPath = path.join(bundledGuidesDir(), `${app}.json`);
  const target = fs.existsSync(userPath) ? userPath : (fs.existsSync(bundledPath) ? bundledPath : null);

  if (!target) {
    cache.set(app, null);
    return null;
  }

  try {
    const raw = fs.readFileSync(target, 'utf8');
    const guide = JSON.parse(raw) as AppGuide;
    cache.set(app, guide);
    return guide;
  } catch {
    cache.set(app, null);
    return null;
  }
}

/** Clear the cache — tests call this when they mutate the user override dir. */
export function clearCache(): void {
  cache.clear();
}

/**
 * Resolve a task description + current URL/title to an injected prompt
 * fragment describing the known workflow, if any.
 *
 * Returns null when no app is detected or no matching workflow exists.
 * The text-agent consumes this as a trusted prompt addendum.
 */
export function getWorkflowForTask(taskText: string, urlOrTitle: string): {
  guide: AppGuide;
  workflow: AppWorkflow;
  promptFragment: string;
} | null {
  const app = detectApp(urlOrTitle);
  if (!app) return null;

  const guide = loadGuide(app);
  if (!guide || !guide.workflows) return null;

  const taskLower = taskText.toLowerCase();

  // Keyword → workflow key mapping. Kept identical to v0.8.0 legacy to avoid
  // accidentally changing which workflow fires on which phrase.
  const MATCH: Record<string, string[]> = {
    compose_and_send: ['send email', 'compose', 'write email', 'new email', 'email to'],
    reply:            ['reply', 'respond'],
    reply_all:        ['reply all'],
    forward:          ['forward'],
    search:           ['search', 'find email', 'look for'],
    archive:          ['archive'],
    delete_:          ['delete email', 'trash'],
    go_to_inbox:      ['go to inbox', 'open inbox', 'inbox'],
  };

  let workflow: AppWorkflow | null = null;
  for (const [key, keywords] of Object.entries(MATCH)) {
    if (keywords.some(kw => taskLower.includes(kw)) && guide.workflows[key]) {
      workflow = guide.workflows[key];
      break;
    }
  }

  if (!workflow) return null;

  const steps = workflow.steps.map((s, i) => {
    if (s.type === 'pressKey')    return `${i + 1}. pressKey ${s.key}${s.note ? ` (${s.note})` : ''}`;
    if (s.type === 'typeAtFocus') return `${i + 1}. typeAtFocus — the ${s.field}${s.note ? ` (${s.note})` : ''}`;
    if (s.type === 'click')       return `${i + 1}. click ${s.target}${s.note ? ` (${s.note})` : ''}`;
    if (s.type === 'wait')        return `${i + 1}. wait ${s.ms}ms${s.note ? ` (${s.note})` : ''}`;
    return `${i + 1}. verify ${s.name ?? ''}`;
  }).join('\n');

  const shortcutLine = guide.shortcuts && Object.keys(guide.shortcuts).length
    ? `Known shortcuts: ${Object.entries(guide.shortcuts).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : '';
  const notesLine = guide.tips?.length ? `Tips: ${guide.tips.join('; ')}` : '';

  const promptFragment = [
    `APP KNOWLEDGE — ${guide.name.toUpperCase()}:`,
    `Use this EXACT sequence for "${workflow.name}":`,
    steps,
    shortcutLine,
    notesLine,
    'Follow this sequence precisely. Prefer keyboard over mouse.',
  ].filter(Boolean).join('\n');

  return { guide, workflow, promptFragment };
}
