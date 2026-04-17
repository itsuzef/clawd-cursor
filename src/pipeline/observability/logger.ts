/**
 * Leveled logger — replaces ad-hoc `console.log` calls throughout the pipeline.
 *
 * Design:
 *  - Four levels: debug, info, warn, error.
 *  - JSON output to rotating file at ~/.clawdcursor/logs/clawdcursor-YYYYMMDD.log.
 *  - Human output to stderr when stdout is a TTY (for CLI use).
 *  - Correlation ID pulled from AsyncLocalStorage when present (see correlation.ts).
 *  - Max file size 10 MB; keeps the 5 most recent rotated files.
 *
 * The audit counted 775 `console.*` calls across 35 files. Migrating to this
 * logger is incremental — each file is converted in the same commit as its
 * refactor, so the migration arrives with the pipeline port, not as a separate
 * mega-PR.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const KEEP_FILES = 5;

const envLevel = (process.env.CLAWD_LOG_LEVEL || 'info').toLowerCase() as Level;
const minLevel = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;

let logDir: string | null = null;
function getLogDir(): string {
  if (logDir) return logDir;
  logDir = path.join(os.homedir(), '.clawdcursor', 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
  return logDir;
}

function currentLogPath(): string {
  const d = new Date();
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return path.join(getLogDir(), `clawdcursor-${day}.log`);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_BYTES) return;
    // shift .0 .. .N-1 and bump new
    for (let i = KEEP_FILES - 2; i >= 0; i--) {
      const src = i === 0 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch { /* best-effort */ }
    }
  } catch { /* file doesn't exist — fine */ }
}

function writeLine(line: string): void {
  const filePath = currentLogPath();
  rotateIfNeeded(filePath);
  try {
    fs.appendFileSync(filePath, line + '\n');
  } catch {
    // If logging itself fails we silently drop — logger MUST NOT throw.
  }
}

const isTty = process.stderr.isTTY === true;

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  writeLine(JSON.stringify(record));
  if (isTty) {
    // Human-friendly TTY form, color-free to keep CI logs grep-able.
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${level}] ${msg}${metaStr}\n`);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  /** Child logger bound to a correlation ID — inlined into every record's meta. */
  with: (extra: Record<string, unknown>) => ({
    debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, { ...extra, ...(meta || {}) }),
    info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, { ...extra, ...(meta || {}) }),
    warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, { ...extra, ...(meta || {}) }),
    error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, { ...extra, ...(meta || {}) }),
  }),
};

export type Logger = typeof logger;
