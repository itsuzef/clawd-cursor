/**
 * HTTP Server — REST API for controlling the agent.
 * 
 * Endpoints:
 *   GET  /           — Web dashboard
 *   POST /task       — submit a new task
 *   GET  /status     — get agent state
 *   POST /confirm    — approve/reject a pending action
 *   POST /abort      — abort current task
 *   GET  /screenshot — get current screen
 *   GET  /logs       — recent log entries as JSON
 *   GET  /health     — health check
 *   POST /stop       — graceful shutdown (localhost only)
 *   GET  /favorites  — list saved favorite commands
 *   POST /favorites  — add a command to favorites
 *   DELETE /favorites — remove a command from favorites
 *   POST /report     — submit an error report (opt-in)
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { ClawdConfig } from './types';
import { Agent } from './agent';
import { mountDashboard } from './dashboard';
import { VERSION } from './version';
import { DATA_DIR } from './paths';
import { e } from './format';

// Favorites persistence — stored in ~/.clawdcursor/ so it persists across cwd changes
const FAVORITES_PATH = join(DATA_DIR, '.clawdcursor-favorites.json');

// ── Bearer token auth ─────────────────────────────────────────────────────────
// Generated once at startup, persisted to ~/.clawdcursor/token so the
// dashboard and external callers can read it. Rotates on every fresh start.
//
// v0.8.2 — silent-401 bug fix. Previous versions compared the incoming Bearer
// token against an in-memory SERVER_TOKEN only. If a SECOND clawdcursor process
// started (e.g. the pidfile guard saw a stale/dead pid and took over, or a
// different mode was invoked concurrently), that second process rewrote the
// token FILE but the first server's in-memory SERVER_TOKEN was never updated.
// Clients reading the file sent the new token; the old server rejected it
// silently — /health kept returning 200, making the failure invisible.
//
// Fix: the file is the source of truth. requireAuth() reads the on-disk token
// (cached with an mtime gate so it's ~free on repeat calls) and accepts EITHER
// the original in-memory SERVER_TOKEN or the current file token. This ensures
// clients and server can never drift — whatever's on disk is always valid.
const TOKEN_PATH = join(DATA_DIR, 'token');

function generateToken(): string {
  const token = randomBytes(32).toString('hex');
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_PATH, token, { encoding: 'utf-8', mode: 0o600 });
  } catch (tokenErr) {
    console.warn(`${e('⚠', '[WARN]')} Could not write auth token file:`, (tokenErr as Error).message);
  }
  return token;
}

// Token is generated lazily (only when createServer is first called, i.e. `start`).
// This prevents CLI commands like `stop`, `task`, `consent` from overwriting the
// running server's token file on import.
export let SERVER_TOKEN = '';

/** Initialize the auth token. Called once from createServer(). */
export function initServerToken(): string {
  SERVER_TOKEN = generateToken();
  diskTokenCache = { token: SERVER_TOKEN, mtimeMs: nowMs(), nextCheckMs: 0 };
  return SERVER_TOKEN;
}

/** Disk-token cache with mtime invalidation. Zero I/O on hot auth paths. */
let diskTokenCache: { token: string; mtimeMs: number; nextCheckMs: number } | null = null;
const DISK_TOKEN_TTL_MS = 500; // re-check the file at most twice per second

function nowMs(): number { return Date.now(); }

/**
 * Read the current on-disk token. Caches the value; re-reads only if the
 * file's mtime has changed AND enough time has passed since the last check.
 * Returns '' if the file is missing or unreadable (caller falls back to
 * SERVER_TOKEN alone in that case).
 */
function currentDiskToken(): string {
  const now = nowMs();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  try {
    if (diskTokenCache && now < diskTokenCache.nextCheckMs) {
      return diskTokenCache.token;
    }
    const stat = fs.statSync(TOKEN_PATH);
    const mtimeMs = stat.mtimeMs;
    if (diskTokenCache && diskTokenCache.mtimeMs === mtimeMs) {
      diskTokenCache.nextCheckMs = now + DISK_TOKEN_TTL_MS;
      return diskTokenCache.token;
    }
    const token = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    diskTokenCache = { token, mtimeMs, nextCheckMs: now + DISK_TOKEN_TTL_MS };
    return token;
  } catch {
    // Missing file or I/O error — return empty so callers fall back to memory.
    return '';
  }
}

/** Constant-time token compare (v0.8.1). Replaces the v0.8.0 `!==` which
 *  short-circuits on first mismatch and leaks byte-level timing to any
 *  attacker who can measure localhost response latency. */
function timingSafeTokenEqual(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Compare against self to keep timing stable when lengths differ.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('crypto').timingSafeEqual(a, a);
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('crypto').timingSafeEqual(a, b);
}

/**
 * Middleware: require Authorization: Bearer <token> on mutating endpoints.
 *
 * v0.8.2: accepts EITHER the in-memory `SERVER_TOKEN` (original, set when
 * this process started) OR the current on-disk token. This means a second
 * clawdcursor process that rotated the file doesn't silently 401 clients
 * that read the new token from disk. Warns in the JSON log the first time
 * we observe drift, so operators can see when this happens.
 */
let loggedTokenDrift = false;
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers['authorization'] || '';
  const received = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const memoryOk = timingSafeTokenEqual(received, SERVER_TOKEN);
  let diskOk = false;
  if (!memoryOk) {
    const diskToken = currentDiskToken();
    if (diskToken && diskToken !== SERVER_TOKEN) {
      // Token file was rotated by a different process. Tell the operator once.
      if (!loggedTokenDrift) {
        loggedTokenDrift = true;
        console.warn(
          `${e('⚠', '[WARN]')} Auth token file was rewritten by another process. ` +
          `Accepting either the original or the new token to avoid silent 401s. ` +
          `Run \`clawdcursor stop\` once and restart if you want a single canonical token.`,
        );
      }
      diskOk = timingSafeTokenEqual(received, diskToken);
    }
  }

  if (!memoryOk && !diskOk) {
    res.status(401).json({ error: 'Unauthorized — include Authorization: Bearer <token> header. Token is at ~/.clawdcursor/token' });
    return;
  }
  next();
}

function loadFavorites(): string[] {
  try {
    if (existsSync(FAVORITES_PATH)) {
      const data = readFileSync(FAVORITES_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (favErr) {
    console.warn(`${e('⚠', '[WARN]')} Failed to load favorites:`, (favErr as Error).message);
  }
  return [];
}

function saveFavorites(favorites: string[]): void {
  try {
    writeFileSync(FAVORITES_PATH, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch (saveErr) {
    console.error(`${e('❌', '[ERR]')} Failed to save favorites:`, (saveErr as Error).message);
  }
}

// In-memory log buffer
interface LogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];

const MAX_LOG_MSG_LEN = 500;

function addLog(level: LogEntry['level'], message: string): void {
  // Truncate oversized messages (e.g. full LLM responses) to keep the buffer lean
  const truncated = message.length > MAX_LOG_MSG_LEN
    ? message.slice(0, MAX_LOG_MSG_LEN) + '\u2026'
    : message;
  logBuffer.push({ timestamp: Date.now(), level, message: truncated });
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  }
}

/**
 * Intercept console methods to capture logs into the buffer.
 * Preserves original behavior.
 */
let consoleHooked = false;
function hookConsole(): void {
  if (consoleHooked) return;
  consoleHooked = true;

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    // Classify message
    const lower = msg.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('❌')) {
      addLog('error', msg);
    } else if (lower.includes('✅') || lower.includes('success') || lower.includes('completed')) {
      addLog('success', msg);
    } else if (lower.includes('⚠') || lower.includes('warn')) {
      addLog('warn', msg);
    } else {
      addLog('info', msg);
    }
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
    addLog('error', msg);
  };

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    addLog('warn', msg);
  };
}

const taskSchema = z.object({
  task: z.string().trim().min(1).max(2000),
});

const confirmSchema = z.object({
  approved: z.boolean(),
});

export function createServer(agent: Agent, config: ClawdConfig): express.Express {
  // NOTE: initServerToken() is NOT called here — it's called from the listen
  // callback in index.ts AFTER the port binds successfully. This prevents
  // overwriting a valid token when start fails (e.g. EADDRINUSE).

  // Hook console to capture logs
  hookConsole();

  const app = express();
  app.use(express.json());

  // ── CORS: block browser-origin requests to prevent SSRF/localhost-bypass attacks ──
  // The dashboard at GET / is exempt (browser tab). All API routes require:
  //   1. Non-browser origin (no Origin header), OR same origin, OR explicit allowlist
  //   2. Bearer token (on mutating endpoints)
  app.use((req, res, next) => {
    const origin = req.headers['origin'];
    // Allow: no origin (curl, CLI, direct), or localhost origins
    const allowedOrigins = [
      'http://localhost:3847',
      'http://127.0.0.1:3847',
    ];
    if (origin) {
      if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');
      } else {
        // Cross-origin browser request — block it
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        res.status(403).json({ error: 'Cross-origin requests not allowed' });
        return;
      }
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Handle malformed JSON gracefully (e.g. control characters from terminal)
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
    next(err);
  });

  // Mount the web dashboard at GET / — pass token getter for client-side auth
  // SECURITY: Token is injected into page JS — only safe when bound to localhost.
  if (config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
    console.warn(`${e('⚠️', '[WARN]')} Dashboard token exposed in page JS — only safe on localhost (current host: ${config.server.host})`);
  }
  mountDashboard(app, () => SERVER_TOKEN);

  // --- Favorites endpoints ---

  // Get all favorites (auth required — contains user data)
  app.get('/favorites', requireAuth, (_req, res) => {
    res.json(loadFavorites());
  });

  // Add a favorite
  app.post('/favorites', requireAuth, (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" string in body' });
    }
    const favorites = loadFavorites();
    const trimmed = parsed.data.task;
    if (!favorites.includes(trimmed)) {
      favorites.push(trimmed);
      saveFavorites(favorites);
    }
    res.json({ ok: true, favorites });
  });

  // Remove a favorite
  app.delete('/favorites', requireAuth, (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" string in body' });
    }
    const favorites = loadFavorites();
    const trimmed = parsed.data.task;
    const idx = favorites.indexOf(trimmed);
    if (idx === -1) {
      return res.status(404).json({ error: 'Favorite not found' });
    }
    favorites.splice(idx, 1);
    saveFavorites(favorites);
    res.json({ ok: true, favorites });
  });

  // Submit a task
  app.post('/task', requireAuth, async (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "task" in body' });
    }

    const { task } = parsed.data;
    // returnPartial: when true, skip Stage 3 vision and return partial results
    // so the calling agent can finish with MCP tools (smarter than one-shot vision)
    const returnPartial = req.body.returnPartial === true;
    const state = agent.getState();
    if (state.status !== 'idle') {
      return res.status(409).json({
        error: 'Agent is busy',
        state,
      });
    }

    console.log(`\n${e('📨', '>')} New task received: ${task}${returnPartial ? ' (returnPartial — skip vision fallback)' : ''}`);

    // Pass returnPartial to agent so it knows to skip Stage 3
    if (returnPartial) {
      (agent as any)._returnPartial = true;
    }

    // Execute async — respond immediately
    agent.executeTask(task).then(result => {
      (agent as any)._returnPartial = false;
      console.log(`\n${e('📋', '>')} Task result:`, JSON.stringify(result, null, 2));
    }).catch(err => {
      (agent as any)._returnPartial = false;
      console.error(`\n${e('❌', '[ERR]')} Task execution failed:`, err);
    });

    res.json({ accepted: true, task, returnPartial });
  });

  // Learn — external agents report what they discovered about an app
  // Saves workflows, shortcuts, and tips to the app's guide JSON
  app.post('/learn', requireAuth, async (req, res) => {
    const { processName, task, actions, shortcuts, tips } = req.body;
    if (!processName) {
      return res.status(400).json({ error: 'Missing "processName" in body' });
    }

    try {
      const { saveLesson, loadGuide } = require('../dist/guide-loader');
      const fs = require('fs');
      const path = require('path');

      // Save learned workflow from action sequence
      if (task && actions && Array.isArray(actions)) {
        saveLesson(processName, task, actions);
      }

      // Merge additional shortcuts and tips into the guide
      const guidesDir = path.join(__dirname, '..', 'guides');
      const guide = loadGuide(processName);
      if (guide && (shortcuts || tips)) {
        const guidePath = path.join(guidesDir, (guide.processNames?.[0] || processName) + '.json');
        if (fs.existsSync(guidePath)) {
          const raw = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
          if (shortcuts && typeof shortcuts === 'object') {
            raw.shortcuts = { ...raw.shortcuts, ...shortcuts };
          }
          if (tips && Array.isArray(tips)) {
            raw.tips = [...new Set([...(raw.tips || []), ...tips])];
          }
          fs.writeFileSync(guidePath, JSON.stringify(raw, null, 2));
        }
      }

      console.log(`${e('📝', '[LEARN]')} External agent reported lesson for "${processName}"`);
      res.json({ saved: true, processName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get current status
  app.get('/status', (req, res) => {
    res.json(agent.getState());
  });

  // Task logs — structured JSONL logs for every task (auth required — contains task history)
  app.get('/task-logs', requireAuth, (_req, res) => {
    try {
      const logger = (agent as any).logger;
      if (!logger) return res.json([]);
      res.json(logger.getRecentSummaries(50));
    } catch { res.json([]); }
  });

  app.get('/task-logs/current', requireAuth, (_req, res) => {
    try {
      const logger = (agent as any).logger;
      const logPath = logger?.getCurrentLogPath();
      if (!logPath || !require('fs').existsSync(logPath)) {
        return res.status(404).json({ error: 'No current log' });
      }
      const content = require('fs').readFileSync(logPath, 'utf-8');
      const entries = content.trim().split('\n').map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.json(entries);
    } catch { res.status(500).json({ error: 'Failed to read log' }); }
  });

  // Approve or reject a pending confirmation
  app.post('/confirm', requireAuth, (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing "approved" boolean in body' });
    }

    const { approved } = parsed.data;
    const safety = agent.getSafety();
    if (!safety.hasPendingConfirmation()) {
      return res.status(404).json({ error: 'No pending confirmation' });
    }

    const pending = safety.getPendingAction();
    safety.respondToConfirmation(approved);

    res.json({
      confirmed: approved,
      action: pending?.description,
    });
  });

  // Abort current task
  app.post('/abort', requireAuth, (req, res) => {
    agent.abort();
    res.json({ aborted: true });
  });

  // Get recent log entries (auth required — may contain sensitive info)
  app.get('/logs', requireAuth, (req, res) => {
    res.json(logBuffer);
  });

  // Screenshot — returns PNG image of current screen
  app.get('/screenshot', requireAuth, async (_req, res) => {
    try {
      const desktop = agent.getDesktop();
      const frame = await desktop.captureForLLM();
      res.set('Content-Type', 'image/png');
      res.set('X-Scale-Factor', String(frame.scaleFactor));
      res.set('X-Screen-Width', String(frame.llmWidth));
      res.set('X-Screen-Height', String(frame.llmHeight));
      res.send(frame.buffer);
    } catch (err) {
      res.status(500).json({ error: `Screenshot failed: ${(err as Error).message}` });
    }
  });

  // Direct action execution — lets an external brain (e.g. Claude Code) drive the agent
  // Coordinates are in LLM-space (1280px wide) — auto-scaled to real screen
  app.post('/action', requireAuth, async (req, res) => {
    try {
      const { action, x, y, text, key, button, scrollDelta } = req.body;
      if (!action) return res.status(400).json({ error: 'Missing "action" field' });

      const desktop = agent.getDesktop();
      const screen = desktop.getScreenSize();
      const LLM_WIDTH = 1280;
      const scale = screen.width > LLM_WIDTH ? screen.width / LLM_WIDTH : 1;

      const realX = x != null ? Math.round(Number(x) * scale) : 0;
      const realY = y != null ? Math.round(Number(y) * scale) : 0;

      switch (action) {
        case 'click':
          if (x == null || y == null) return res.status(400).json({ error: 'click requires x, y' });
          await desktop.executeMouseAction({ kind: button === 'right' ? 'right_click' : 'click', x: realX, y: realY });
          res.json({ ok: true, action: 'click', x, y, realX, realY });
          break;
        case 'double_click':
          if (x == null || y == null) return res.status(400).json({ error: 'double_click requires x, y' });
          await desktop.executeMouseAction({ kind: 'double_click', x: realX, y: realY });
          res.json({ ok: true, action: 'double_click', x, y, realX, realY });
          break;
        case 'type':
          if (!text) return res.status(400).json({ error: 'type requires text' });
          await desktop.executeKeyboardAction({ kind: 'type', text });
          res.json({ ok: true, action: 'type', length: text.length });
          break;
        case 'key':
          if (!key) return res.status(400).json({ error: 'key requires key' });
          await desktop.executeKeyboardAction({ kind: 'key_press', key });
          res.json({ ok: true, action: 'key', key });
          break;
        case 'scroll':
          if (x == null || y == null) return res.status(400).json({ error: 'scroll requires x, y' });
          await desktop.executeMouseAction({ kind: 'scroll', x: realX, y: realY, scrollDelta: Number(scrollDelta || 3) });
          res.json({ ok: true, action: 'scroll', x, y, realX, realY, scrollDelta: scrollDelta || 3 });
          break;
        case 'move':
          if (x == null || y == null) return res.status(400).json({ error: 'move requires x, y' });
          await desktop.executeMouseAction({ kind: 'move', x: realX, y: realY });
          res.json({ ok: true, action: 'move', x, y, realX, realY });
          break;
        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
      }
    } catch (err) {
      res.status(500).json({ error: `Action failed: ${(err as Error).message}` });
    }
  });

  // Error report — opt-in submission of redacted task logs
  app.post('/report', requireAuth, async (req, res) => {
    try {
      const { apiSubmitReport } = await import('./report');
      const { userNote, logIndex } = req.body || {};
      const result = await apiSubmitReport({
        userNote: typeof userNote === 'string' ? userNote : undefined,
        logIndex: typeof logIndex === 'number' ? logIndex : undefined,
      });
      if (result.success) {
        res.json({ success: true, reportId: result.reportId, preview: result.preview });
      } else {
        res.status(result.error === 'No task logs found' ? 404 : 502).json({
          success: false,
          error: result.error,
          reportId: result.reportId,
          preview: result.preview,
        });
      }
    } catch (err) {
      res.status(500).json({ error: `Report failed: ${(err as Error).message}` });
    }
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });

  // Graceful shutdown (localhost only)
  app.post('/stop', requireAuth, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Stop is only allowed from localhost' });
    }

    // Send response, then exit after it's flushed
    const body = JSON.stringify({ stopped: true, message: 'Clawd Cursor stopped' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body, () => {
      // Response fully flushed — now shut down
      console.log(`\n${e('👋', '--')} Shutting down (stop command received)...`);
      agent.disconnect();
      // Force exit after short delay (covers Windows edge cases)
      setTimeout(() => process.exit(0), 500);
    });
    // Failsafe: force exit even if flush hangs
    setTimeout(() => process.exit(1), 3000);
  });

  return app;
}
