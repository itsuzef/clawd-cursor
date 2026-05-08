/**
 * Skill-cache tests: dual-shape loader, deleted-module demotion, promotion,
 * self-heal, LRU cap, eviction.
 *
 * The backup clause is separately tested in skill-cache-migration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillCache, isReplayable, SCHEMA_VERSION } from '../core/skills/skill-cache';

function skillsFilePath(home: string): string {
  return path.join(home, '.clawdcursor', 'skills.json');
}

describe('skill-cache', () => {
  let tmpHome: string;
  const origClawdHome = process.env.CLAWD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skillcache-test-'));
    fs.mkdirSync(path.join(tmpHome, '.clawdcursor'), { recursive: true });
    process.env.CLAWD_HOME = tmpHome;
  });

  afterEach(() => {
    if (origClawdHome === undefined) delete process.env.CLAWD_HOME;
    else process.env.CLAWD_HOME = origClawdHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('dual-shape loader', () => {
    it('accepts legacy v0.8.0 bare-array shape', () => {
      const legacy = [
        {
          id: 's1',
          taskPattern: 'send email',
          appName: 'outlook',
          steps: [{ type: 'key', key: 'mod+n', description: 'new msg' }],
          successCount: 2,
          lastUsed: Date.now(),
          createdAt: Date.now(),
        },
      ];
      fs.writeFileSync(skillsFilePath(tmpHome), JSON.stringify(legacy));

      const cache = new SkillCache();
      const all = cache._getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('s1');
      expect(all[0].schemaVersion).toBe(1); // inferred for legacy
    });

    it('accepts v0.8.1 object-wrapped shape', () => {
      const wrapped = {
        schemaVersion: 2,
        skills: [
          {
            id: 's2',
            taskPattern: 'open chrome',
            appName: 'chrome',
            steps: [{ type: 'key', key: 'mod+Space', description: 'spotlight' }],
            successCount: 2,
            lastUsed: Date.now(),
            createdAt: Date.now(),
            schemaVersion: 2,
          },
        ],
      };
      fs.writeFileSync(skillsFilePath(tmpHome), JSON.stringify(wrapped));

      const all = new SkillCache()._getAll();
      expect(all).toHaveLength(1);
      expect(all[0].schemaVersion).toBe(2);
    });

    it('tolerates garbage gracefully', () => {
      fs.writeFileSync(skillsFilePath(tmpHome), 'this is not json at all');
      const all = new SkillCache()._getAll();
      expect(all).toEqual([]);
    });

    it('writes the backup sibling on first load', () => {
      fs.writeFileSync(skillsFilePath(tmpHome), JSON.stringify([]));
      new SkillCache().load();
      expect(fs.existsSync(path.join(tmpHome, '.clawdcursor', 'skills.v0.8.0.json.bak'))).toBe(true);
    });
  });

  describe('deleted-module demotion', () => {
    it('isReplayable returns false for step referencing a deleted module', () => {
      const skill = {
        id: 's1', taskPattern: 't', appName: 'app',
        steps: [{ type: 'click' as const, description: 'click send', producedBy: 'a11y-reasoner' }],
        successCount: 2, lastUsed: 0, createdAt: 0,
      };
      expect(isReplayable(skill).replayable).toBe(false);
    });

    it('isReplayable returns true when all steps have known producers or none', () => {
      const skill = {
        id: 's1', taskPattern: 't', appName: 'app',
        steps: [
          { type: 'key' as const, key: 'mod+s', description: 'save', producedBy: 'pipeline.router' },
          { type: 'type' as const, text: 'x', description: 'type' },
        ],
        successCount: 2, lastUsed: 0, createdAt: 0,
      };
      expect(isReplayable(skill).replayable).toBe(true);
    });

    it('find() demotes a cached entry that references a deleted module, returns null', () => {
      const laced = [
        {
          id: 'legacy1',
          taskPattern: 'send email',
          appName: 'outlook',
          steps: [
            { type: 'click', description: 'click send', producedBy: 'a11y-reasoner' },
          ],
          successCount: 3, lastUsed: Date.now(), createdAt: Date.now(),
        },
      ];
      fs.writeFileSync(skillsFilePath(tmpHome), JSON.stringify(laced));

      const cache = new SkillCache();
      const hit = cache.find('send email', 'outlook');
      expect(hit).toBeNull();
      expect(cache._getAll()).toHaveLength(0); // demoted out of cache
    });
  });

  describe('promotion', () => {
    it('promotes after 2 successes', () => {
      const cache = new SkillCache();
      const steps = [{ type: 'key' as const, key: 'mod+s', description: 'save' }];
      cache.record('save file', 'notepad', steps);
      expect(cache._getAll()).toHaveLength(0); // first success stays pending
      cache.record('save file', 'notepad', steps);
      expect(cache._getAll()).toHaveLength(1); // promoted
      expect(cache._getAll()[0].schemaVersion).toBe(SCHEMA_VERSION);
    });
  });

  describe('matching', () => {
    it('matches tasks with ≥75% token overlap', () => {
      const cache = new SkillCache();
      const steps = [{ type: 'key' as const, key: 'mod+n', description: 'new' }];
      cache.record('send email to bob', 'outlook', steps);
      cache.record('send email to bob', 'outlook', steps); // promote

      expect(cache.find('send email to bob', 'outlook')).not.toBeNull();
      // Different app — no match
      expect(cache.find('send email to bob', 'gmail')).toBeNull();
      // Very different task — no match
      expect(cache.find('check calendar', 'outlook')).toBeNull();
    });
  });

  describe('self-heal', () => {
    it('decrements successCount on failure and removes at zero', () => {
      const cache = new SkillCache();
      const steps = [{ type: 'key' as const, key: 'mod+n', description: 'new' }];
      cache.record('task', 'app', steps);
      cache.record('task', 'app', steps); // promoted with successCount=2
      const id = cache._getAll()[0].id;

      cache.recordFailure(id);
      expect(cache._getAll()[0].successCount).toBe(1);
      cache.recordFailure(id);
      expect(cache._getAll()).toHaveLength(0); // removed at zero
    });
  });

  describe('eviction', () => {
    it('evicts entries older than 30 days on load', () => {
      const oldSkill = {
        id: 'old',
        taskPattern: 'ancient',
        appName: 'app',
        steps: [{ type: 'key', key: 'x', description: 'stale' }],
        successCount: 2,
        lastUsed: Date.now() - 31 * 24 * 60 * 60 * 1000,
        createdAt: 0,
      };
      fs.writeFileSync(skillsFilePath(tmpHome), JSON.stringify([oldSkill]));
      expect(new SkillCache()._getAll()).toHaveLength(0);
    });
  });
});
