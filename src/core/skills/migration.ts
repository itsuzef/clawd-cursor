/**
 * Skills cache migration policy.
 *
 * The skill cache (`~/.clawdcursor/skills.json`) encodes learned task→step
 * sequences. v0.7.x/v0.8.0 keyed entries on the V1 classify shape; v0.8.1+
 * uses a new shape that includes `schemaVersion`.
 *
 * This module owns the migration policy so every consumer of the cache goes
 * through the same code path. See plan §5.2 step 8.
 *
 * Migration contract (all five clauses are required for v0.8.1 ship):
 *
 *   1. Backup before first read.
 *      On initial v0.8.1 boot, if skills.json exists and no backup sibling
 *      exists yet, copy it verbatim to skills.v0.8.0.json.bak. This is the
 *      "my migration broke the skill cache" rollback path. Non-destructive.
 *
 *   2. Dual-shape loader.
 *      Accept both v0.7 (no schemaVersion) and v0.8.1+ (schemaVersion:2)
 *      shapes. Fresh writes always use the new shape.
 *
 *   3. Deleted-module demotion.
 *      A cached entry might reference a module that no longer exists in
 *      v0.8.2 (e.g. "a11yReasoner.invoke_element"). Replay silently fails
 *      → demote the entry to a one-shot text-agent run → re-cache on
 *      success in the new shape. Log the demotion so it's visible.
 *
 *   4. 30-day eviction.
 *      Pre-existing behaviour, unchanged. Compat-mode entries age out.
 *
 *   5. Unit-testable.
 *      Every clause has a corresponding test in __tests__/skill-cache-migration.test.ts
 *      (added when skill-cache itself lands).
 *
 * This file currently exports only the backup helper — the rest of the
 * migration lands with the skill-cache port (plan §5.2 step 8). The backup
 * helper is isolated here so it can be called at module init time BEFORE
 * any other code touches skills.json, which is the only way to make the
 * backup guarantee real.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../observability/logger';

/** Current on-disk schema version used by v0.8.1+. */
export const SCHEMA_VERSION = 2;

/**
 * Home directory resolver. Overridable via env (`CLAWD_HOME`) for tests and
 * for portable / sandboxed deployments. Falls back to `os.homedir()`.
 */
export function resolveHome(): string {
  return process.env.CLAWD_HOME || os.homedir();
}

/** Absolute path to the skill cache file. */
export function skillsPath(): string {
  return path.join(resolveHome(), '.clawdcursor', 'skills.json');
}

/** Absolute path to the backup sibling. One per upgrade-from version. */
export function backupPath(fromVersion: string): string {
  return path.join(resolveHome(), '.clawdcursor', `skills.${fromVersion}.json.bak`);
}

/**
 * Create a one-time backup of skills.json before any migration touches it.
 *
 * Idempotent: if the backup already exists, do nothing. Non-destructive: we
 * only copy, never rename. Silent success if skills.json doesn't exist
 * (fresh install — nothing to migrate).
 *
 * Returns the backup path on copy, null if the copy was not needed.
 */
export function backupSkillsOnce(fromVersion = 'v0.8.0'): string | null {
  const src = skillsPath();
  const dst = backupPath(fromVersion);

  if (!fs.existsSync(src)) return null;        // fresh install
  if (fs.existsSync(dst)) return null;          // already backed up

  try {
    fs.copyFileSync(src, dst);
    logger.info('skill-cache.backup.created', { src, dst, fromVersion });
    return dst;
  } catch (err) {
    // Backup failing MUST NOT block startup — log and continue. Migration
    // code downstream is responsible for its own safety.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('skill-cache.backup.failed', { src, dst, error: msg });
    return null;
  }
}
