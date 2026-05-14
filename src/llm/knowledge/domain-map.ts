/**
 * Domain → app name mapping.
 *
 * Ported verbatim from src/ui-knowledge.ts. This is the mapping a URL or
 * window title goes through to identify which bundled `guides/<app>.json`
 * to inject into the text-agent prompt.
 *
 * Adding a new app = one row here + one JSON file in `guides/`.
 * No business logic changes required.
 */

export const DOMAIN_MAP: Record<string, string> = {
  // Google / productivity
  'mail.google.com':      'gmail',
  'gmail.com':            'gmail',
  'docs.google.com':      'google-docs',
  'sheets.google.com':    'google-sheets',
  'drive.google.com':     'google-drive',
  'calendar.google.com':  'google-calendar',
  // Microsoft / work
  'outlook.live.com':     'outlook',
  'outlook.office.com':   'outlook',
  'office.com':           'office',
  'teams.microsoft.com':  'teams',
  'sharepoint.com':       'sharepoint',
  // Collab / design
  'app.asana.com':        'asana',
  'asana.com':            'asana',
  'figma.com':            'figma',
  'app.slack.com':        'slack',
  'slack.com':            'slack',
  'notion.so':            'notion',
  'canva.com':            'canva',
  'linear.app':           'linear',
  // Media / streaming
  'youtube.com':          'youtube',
  'www.youtube.com':      'youtube',
  'm.youtube.com':        'youtube',
  'music.youtube.com':    'youtube',
  // Dev / analytics
  'github.com':           'github',
  'app.posthog.com':      'posthog',
  'amplitude.com':        'amplitude',
  'app.hex.tech':         'hex',
  'vscode.dev':           'vscode',
  // HR / finance
  'app.gusto.com':        'gusto',
  'box.com':              'box',
  'monday.com':           'monday',
};

/**
 * Title-based / process-name fallback when the URL isn't a domain match.
 * The preprocessor passes activeWindowTitle OR activeWindowProcessName here,
 * so these patterns deliberately match BOTH human-readable titles ("Microsoft
 * Edge", "Notepad", "Microsoft Outlook") AND process names ("msedge",
 * "notepad", "olk", "WINWORD", "EXCEL"). Keep terse — every rule here is a
 * heuristic that can mis-fire. Each row maps to a bundled guide filename
 * under src/llm/knowledge/guides/.
 */
export const TITLE_FALLBACKS: Array<{ pattern: RegExp; app: string }> = [
  // Web apps / cross-mode apps
  { pattern: /\bgmail\b/i,                      app: 'gmail' },
  { pattern: /\boutlook\b/i,                    app: 'outlook' },     // classic Outlook
  { pattern: /\bolk\b/i,                        app: 'olk' },         // new UWP Outlook (separate guide)
  { pattern: /\bslack\b/i,                      app: 'slack' },
  { pattern: /\bfigma\b/i,                      app: 'figma' },
  { pattern: /\basana\b/i,                      app: 'asana' },
  { pattern: /\bnotion\b/i,                     app: 'notion' },
  { pattern: /\bteams\b/i,                      app: 'teams' },
  { pattern: /\bdiscord\b/i,                    app: 'discord' },
  { pattern: /\bvs ?code\b/i,                   app: 'vscode' },
  { pattern: /\blinear\b/i,                     app: 'linear' },
  { pattern: /\byoutube\b/i,                    app: 'youtube' },

  // Native desktop apps — matched against process name OR title
  { pattern: /\b(?:notepad|note ?pad)\b/i,      app: 'notepad' },
  { pattern: /\b(?:mspaint|paint)\b/i,          app: 'mspaint' },
  { pattern: /\b(?:msedge|microsoft edge|edge browser)\b/i, app: 'msedge' },
  { pattern: /\bspotify\b/i,                    app: 'spotify' },
  { pattern: /\b(?:excel|winword|word|powerpoint)\b/i, app: 'excel' }, // Office: only Excel guide present today; falls through for Word/PPT
];

/**
 * Resolve a URL or window title to an app key. Returns null when no rule
 * fires — callers should proceed without app-specific guidance.
 */
export function detectApp(urlOrTitle: string): string | null {
  if (!urlOrTitle) return null;
  const lower = urlOrTitle.toLowerCase();
  for (const [domain, app] of Object.entries(DOMAIN_MAP)) {
    if (lower.includes(domain)) return app;
  }
  for (const { pattern, app } of TITLE_FALLBACKS) {
    if (pattern.test(urlOrTitle)) return app;
  }
  return null;
}
