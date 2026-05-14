/**
 * Web-service URL table — natural-language service name → canonical URL.
 *
 * Consulted by the router AFTER `APP_ALIASES` misses but BEFORE Start-Menu
 * launch strategies. So "open youtube" routes through `handleUrlNav(youtube.com)`
 * instead of typing "youtube" into the Start Menu (which fails, then escalates
 * to the blind agent, which in v0.9 was observed typing "default browser"
 * into a search bar — the failure mode this table closes).
 *
 * Add a row when a service is web-only (no native client most users would
 * have) OR when the typical user intent is the web version. Native-client
 * preference stays in APP_ALIASES — e.g. `outlook` resolves to desktop
 * Outlook there, even though `outlook.live.com` is a valid web URL.
 *
 * No business logic. Pure data. Adding an entry is mechanical.
 */

import { normalizeAppName } from './normalize';

export const WEB_SERVICES: Record<string, string> = {
  // ── Streaming / media ──────────────────────────────────────────────────
  'youtube':            'https://www.youtube.com',
  'youtube music':      'https://music.youtube.com',
  'netflix':            'https://www.netflix.com',
  'twitch':             'https://www.twitch.tv',
  'soundcloud':         'https://soundcloud.com',
  'spotify web':        'https://open.spotify.com',
  'hulu':               'https://www.hulu.com',
  'disney plus':        'https://www.disneyplus.com',
  'prime video':        'https://www.primevideo.com',
  'apple music':        'https://music.apple.com',
  // ── Social ─────────────────────────────────────────────────────────────
  'twitter':            'https://twitter.com',
  'x':                  'https://x.com',
  'reddit':             'https://www.reddit.com',
  'facebook':           'https://www.facebook.com',
  'instagram':          'https://www.instagram.com',
  'linkedin':           'https://www.linkedin.com',
  'tiktok':             'https://www.tiktok.com',
  'threads':            'https://www.threads.net',
  'bluesky':            'https://bsky.app',
  'pinterest':          'https://www.pinterest.com',
  'mastodon':           'https://joinmastodon.org',
  // ── Knowledge / search ─────────────────────────────────────────────────
  'google':             'https://www.google.com',
  'bing':               'https://www.bing.com',
  'duckduckgo':         'https://duckduckgo.com',
  'wikipedia':          'https://www.wikipedia.org',
  'wolfram alpha':      'https://www.wolframalpha.com',
  'wolframalpha':       'https://www.wolframalpha.com',
  // ── Mail / productivity (WEB version) ──────────────────────────────────
  'gmail':              'https://mail.google.com',
  'google drive':       'https://drive.google.com',
  'google docs':        'https://docs.google.com',
  'google sheets':      'https://sheets.google.com',
  'google slides':      'https://slides.google.com',
  'google calendar':    'https://calendar.google.com',
  'google maps':        'https://www.google.com/maps',
  'google translate':   'https://translate.google.com',
  'outlook web':        'https://outlook.live.com',
  'office':             'https://www.office.com',
  // ── Dev ────────────────────────────────────────────────────────────────
  'github':             'https://github.com',
  'gitlab':             'https://gitlab.com',
  'stack overflow':     'https://stackoverflow.com',
  'stackoverflow':      'https://stackoverflow.com',
  'codepen':            'https://codepen.io',
  'replit':             'https://replit.com',
  'vercel':             'https://vercel.com',
  'npm':                'https://www.npmjs.com',
  // ── AI assistants ──────────────────────────────────────────────────────
  'chatgpt':            'https://chat.openai.com',
  'claude':             'https://claude.ai',
  'gemini':             'https://gemini.google.com',
  'perplexity':         'https://www.perplexity.ai',
  'copilot':            'https://copilot.microsoft.com',
  // ── E-commerce / utility ───────────────────────────────────────────────
  'amazon':             'https://www.amazon.com',
  'ebay':               'https://www.ebay.com',
  'etsy':               'https://www.etsy.com',
  'walmart':            'https://www.walmart.com',
  // ── Communication (web fallbacks for desktop clients) ──────────────────
  'whatsapp web':       'https://web.whatsapp.com',
  'whatsapp':           'https://web.whatsapp.com',
  'telegram web':       'https://web.telegram.org',
  // ── News / reading ─────────────────────────────────────────────────────
  'hacker news':        'https://news.ycombinator.com',
  'hackernews':         'https://news.ycombinator.com',
  'medium':             'https://medium.com',
  'substack':           'https://substack.com',
};

/**
 * Resolve a user-facing service name to its canonical URL. Goes through
 * `normalizeAppName` so phrasings like "youtube site", "the YouTube app",
 * and `"YouTube"` all match the same key. Returns null when unknown — the
 * caller falls back to whatever it was doing before (Start-Menu launch,
 * blind agent, etc.).
 *
 * App-agnostic by construction: this function never branches on a specific
 * service. Add a new row to `WEB_SERVICES` to extend coverage.
 */
export function resolveWebService(name: string): string | null {
  if (!name) return null;
  const k = normalizeAppName(name);
  if (k && WEB_SERVICES[k]) return WEB_SERVICES[k];
  const literal = name.trim().toLowerCase().replace(/['"`‘’“”]/g, '');
  return WEB_SERVICES[literal] ?? null;
}
