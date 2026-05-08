/**
 * Skills-cache backup policy — test for the clause that MUST land before
 * any migration logic does anything destructive.
 *
 * The full migration (dual-shape loader, deleted-module demotion) lands with
 * the skill-cache port. The backup helper is landed early and independently
 * because silent corruption of `~/.clawdcursor/skills.json` is the worst
 * failure mode; the backup is our only reliable rollback path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { backupSkillsOnce, skillsPath, backupPath } from '../core/skills/migration';

describe('skill-cache backup policy', () => {
  let tmpHome: string;
  const origClawdHome = process.env.CLAWD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skills-test-'));
    fs.mkdirSync(path.join(tmpHome, '.clawdcursor'), { recursive: true });
    // Redirect the home dir via the documented CLAWD_HOME override — the same
    // mechanism we expose for sandboxed deployments, exercised in tests.
    process.env.CLAWD_HOME = tmpHome;
  });

  afterEach(() => {
    if (origClawdHome === undefined) delete process.env.CLAWD_HOME;
    else process.env.CLAWD_HOME = origClawdHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('is a no-op when skills.json does not exist (fresh install)', () => {
    const result = backupSkillsOnce();
    expect(result).toBeNull();
    expect(fs.existsSync(backupPath('v0.8.0'))).toBe(false);
  });

  it('creates a backup on first call when skills.json exists', () => {
    fs.writeFileSync(skillsPath(), '{"skills":[{"id":"1"}]}');
    const result = backupSkillsOnce('v0.8.0');
    expect(result).toBe(backupPath('v0.8.0'));
    expect(fs.existsSync(backupPath('v0.8.0'))).toBe(true);
    expect(fs.readFileSync(backupPath('v0.8.0'), 'utf8')).toBe('{"skills":[{"id":"1"}]}');
  });

  it('is idempotent — second call does nothing', () => {
    fs.writeFileSync(skillsPath(), '{"skills":[{"id":"1"}]}');
    backupSkillsOnce('v0.8.0');
    // Simulate time passing and the skills file changing — the backup should
    // NOT be overwritten with the newer contents.
    fs.writeFileSync(skillsPath(), '{"skills":[{"id":"1"},{"id":"2"}]}');
    const result = backupSkillsOnce('v0.8.0');
    expect(result).toBeNull();
    expect(fs.readFileSync(backupPath('v0.8.0'), 'utf8')).toBe('{"skills":[{"id":"1"}]}');
  });

  it('is non-destructive — the original file is untouched', () => {
    fs.writeFileSync(skillsPath(), '{"skills":[{"id":"1"}]}');
    backupSkillsOnce('v0.8.0');
    expect(fs.readFileSync(skillsPath(), 'utf8')).toBe('{"skills":[{"id":"1"}]}');
  });

  it('supports per-version backup files', () => {
    fs.writeFileSync(skillsPath(), '{"v0.8.0":true}');
    backupSkillsOnce('v0.8.0');
    fs.writeFileSync(skillsPath(), '{"v0.8.1":true}');
    const secondResult = backupSkillsOnce('v0.8.1');
    expect(secondResult).toBe(backupPath('v0.8.1'));
    // Both backups coexist — user can roll back to either.
    expect(fs.existsSync(backupPath('v0.8.0'))).toBe(true);
    expect(fs.existsSync(backupPath('v0.8.1'))).toBe(true);
    expect(fs.readFileSync(backupPath('v0.8.0'), 'utf8')).toBe('{"v0.8.0":true}');
    expect(fs.readFileSync(backupPath('v0.8.1'), 'utf8')).toBe('{"v0.8.1":true}');
  });
});
