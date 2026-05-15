/**
 * Pipeline introspection tools — expose the autonomous loop's planning
 * context to external brains.
 *
 * When an agent uses `submit_task` (autonomous mode), clawdcursor's
 * preprocessor injects rich context into the LLM prompt: app-detection,
 * guides, strategy choice, decomposition, capability classification,
 * playbook matches, web-service routing. External brains driving tools
 * directly (editor hosts over stdio MCP, OpenClaw over HTTP MCP) never
 * see any of that — they get raw primitives only.
 *
 * These four tools close that gap. Each is a thin read-only wrapper over
 * an existing pipeline module — zero duplication, zero drift risk.
 *
 *   get_app_guide       — explicit app-knowledge query (shortcuts, workflows,
 *                          layout, tips, prompt fragment)
 *   detect_app          — URL / window title → canonical app key
 *   classify_task       — full preprocessor decision-as-a-service (strategy,
 *                          subtasks, capability, playbook, guide, reason)
 *   get_system_prompt   — agent's canonical system prompt (web-service
 *                          policy, escape hatches, termination rules) so
 *                          external brains can match clawdcursor's stance
 *
 * Compact compound: all four are exposed via `system` (alongside
 * clipboard_*, ocr, undo, shortcuts_*, detect_webview, etc.).
 *
 * Safety: tier 0 (read-only). No side effects.
 */

import type { ToolDefinition } from './types';
import { detectApp, loadGuide, renderAppKnowledge } from '../llm/knowledge/loader';
import { preprocess } from '../core/preprocessor/preprocessor';
import { buildSystemPrompt } from '../core/agent-loop/prompt';

export function getIntrospectionTools(): ToolDefinition[] {
  return [
    // ── get_app_guide ────────────────────────────────────────────────────
    {
      name: 'get_app_guide',
      description:
        'Return the app-knowledge guide for an app: keyboard shortcuts, ' +
        'workflow patterns, layout cues, tips, and the formatted prompt ' +
        'fragment the autonomous pipeline would inject into its LLM system ' +
        'prompt. External brains (editor hosts, OpenClaw, any HTTP-MCP ' +
        'client) call this to get the same app expertise the autonomous loop ' +
        'gets for free. Pass either `app` (canonical key like "gmail", ' +
        '"youtube") or `urlOrTitle` (the URL or window title the tool will ' +
        'resolve via detectApp). Returns `appKey: null` and an empty ' +
        'promptFragment when neither resolves.',
      parameters: {
        app: {
          type: 'string',
          description: 'Canonical app key (e.g. "gmail", "youtube", "outlook")',
          required: false,
        },
        urlOrTitle: {
          type: 'string',
          description: 'URL or window title to resolve into an app key',
          required: false,
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ app, urlOrTitle }) => {
        const appStr = typeof app === 'string' && app ? app : null;
        const hint   = typeof urlOrTitle === 'string' && urlOrTitle ? urlOrTitle : null;
        if (!appStr && !hint) {
          return { text: 'get_app_guide: pass either `app` or `urlOrTitle`', isError: true };
        }
        const key = appStr ?? detectApp(hint!);
        if (!key) {
          return {
            text: JSON.stringify({
              appKey: null,
              resolved: false,
              promptFragment: '',
            }),
          };
        }
        const guide = loadGuide(key);
        if (!guide) {
          return {
            text: JSON.stringify({
              appKey: key,
              resolved: true,
              hasGuide: false,
              promptFragment: '',
            }),
          };
        }
        return {
          text: JSON.stringify({
            appKey: key,
            resolved: true,
            hasGuide: true,
            name: guide.name,
            shortcuts: guide.shortcuts ?? {},
            workflows: guide.workflows ?? {},
            layout: guide.layout ?? {},
            tips: guide.tips ?? [],
            promptFragment: renderAppKnowledge(guide),
          }),
        };
      },
    },

    // ── detect_app ───────────────────────────────────────────────────────
    {
      name: 'detect_app',
      description:
        'Resolve a URL or window title to clawdcursor\'s canonical app key. ' +
        'Returns `{ appKey: "gmail" }` for "mail.google.com" / "Gmail - Inbox", ' +
        '`{ appKey: null }` when no rule matches. Pure function; same lookup ' +
        'the autonomous pipeline uses internally.',
      parameters: {
        urlOrTitle: {
          type: 'string',
          description: 'URL like "mail.google.com" or title like "Gmail - Inbox"',
          required: true,
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ urlOrTitle }) => {
        const s = typeof urlOrTitle === 'string' ? urlOrTitle : '';
        return { text: JSON.stringify({ appKey: detectApp(s) }) };
      },
    },

    // ── classify_task ────────────────────────────────────────────────────
    {
      name: 'classify_task',
      description:
        'Run the autonomous pipeline\'s preprocessor over a task description ' +
        'and return what it would have decided WITHOUT executing the task. ' +
        'External brains use this to mirror clawdcursor\'s routing choices: ' +
        'which strategy ladder (router/blind/hybrid/vision/playbook), how to ' +
        'decompose compound tasks into subtasks, which capability is at play ' +
        '(navigation/app_launch/text_input/form_fill/spatial/...), which ' +
        'playbook (if any) matches, the active-app guide reference, and the ' +
        'short telemetry reason for the choice. Pure read; zero side effects.',
      parameters: {
        task: {
          type: 'string',
          description: 'Natural-language task to classify',
          required: true,
        },
        activeWindowTitle: {
          type: 'string',
          description: 'Optional active window title for app-detection context',
          required: false,
        },
        activeWindowProcessName: {
          type: 'string',
          description: 'Optional active window process name for app-detection context',
          required: false,
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ task, activeWindowTitle, activeWindowProcessName }) => {
        const t = typeof task === 'string' ? task : '';
        if (!t.trim()) {
          return { text: 'classify_task: task must be a non-empty string', isError: true };
        }
        const decision = preprocess(t, {
          activeWindowTitle:
            typeof activeWindowTitle === 'string' && activeWindowTitle ? activeWindowTitle : undefined,
          activeWindowProcessName:
            typeof activeWindowProcessName === 'string' && activeWindowProcessName
              ? activeWindowProcessName
              : undefined,
        });
        return {
          text: JSON.stringify({
            strategy:     decision.strategy,
            subtasks:     decision.subtasks,
            appKey:       decision.hints.appKey ?? null,
            capability:   decision.hints.capability ?? null,
            playbookName: decision.hints.playbookName ?? null,
            reason:       decision.hints.reason,
            guide:        decision.hints.guide ?? null,
            classification: decision.classification,
          }),
        };
      },
    },

    // ── get_system_prompt ────────────────────────────────────────────────
    {
      name: 'get_system_prompt',
      description:
        'Return the canonical agent system prompt for a given strategy mode ' +
        '(blind / hybrid / vision). Use this to mirror clawdcursor\'s ' +
        'behavioral rules in your own agent loop — coordinate syntax, key ' +
        'combo syntax, web-service policy (never type "browser" into search ' +
        'bars), protocol escape hatches (mailto:/https:/file:/...), ' +
        'stagnation recovery, termination rules (done/give_up/cannot_read), ' +
        'untrusted-screen-content discipline. Reflects the prompt at the ' +
        'current installed clawdcursor version — pull this rather than ' +
        'hardcoding rules so they stay in sync with upstream changes.',
      parameters: {
        mode: {
          type: 'string',
          description: 'Agent mode: "blind" (a11y only), "hybrid" (a11y + on-demand screenshots), or "vision" (screenshot per turn)',
          enum: ['blind', 'hybrid', 'vision'],
          required: false,
          default: 'blind',
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ mode }) => {
        const m: 'blind' | 'hybrid' | 'vision' =
          mode === 'vision' ? 'vision' : mode === 'hybrid' ? 'hybrid' : 'blind';
        return {
          text: JSON.stringify({
            mode: m,
            prompt: buildSystemPrompt(m),
          }),
        };
      },
    },
  ];
}
