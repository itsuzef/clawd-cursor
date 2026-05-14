/**
 * Scheduled-task tools — cron-driven task scheduling for the autonomous agent.
 *
 * The daemon mode (`clawdcursor agent` with an LLM configured) can run tasks
 * autonomously via `submit_task`. The scheduler adds a persistent recurring
 * dimension: schedule a task with a cron expression, and the daemon will fire
 * it on every matching tick — same execution path as `submit_task`, same
 * safety chokepoint, same verifier.
 *
 * Storage:
 *   $CLAWD_HOME/.clawdcursor/scheduled-tasks.json — array of ScheduledTask.
 *
 * Lifecycle:
 *   - Daemon boot: `initScheduler(agent, logger)` reads the file and registers
 *     active cron jobs with the in-process scheduler.
 *   - Daemon shutdown: `stopScheduler()` unregisters all jobs cleanly.
 *   - MCP tool calls mutate the file and the in-process registry together.
 *
 * Auth: every tool here is gated by the same bearer-token middleware that
 * protects every MCP HTTP call (`requireAuth` in mcp-server.ts). Stdio MCP
 * clients can also call these tools but `ctx.agent` is null on stdio, so
 * the tool returns an error — same pattern as submit_task.
 *
 * Reentrancy: if a scheduled task fires while the agent is busy, we log
 * and SKIP. No queue. Simpler, predictable, and matches what users expect
 * — "if I'm in the middle of something, don't pile on."
 *
 * Cron parser: `croner` (~7 KB, zero deps). Standard 5-field cron syntax
 * plus optional 6th field for seconds; timezones via the schedule's `tz`
 * field. We validate with `Cron.nextRun` at create time and refuse invalid
 * patterns up front rather than at first tick.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cron } from 'croner';
import type { ToolDefinition, ToolContext } from './types';
import type { Agent } from '../core/agent';

// Path is computed dynamically (not module-loaded constant) so tests can
// redirect via CLAWD_HOME without re-importing the module. Matches the
// pattern in src/llm/knowledge/cache.ts.
function dataDir(): string {
  return path.join(process.env.CLAWD_HOME || os.homedir(), '.clawdcursor');
}
function scheduledTasksPath(): string {
  return path.join(dataDir(), 'scheduled-tasks.json');
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  /** Stable id — `s_<base36-timestamp>_<rand>`. Used to delete/toggle. */
  id: string;
  /** Cron expression (5 or 6 field). */
  cron: string;
  /** Natural-language task to submit on every tick. */
  task: string;
  /** False to mute without deleting. Cron job is unregistered while disabled. */
  enabled: boolean;
  /** Optional timezone (e.g. "America/New_York"). Default: server-local. */
  tz?: string;
  /** Wall-clock created-at, ms since epoch. */
  createdAt: number;
  /** Last successful submission tick, ms since epoch. Null = never fired. */
  lastRun: number | null;
  /** Last error message from the most recent fire (null when clean). */
  lastError: string | null;
  /** Number of times this task has fired. */
  runCount: number;
  /** Number of times the agent was busy and we skipped. */
  skipCount: number;
}

interface PersistedShape {
  schemaVersion: 1;
  tasks: ScheduledTask[];
}

// ── Persistence ────────────────────────────────────────────────────────────

function loadAll(): ScheduledTask[] {
  try {
    if (!fs.existsSync(scheduledTasksPath())) return [];
    const raw = JSON.parse(fs.readFileSync(scheduledTasksPath(), 'utf-8')) as PersistedShape | ScheduledTask[];
    // Tolerate both bare array (early form) and the wrapped shape.
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.tasks)) return raw.tasks;
    return [];
  } catch {
    return [];
  }
}

function saveAll(tasks: ScheduledTask[]): void {
  if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true });
  const data: PersistedShape = { schemaVersion: 1, tasks };
  fs.writeFileSync(scheduledTasksPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// ── Cron registry (in-process) ─────────────────────────────────────────────

/** Active cron job handles keyed by ScheduledTask.id. */
const jobs = new Map<string, Cron>();

let boundAgent: Agent | null = null;
let boundLog: { info?: (e: string, d?: unknown) => void; warn?: (e: string, d?: unknown) => void; error?: (e: string, d?: unknown) => void } | null = null;

function ensureBound(): { ok: true; agent: Agent } | { ok: false; reason: string } {
  if (!boundAgent) return { ok: false, reason: 'scheduler not initialized — daemon must call initScheduler() at boot' };
  return { ok: true, agent: boundAgent };
}

/**
 * Fire a single scheduled task. Safe to call concurrently — internally checks
 * agent.getState().status and skips if busy. Never throws to the caller.
 */
async function fireTask(t: ScheduledTask): Promise<void> {
  const b = ensureBound();
  if (!b.ok) {
    boundLog?.warn?.('scheduler.fire.no_agent', { id: t.id });
    return;
  }
  try {
    const state = b.agent.getState();
    if (state.status !== 'idle') {
      boundLog?.info?.('scheduler.skip_busy', { id: t.id, agentStatus: state.status });
      const tasks = loadAll();
      const found = tasks.find(x => x.id === t.id);
      if (found) {
        found.skipCount += 1;
        saveAll(tasks);
      }
      return;
    }
    boundLog?.info?.('scheduler.fire', { id: t.id, cron: t.cron, task: t.task.slice(0, 60) });
    // Fire-and-forget — same pattern as submit_task. Errors surface via
    // agent state + the daemon log buffer.
    b.agent.executeTask(t.task).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      boundLog?.warn?.('scheduler.execute_error', { id: t.id, error: msg });
      const tasks = loadAll();
      const found = tasks.find(x => x.id === t.id);
      if (found) {
        found.lastError = msg.slice(0, 200);
        saveAll(tasks);
      }
    });
    const tasks = loadAll();
    const found = tasks.find(x => x.id === t.id);
    if (found) {
      found.lastRun = Date.now();
      found.runCount += 1;
      found.lastError = null;
      saveAll(tasks);
    }
  } catch (err) {
    boundLog?.error?.('scheduler.fire.threw', { id: t.id, error: (err as Error).message });
  }
}

function registerJob(t: ScheduledTask): { ok: true } | { ok: false; reason: string } {
  if (jobs.has(t.id)) {
    jobs.get(t.id)!.stop();
    jobs.delete(t.id);
  }
  if (!t.enabled) return { ok: true };
  try {
    const job = new Cron(t.cron, { timezone: t.tz, protect: true }, () => fireTask(t));
    jobs.set(t.id, job);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `cron register failed: ${(err as Error).message}` };
  }
}

function unregisterJob(id: string): void {
  const job = jobs.get(id);
  if (job) {
    job.stop();
    jobs.delete(id);
  }
}

// ── Public lifecycle ───────────────────────────────────────────────────────

/**
 * Wire the scheduler to a running agent + logger. Called once from the daemon
 * boot. Loads persisted tasks and registers all enabled crons. Idempotent.
 */
export function initScheduler(
  agent: Agent,
  log?: { info?: (e: string, d?: unknown) => void; warn?: (e: string, d?: unknown) => void; error?: (e: string, d?: unknown) => void },
): { registered: number; failed: number; paused: number } {
  boundAgent = agent;
  boundLog   = log ?? null;
  let registered = 0, failed = 0, paused = 0;
  for (const t of loadAll()) {
    if (!t.enabled) { paused += 1; continue; }
    const r = registerJob(t);
    if (r.ok) registered += 1;
    else { failed += 1; boundLog?.warn?.('scheduler.boot.register_failed', { id: t.id, reason: r.reason }); }
  }
  boundLog?.info?.('scheduler.booted', { registered, failed, paused, totalActive: jobs.size });
  return { registered, failed, paused };
}

/** Stop every active cron job. Daemon shutdown hook. */
export function stopScheduler(): void {
  for (const [, job] of jobs) job.stop();
  jobs.clear();
  boundAgent = null;
  boundLog?.info?.('scheduler.stopped', {});
  boundLog = null;
}

/** Test/debug accessor — number of active in-process jobs. */
export function getActiveJobCount(): number { return jobs.size; }

// ── MCP tools ──────────────────────────────────────────────────────────────

function needAgent(tool: string): { text: string; isError: true } {
  return {
    text: `${tool}: requires the daemon (\`clawdcursor agent\`). ` +
          `Stdio MCP clients have no scheduler context.`,
    isError: true,
  };
}

function genId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function describeNext(t: ScheduledTask): string | null {
  try {
    const c = new Cron(t.cron, { timezone: t.tz });
    const next = c.nextRun();
    c.stop();
    return next ? next.toISOString() : null;
  } catch { return null; }
}

export function getSchedulerTools(): ToolDefinition[] {
  return [
    {
      name: 'scheduled_task_create',
      description:
        'Create a recurring task that runs on a cron schedule. The task ' +
        'submits to the autonomous agent each time the cron tick fires; if ' +
        'the agent is busy at that moment, the tick is skipped (no queue). ' +
        'Cron is standard 5-field syntax (`* * * * *` = every minute) or ' +
        '6-field with leading seconds. Returns the created task with id + ' +
        'next-run timestamp. Persisted across daemon restarts.',
      parameters: {
        task: {
          type: 'string',
          description: 'Natural-language task to run on each tick',
          required: true,
        },
        cron: {
          type: 'string',
          description: 'Cron expression (e.g. "0 9 * * 1-5" = 9am weekdays)',
          required: true,
        },
        tz: {
          type: 'string',
          description: 'Optional timezone (e.g. "America/New_York"). Defaults to server local.',
          required: false,
        },
      },
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async ({ task, cron, tz }, ctx: ToolContext) => {
        if (!ctx.agent) return needAgent('scheduled_task_create');
        const trimmedTask = String(task ?? '').trim();
        const trimmedCron = String(cron ?? '').trim();
        if (!trimmedTask) return { text: 'scheduled_task_create: task is required', isError: true };
        if (!trimmedCron) return { text: 'scheduled_task_create: cron is required', isError: true };
        if (trimmedTask.length > 2000) return { text: 'scheduled_task_create: task too long (max 2000)', isError: true };
        // Validate the cron expression before persisting.
        try {
          const probe = new Cron(trimmedCron, { timezone: tz ? String(tz) : undefined });
          const nxt = probe.nextRun();
          probe.stop();
          if (!nxt) return { text: `scheduled_task_create: cron "${trimmedCron}" never fires`, isError: true };
        } catch (err) {
          return { text: `scheduled_task_create: invalid cron "${trimmedCron}": ${(err as Error).message}`, isError: true };
        }
        const t: ScheduledTask = {
          id: genId(),
          cron: trimmedCron,
          task: trimmedTask,
          enabled: true,
          tz: tz ? String(tz) : undefined,
          createdAt: Date.now(),
          lastRun: null,
          lastError: null,
          runCount: 0,
          skipCount: 0,
        };
        const all = loadAll();
        all.push(t);
        saveAll(all);
        const r = registerJob(t);
        if (!r.ok) {
          // Roll back persistence on register failure.
          saveAll(all.filter(x => x.id !== t.id));
          return { text: `scheduled_task_create: ${r.reason}`, isError: true };
        }
        return { text: JSON.stringify({ ok: true, task: t, nextRun: describeNext(t) }) };
      },
    },

    {
      name: 'scheduled_task_list',
      description:
        'Return every scheduled task: id, cron expression, task text, enabled ' +
        'state, run/skip counters, last-run / last-error, next-run timestamp.',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 0,
      handler: async () => {
        const all = loadAll();
        return {
          text: JSON.stringify({
            tasks: all.map(t => ({ ...t, nextRun: describeNext(t) })),
            activeJobs: jobs.size,
          }),
        };
      },
    },

    {
      name: 'scheduled_task_delete',
      description: 'Delete one scheduled task by id. No-op if id is unknown.',
      parameters: {
        id: { type: 'string', description: 'ScheduledTask.id', required: true },
      },
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 2,
      handler: async ({ id }) => {
        const targetId = String(id ?? '').trim();
        if (!targetId) return { text: 'scheduled_task_delete: id required', isError: true };
        const all = loadAll();
        const filtered = all.filter(t => t.id !== targetId);
        if (filtered.length === all.length) {
          return { text: JSON.stringify({ ok: true, deleted: false, reason: 'id not found' }) };
        }
        saveAll(filtered);
        unregisterJob(targetId);
        return { text: JSON.stringify({ ok: true, deleted: true, remaining: filtered.length }) };
      },
    },

    {
      name: 'scheduled_task_toggle',
      description:
        'Pause/resume a scheduled task without deleting it. When disabled the ' +
        'cron job is unregistered (no firing); state stays persisted.',
      parameters: {
        id: { type: 'string', description: 'ScheduledTask.id', required: true },
        enabled: { type: 'boolean', description: 'true=enable, false=pause', required: true },
      },
      category: 'orchestration',
      compactGroup: 'task',
      safetyTier: 1,
      handler: async ({ id, enabled }) => {
        const targetId = String(id ?? '').trim();
        if (!targetId) return { text: 'scheduled_task_toggle: id required', isError: true };
        const all = loadAll();
        const found = all.find(t => t.id === targetId);
        if (!found) return { text: 'scheduled_task_toggle: id not found', isError: true };
        found.enabled = !!enabled;
        saveAll(all);
        if (found.enabled) {
          const r = registerJob(found);
          if (!r.ok) return { text: `scheduled_task_toggle: enabled but register failed: ${r.reason}`, isError: true };
        } else {
          unregisterJob(targetId);
        }
        return { text: JSON.stringify({ ok: true, task: found, nextRun: describeNext(found) }) };
      },
    },
  ];
}

// ── Test hook ─────────────────────────────────────────────────────────────

/** Wipe state — for vitest cleanup. NOT exposed via MCP. */
export function _resetSchedulerForTests(): void {
  for (const [, job] of jobs) job.stop();
  jobs.clear();
  boundAgent = null;
  boundLog = null;
  try { if (fs.existsSync(scheduledTasksPath())) fs.unlinkSync(scheduledTasksPath()); } catch { /* ok */ }
}
