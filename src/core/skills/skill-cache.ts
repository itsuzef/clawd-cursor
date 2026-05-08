/**
 * Skill cache — learned task→step sequences with self-healing replay.
 *
 * Ported from src/skill-cache.ts. v0.8.1 additions:
 *
 *  - **Dual-shape loader.** Accepts both legacy v0.7/v0.8.0 shape (no
 *    `schemaVersion`) and v0.8.1 shape (`schemaVersion: 2`). Fresh writes
 *    always use the new shape.
 *  - **Deleted-module demotion.** If a cached step references a function
 *    that no longer exists in the current pipeline (e.g. "a11y_reasoner.*"
 *    after v0.8.2 deletes the module), replay is refused; the orchestrator
 *    is expected to re-run the task fresh via the text-agent, then
 *    re-cache the resulting sequence in the new shape.
 *  - **Backup first.** On initial load, calls `backupSkillsOnce()` so
 *    every migration has a non-destructive rollback.
 *  - **Replay returns null rather than throwing on missing capabilities**
 *    so the pipeline can cleanly fall through to the text-agent.
 *
 * Storage format (v0.8.1):
 *
 *   {
 *     "schemaVersion": 2,
 *     "skills": [ { id, taskPattern, appName, steps, successCount,
 *                   lastUsed, createdAt, schemaVersion: 2 }, ... ]
 *   }
 *
 * Legacy (v0.8.0) format was a bare array. Loader handles both.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../observability/logger';
import { backupSkillsOnce, skillsPath } from './migration';

export const SCHEMA_VERSION = 2;

const MATCH_THRESHOLD    = 0.75;
const PROMOTE_THRESHOLD  = 2;
const MAX_SKILLS         = 200;
const MAX_SKILL_AGE_MS   = 30 * 24 * 60 * 60 * 1000;

/** The compact action vocabulary the cache persists. Independent of the
 * richer `PipelineAction` union so the cache doesn't need to change every
 * time we add a new agent action type. */
export type CachedStepType = 'click' | 'type' | 'key' | 'scroll' | 'wait';

export interface SkillStep {
  type: CachedStepType;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  ms?: number;
  /** Human description of this step, for logs + v2→v1 forward-port detection. */
  description: string;
  /**
   * Opaque capability tag: which module/function produced this step. If the
   * named module no longer exists, the step can't replay — see
   * `isReplayable()` below.
   */
  producedBy?: string;
}

export interface Skill {
  id: string;
  taskPattern: string;
  appName: string;
  steps: SkillStep[];
  successCount: number;
  lastUsed: number;
  createdAt: number;
  /** Present on v0.8.1+ writes; absent on legacy entries (dual-shape loader). */
  schemaVersion?: number;
}

/**
 * Legacy (v0.7/v0.8.0) modules whose names, if referenced in a cached step's
 * `producedBy`, indicate the step can no longer replay after the v0.8.2 sweep.
 * Used by `isReplayable()` to detect entries that must be demoted.
 */
const DELETED_MODULES = new Set<string>([
  'a11y-reasoner',
  'a11yReasoner',
  'ocr-reasoner',
  'ocrReasoner',
  'computer-use',
  'computerUse',
  'generic-computer-use',
  'genericComputerUse',
  'smart-interaction',
  'smartInteraction',
  'ai-brain',
  'aiBrain',
  'action-router',   // ported path lives under pipeline/router — tag strings pre-port won't resolve
  'deterministic-flows',
  'snapshot-builder',
  'task-classifier',
  'local-parser',
  'a11y-click-resolver',
]);

/** Non-exported — used by `register` tests + one-time post-read consumers. */
function tokenize(input: string): string[] {
  return input.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 1);
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap++;
  return overlap / Math.max(setA.size, setB.size);
}

/**
 * Is every step in this skill still replayable given the current pipeline
 * capabilities? Returns false if any step's `producedBy` tag names a
 * deleted module. Steps without a `producedBy` are assumed replayable
 * (they're generic mechanical actions like plain keystrokes).
 */
export function isReplayable(skill: Skill): { replayable: boolean; reason?: string } {
  for (const step of skill.steps) {
    if (step.producedBy && DELETED_MODULES.has(step.producedBy)) {
      return { replayable: false, reason: `references deleted module ${step.producedBy}` };
    }
  }
  return { replayable: true };
}

export class SkillCache {
  private skills: Skill[] = [];
  private loaded = false;
  private pending = new Map<string, { task: string; app: string; steps: SkillStep[]; count: number }>();

  /** Load from disk. Safe to call multiple times. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    // Always back up before touching the file. Idempotent.
    try { backupSkillsOnce('v0.8.0'); } catch { /* non-fatal */ }

    const filePath = skillsPath();
    if (!fs.existsSync(filePath)) {
      logger.debug('skill-cache.load.fresh', { path: filePath });
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.skills = this.parseDualShape(parsed);

      const before = this.skills.length;
      const now = Date.now();
      this.skills = this.skills.filter(s => now - s.lastUsed < MAX_SKILL_AGE_MS);
      const evicted = before - this.skills.length;
      if (evicted > 0) logger.info('skill-cache.load.evicted_stale', { evicted });

      logger.info('skill-cache.load.ok', { path: filePath, count: this.skills.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('skill-cache.load.failed', { path: filePath, error: msg });
      this.skills = [];
    }
  }

  /**
   * Dual-shape loader. Accepts:
   *   - Legacy v0.8.0 shape: bare JSON array of skills.
   *   - v0.8.1 shape: `{ schemaVersion: 2, skills: [...] }`.
   * Returns a normalized Skill[] with schemaVersion populated.
   */
  private parseDualShape(raw: unknown): Skill[] {
    let arr: unknown[];

    if (Array.isArray(raw)) {
      arr = raw;
    } else if (raw && typeof raw === 'object' && 'skills' in raw && Array.isArray((raw as any).skills)) {
      arr = (raw as any).skills;
    } else {
      return [];
    }

    return arr.filter(s => s && typeof s === 'object').map(s => {
      const obj = s as Record<string, unknown>;
      return {
        id:            String(obj.id ?? ''),
        taskPattern:   String(obj.taskPattern ?? ''),
        appName:       String(obj.appName ?? ''),
        steps:         Array.isArray(obj.steps) ? (obj.steps as SkillStep[]) : [],
        successCount:  Number(obj.successCount ?? 0),
        lastUsed:      Number(obj.lastUsed ?? Date.now()),
        createdAt:     Number(obj.createdAt ?? Date.now()),
        schemaVersion: Number(obj.schemaVersion ?? 1),
      };
    }).filter(s => s.id && s.steps.length > 0);
  }

  /**
   * Find a matching skill for a task+app. Returns the skill if its replay
   * is still viable; null if no match OR the match references a deleted
   * module (caller falls through to text-agent and will re-cache on success).
   */
  find(task: string, appName: string): Skill | null {
    this.load();
    const taskTokens = tokenize(task);
    const appLower = appName.toLowerCase();

    let best: Skill | null = null;
    let bestScore = 0;
    for (const skill of this.skills) {
      if (skill.appName.toLowerCase() !== appLower) continue;
      const score = tokenOverlap(taskTokens, tokenize(skill.taskPattern));
      if (score >= MATCH_THRESHOLD && score > bestScore) {
        best = skill;
        bestScore = score;
      }
    }

    if (!best) return null;

    const { replayable, reason } = isReplayable(best);
    if (!replayable) {
      logger.info('skill-cache.demote', { skill: best.id, task, reason });
      // Remove it so the orchestrator's success path re-caches fresh.
      this.skills = this.skills.filter(s => s.id !== best!.id);
      this.save();
      return null;
    }

    best.lastUsed = Date.now();
    this.save();
    return best;
  }

  /**
   * Record a successful task run. Promotes after PROMOTE_THRESHOLD occurrences
   * of the same task+app. Always writes new entries in v0.8.1+ shape.
   */
  record(task: string, appName: string, steps: SkillStep[]): void {
    this.load();
    const key = `${appName.toLowerCase()}::${task.toLowerCase().trim()}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.count += 1;
      existing.steps = steps; // refresh to latest sequence
      if (existing.count >= PROMOTE_THRESHOLD) {
        this.promote(existing.task, existing.app, existing.steps);
        this.pending.delete(key);
      }
    } else {
      this.pending.set(key, { task, app: appName, steps, count: 1 });
    }
  }

  /** Mark a skill as having failed to replay — decrement and remove on zero. */
  recordFailure(skillId: string): void {
    this.load();
    const s = this.skills.find(x => x.id === skillId);
    if (!s) return;
    s.successCount = Math.max(0, s.successCount - 1);
    if (s.successCount === 0) {
      this.skills = this.skills.filter(x => x.id !== skillId);
      logger.info('skill-cache.self_heal.removed', { skill: skillId });
    }
    this.save();
  }

  private promote(task: string, appName: string, steps: SkillStep[]): void {
    const skill: Skill = {
      id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskPattern: task.trim(),
      appName,
      steps,
      successCount: PROMOTE_THRESHOLD,
      lastUsed: Date.now(),
      createdAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    };

    // Cap at MAX_SKILLS — evict oldest by lastUsed.
    this.skills.push(skill);
    if (this.skills.length > MAX_SKILLS) {
      this.skills.sort((a, b) => b.lastUsed - a.lastUsed);
      this.skills = this.skills.slice(0, MAX_SKILLS);
    }
    this.save();
    logger.info('skill-cache.promoted', { skill: skill.id, task, app: appName });
  }

  /** Persist to disk in v0.8.1 shape. */
  private save(): void {
    try {
      const dir = path.dirname(skillsPath());
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        skills: this.skills.map(s => ({ ...s, schemaVersion: SCHEMA_VERSION })),
      };
      fs.writeFileSync(skillsPath(), JSON.stringify(payload, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('skill-cache.save.failed', { error: msg });
    }
  }

  /** Test/debug only. */
  _getAll(): Skill[] {
    this.load();
    return [...this.skills];
  }
}
