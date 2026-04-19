/**
 * Leveled logger with TTY pretty-print + JSON file log.
 *
 * Two output surfaces:
 *
 *   1. JSON file log (stable machine-readable contract) — one
 *      `{ts, level, msg, meta}` line per event, rotated at 10 MB, 5 backups,
 *      never changes format between releases. Greppable, tailable.
 *
 *   2. TTY pretty-print (the default when stderr is a TTY) — layer-tagged,
 *      color-coded, one visual block per meaningful event. Redundant events
 *      (`safety.decision=allow`, `agent.turn.end`) are suppressed. Correlation
 *      ID + task + model lineup are printed ONCE in a header, not repeated on
 *      every line.
 *
 *      The format is designed so the reader sees "router doing X", "blind
 *      agent turn 3 thinking Y, calling tool Z", "vision fallback turn 5"
 *      at a glance — every line carries its LAYER, so there is never
 *      ambiguity about which part of the pipeline is running.
 *
 *      `CLAWD_LOG=json` disables pretty-print (useful for piping to a file
 *      or CI). `CLAWD_NO_COLOR=1` / `NO_COLOR=1` keeps pretty-print but
 *      without ANSI colors.
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

// Output modes. Default: pretty on TTY, json-only when piped. Override via
// CLAWD_LOG={json|pretty|stream|off}.
const logModeEnv = (process.env.CLAWD_LOG || '').toLowerCase();
const isTty = process.stderr.isTTY === true;
const prettyMode =
  logModeEnv === 'pretty' || logModeEnv === 'stream' ||
  (isTty && logModeEnv !== 'json' && logModeEnv !== 'off');
const ttySink = logModeEnv === 'off' ? null : 'stderr' as const;

// Color support — unused bytes dropped when NO_COLOR is set.
const supportsColor =
  isTty &&
  process.env.TERM !== 'dumb' &&
  !process.env.NO_COLOR &&
  !process.env.CLAWD_NO_COLOR;

const C = supportsColor
  ? {
      reset: '\x1b[0m',
      dim:   '\x1b[2m',
      bold:  '\x1b[1m',
      gray:  '\x1b[90m',
      red:   '\x1b[31m',
      green: '\x1b[32m',
      yellow:'\x1b[33m',
      blue:  '\x1b[34m',
      magenta:'\x1b[35m',
      cyan:  '\x1b[36m',
    }
  : { reset: '', dim: '', bold: '', gray: '', red: '', green: '', yellow: '', blue: '', magenta: '', cyan: '' };

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
    for (let i = KEEP_FILES - 2; i >= 0; i--) {
      const src = i === 0 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try { if (fs.existsSync(src)) fs.renameSync(src, dst); }
      catch { /* best-effort */ }
    }
  } catch { /* file doesn't exist — fine */ }
}

function writeJsonLine(line: string): void {
  const filePath = currentLogPath();
  rotateIfNeeded(filePath);
  try { fs.appendFileSync(filePath, line + '\n'); }
  catch { /* logger must never throw */ }
}

// ─── Event catalog ───────────────────────────────────────────────────
export const EVENTS = {
  PIPELINE_START: 'pipeline.start',
  PIPELINE_PREPROCESS: 'pipeline.preprocess',
  PIPELINE_SUBTASK: 'pipeline.subtask',
  PIPELINE_RUNG: 'pipeline.rung',
  PIPELINE_DONE: 'pipeline.done',
  AGENT_TURN_START: 'agent.turn.start',
  AGENT_THINK: 'agent.think',
  AGENT_TOOL_CALL: 'agent.tool.call',
  AGENT_TOOL_RESULT: 'agent.tool.result',
  AGENT_TURN_END: 'agent.turn.end',
  AGENT_STAGNATION: 'agent.stagnation',
  ADAPTER_CALL: 'adapter.call',
} as const;

// Per-task state — tracks the currently-active rung so subsequent
// `agent.*` events render with the correct layer tag even when the event
// meta itself doesn't carry `mode`. Reset on each pipeline.start.
const taskState = {
  currentMode: '' as '' | 'blind' | 'hybrid' | 'vision',
  currentPath: '' as '' | 'router' | 'agent',
  subtaskIndex: 0,
  subtaskTotal: 0,
  lastSafety: null as null | { tool: string; decision: string; tier: string; reason?: string },
};

/** Map event + meta → layer tag used in the pretty output. */
function layerTag(event: string, meta?: Record<string, unknown>): { label: string; color: string } {
  if (event.startsWith('safety.')) return { label: 'safety', color: C.red };
  if (event.startsWith('adapter.')) return { label: 'adapter', color: C.magenta };

  if (event.startsWith('pipeline.')) {
    // Router vs agent rung is distinguishable by meta.strategy on pipeline.rung.
    if (event === EVENTS.PIPELINE_RUNG && typeof meta?.strategy === 'string') {
      return mapStrategyTag(meta.strategy as string);
    }
    return { label: 'pipeline', color: C.cyan };
  }

  if (event.startsWith('agent.')) {
    // Prefer meta.mode when present (set on turn.start); fall back to taskState.
    const mode = (typeof meta?.mode === 'string' && meta.mode) || taskState.currentMode;
    return mapStrategyTag(String(mode || 'agent'));
  }

  return { label: 'log', color: C.gray };
}

function mapStrategyTag(strategy: string): { label: string; color: string } {
  switch (strategy) {
    case 'router': return { label: 'router', color: C.green };
    case 'blind':  return { label: 'blind',  color: C.blue };
    case 'hybrid': return { label: 'hybrid', color: C.magenta };
    case 'vision': return { label: 'vision', color: C.yellow };
    default:       return { label: strategy, color: C.cyan };
  }
}

function colorize(text: string, color: string): string {
  if (!color) return text;
  return `${color}${text}${C.reset}`;
}

function pad(text: string, len: number): string {
  // ANSI-aware right-pad so the visible width matches `len` even with
  // escape sequences in `text`.
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
  const delta = len - visible.length;
  return delta > 0 ? text + ' '.repeat(delta) : text;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Compact inline meta — excludes redundant fields (correlationId, task) that
 * are already rendered in the header.
 */
function compactArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    let val: string;
    if (typeof v === 'string') val = `"${truncate(v, 40)}"`;
    else if (typeof v === 'number' || typeof v === 'boolean') val = String(v);
    else val = truncate(JSON.stringify(v), 40);
    parts.push(`${k}=${val}`);
  }
  return parts.join(' ');
}

/**
 * TTY pretty-print — renders one visual line (or none, for suppressed events).
 * Never throws; falls back to a raw-ish line if the event isn't recognized.
 */
function prettyEmit(level: Level, event: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  if (!ttySink) return;

  // ── Suppressed noise ───────────────────────────────────────────
  // allow-decisions flood the log; we only surface blocks/confirms.
  if (event === 'safety.decision' && meta?.decision === 'allow') {
    // Stash so the next tool.call can display "· safety=allow" inline.
    taskState.lastSafety = {
      tool: String(meta.tool ?? ''),
      decision: 'allow',
      tier: String(meta.tier ?? ''),
    };
    return;
  }
  // turn.end is just the closing bracket of turn.start — already implied by
  // the next turn.start or the pipeline.done footer.
  if (event === EVENTS.AGENT_TURN_END) return;

  const tag = layerTag(event, meta);
  const tagStr = colorize(`[${pad(tag.label, 7)}]`, tag.color);

  // ── Per-event rendering ───────────────────────────────────────
  if (event === EVENTS.PIPELINE_START) {
    // Header block — correlation id + task + model lineup. Printed ONCE per task.
    taskState.currentMode = '';
    taskState.currentPath = '';
    taskState.subtaskIndex = 0;
    taskState.subtaskTotal = 0;
    taskState.lastSafety = null;

    const task = String(meta?.task ?? '');
    const cid = String(meta?.correlationId ?? '');
    const shortCid = cid.length >= 8 ? cid.slice(0, 8) : cid;
    const models = meta?.models
      ? ` · models ${meta.models}`
      : '';
    const bar = colorize('━'.repeat(72), C.gray);
    process.stderr.write('\n' + bar + '\n');
    process.stderr.write(`${colorize('▸ task', C.bold)} ${task}\n`);
    process.stderr.write(`${colorize('  run', C.dim)}  ${shortCid}${models}\n`);
    process.stderr.write(bar + '\n');
    return;
  }

  if (event === EVENTS.PIPELINE_PREPROCESS) {
    const strategy = String(meta?.strategy ?? '');
    const reason = String(meta?.reason ?? '');
    const subtasks = Number(meta?.subtasks ?? 0);
    const stratColor = mapStrategyTag(strategy).color;
    const subInfo = subtasks > 0 ? ` · ${subtasks} subtasks` : '';
    process.stderr.write(`${tagStr} preprocess → ${colorize(strategy, stratColor)}${subInfo} ${colorize(`· ${reason}`, C.dim)}\n`);
    return;
  }

  if (event === EVENTS.PIPELINE_SUBTASK) {
    const idx = Number(meta?.index ?? 0);
    const total = Number(meta?.of ?? 0);
    const subtask = String(meta?.subtask ?? '');
    taskState.subtaskIndex = idx;
    taskState.subtaskTotal = total;
    process.stderr.write('\n');
    process.stderr.write(`${tagStr} ${colorize(`▸ subtask ${idx}/${total}`, C.bold)} "${subtask}"\n`);
    return;
  }

  if (event === EVENTS.PIPELINE_RUNG) {
    const strategy = String(meta?.strategy ?? '');
    const attempt = Number(meta?.attempt ?? 1);
    taskState.currentMode = (strategy === 'blind' || strategy === 'hybrid' || strategy === 'vision')
      ? strategy
      : '';
    taskState.currentPath = strategy === 'router' ? 'router' : 'agent';
    const stratColor = mapStrategyTag(strategy).color;
    const attemptLabel = attempt > 1 ? ` (retry ${attempt})` : '';
    process.stderr.write(`${tagStr} ↳ ${colorize(strategy, stratColor)}${attemptLabel}\n`);
    return;
  }

  if (event === 'pipeline.rung.failed') {
    const strategy = String(meta?.strategy ?? '');
    const reason = String(meta?.reason ?? '');
    process.stderr.write(`${tagStr} ${colorize('↳ miss', C.yellow)} ${strategy} · ${reason}\n`);
    return;
  }

  if (event === EVENTS.PIPELINE_DONE) {
    const success = !!meta?.success;
    const pathStr = String(meta?.path ?? '');
    const costUsd = Number(meta?.costUsd ?? 0);
    const durationMs = Number(meta?.durationMs ?? 0);
    const icon = success ? colorize('✅', C.green) : colorize('❌', C.red);
    const bar = colorize('━'.repeat(72), C.gray);
    process.stderr.write('\n' + bar + '\n');
    process.stderr.write(`  ${icon} ${colorize(success ? 'done' : 'failed', C.bold)} · path=${pathStr} · $${costUsd.toFixed(4)} · ${formatMs(durationMs)}\n`);
    process.stderr.write(bar + '\n');
    return;
  }

  if (event === EVENTS.AGENT_TURN_START) {
    const turn = Number(meta?.turn ?? 0);
    const mode = String(meta?.mode ?? taskState.currentMode ?? '');
    taskState.currentMode = (mode === 'blind' || mode === 'hybrid' || mode === 'vision') ? mode : taskState.currentMode;
    process.stderr.write(`${tagStr} ${colorize(`  turn ${turn}`, C.dim)}\n`);
    return;
  }

  if (event === EVENTS.AGENT_THINK) {
    const text = String(meta?.text ?? '').trim();
    if (!text) return;
    const clipped = truncate(text, 140);
    process.stderr.write(`${tagStr} ${colorize('    think', C.dim)}  ${clipped}\n`);
    return;
  }

  if (event === EVENTS.AGENT_TOOL_CALL) {
    const tool = String(meta?.tool ?? '');
    const args = (meta?.args ?? {}) as Record<string, unknown>;
    const argsStr = compactArgs(args);
    const safety = taskState.lastSafety;
    const safetyInline = safety && safety.decision !== 'allow'
      ? ` ${colorize(`· safety=${safety.decision}(${safety.tier})`, C.red)}`
      : '';
    taskState.lastSafety = null;
    process.stderr.write(`${tagStr} ${colorize('    →', C.cyan)} ${colorize(tool, C.bold)}(${argsStr})${safetyInline}\n`);
    return;
  }

  if (event === EVENTS.AGENT_TOOL_RESULT) {
    const success = !!meta?.success;
    const text = String(meta?.text ?? '');
    const ms = Number(meta?.ms ?? 0);
    const mark = success ? colorize('    ✓', C.green) : colorize('    ✗', C.red);
    const latency = colorize(`(${formatMs(ms)})`, C.dim);
    process.stderr.write(`${tagStr} ${mark} ${truncate(text, 90)} ${latency}\n`);
    return;
  }

  if (event === EVENTS.AGENT_STAGNATION) {
    const window = Number(meta?.window ?? 0);
    process.stderr.write(`${tagStr} ${colorize(`    ⚠ stagnation`, C.yellow)} — last ${window} screens unchanged\n`);
    return;
  }

  // safety block/confirm paths (allow was suppressed above)
  if (event === 'safety.decision') {
    const decision = String(meta?.decision ?? '');
    const reason = String(meta?.reason ?? '');
    process.stderr.write(`${tagStr} ${colorize(`⛔ ${decision}`, C.red)} — ${reason}\n`);
    return;
  }

  // Unknown or less-common events — one compact line.
  if (level === 'warn' || level === 'error') {
    const reason = meta?.reason || meta?.error || meta?.text || '';
    const rest = compactArgs(stripHeaderMeta(meta));
    const prefix = level === 'error' ? colorize('✗ error', C.red) : colorize('! warn', C.yellow);
    process.stderr.write(`${tagStr} ${prefix} ${event} ${reason ? `· ${truncate(String(reason), 80)}` : ''}${rest ? ` ${colorize(rest, C.dim)}` : ''}\n`);
    return;
  }

  if (level === 'debug') return; // stay quiet at debug

  // Default info rendering for anything not explicitly handled.
  const rest = compactArgs(stripHeaderMeta(meta));
  process.stderr.write(`${tagStr} ${event}${rest ? ` ${colorize(rest, C.dim)}` : ''}\n`);
}

function stripHeaderMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'correlationId' || k === 'task' || k === 'mode') continue;
    out[k] = v;
  }
  return out;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

// ─── Public logger entry points ─────────────────────────────────────

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  // File log ALWAYS gets the full JSON record (machine contract).
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  writeJsonLine(JSON.stringify(record));

  // TTY: pretty if we're a TTY / user opted in. Otherwise raw JSON-line.
  if (prettyMode) {
    prettyEmit(level, msg, meta);
  } else if (ttySink === 'stderr') {
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${level}] ${msg}${metaStr}\n`);
  }
}

/**
 * Begin a nested span. Currently a no-op on pretty format (indentation is
 * baked into per-event rendering); kept for API compatibility with callers
 * that wrap turns / playbook steps in spans.
 */
export function beginSpan(): { end: () => void } {
  let ended = false;
  return { end: () => { ended = true; void ended; } };
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  /** Child logger bound to a correlation ID — inlined into every JSON record's meta. */
  with: (extra: Record<string, unknown>) => ({
    debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, { ...extra, ...(meta || {}) }),
    info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, { ...extra, ...(meta || {}) }),
    warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, { ...extra, ...(meta || {}) }),
    error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, { ...extra, ...(meta || {}) }),
  }),
  span: beginSpan,
};

export type Logger = typeof logger;
