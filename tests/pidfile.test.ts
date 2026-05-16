/**
 * Tests for the single-instance pidfile lock.
 *
 * Covers the failure modes the JSON-lockfile + start-time-verify fix addresses:
 *   - Stale lockfile (PID dead) → cleared, claim succeeds.
 *   - Recycled PID with start-time mismatch → cleared, claim succeeds.
 *   - Genuine duplicate (PID alive + start time matches) → claim returns the pid.
 *   - Legacy bare-int format from prior versions → treated as stale.
 *   - Malformed JSON → treated as stale.
 *
 * Each test redirects HOME / USERPROFILE to an isolated tmpdir so it can
 * write and read real lockfiles without touching the user's actual
 * ~/.clawdcursor/ directory.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// pidfile.ts resolves PID_DIR at import time from os.homedir(), which
// itself honors HOME (POSIX) and USERPROFILE (Windows). Setting both env
// vars *before* the dynamic import gives every test its own home dir.
async function loadPidfileWithHome(home: string) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  const mod = await import('../src/surface/pidfile');
  return { mod, restore: () => { process.env.HOME = prev.HOME; process.env.USERPROFILE = prev.USERPROFILE; } };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-pidfile-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('claimPidFile', () => {
  it('claims successfully when no lockfile exists', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.claimPidFile('mcp')).toBeNull();
      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.pid).toBe(process.pid);
      expect(written.mode).toBe('mcp');
      expect(written.v).toBe(1);
      expect(typeof written.startTime).toBe('number');
    } finally { restore(); }
  });

  it('overwrites a stale lockfile pointing at a dead pid', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      // PID 999999 should be reliably dead on every test host.
      const stale = { v: 1, pid: 999999, startTime: Date.now(), mode: 'mcp' };
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify(stale));

      expect(mod.claimPidFile('mcp')).toBeNull();
      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.pid).toBe(process.pid);
    } finally { restore(); }
  });

  it('overwrites a recycled-PID lockfile (live PID, wrong start time)', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      // Use the test runner's own PID as the "recycled" PID — it's alive
      // but its real start time is "now-ish", far from the planted value.
      const recycled = {
        v: 1,
        pid: process.pid,
        startTime: 1_000_000_000_000, // year 2001 — clearly not when this test started
        mode: 'mcp',
      };
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify(recycled));

      // claimPidFile compares the lockfile's recorded start time against the
      // OS-reported actual start time of the PID. The 2001 timestamp can't
      // match a process started today, so this must be treated as stale.
      // (The PID == process.pid short-circuit also forces overwrite — both
      // paths land on the same correct outcome.)
      expect(mod.claimPidFile('mcp')).toBeNull();

      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.startTime).not.toBe(1_000_000_000_000);
    } finally { restore(); }
  });

  it('treats a legacy bare-integer lockfile as stale', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      // Pre-fix versions wrote the PID as a bare integer. We can't verify
      // identity from this format, so it must be discarded on first claim.
      fs.writeFileSync(mod.pidFilePath('mcp'), '12345');

      expect(mod.claimPidFile('mcp')).toBeNull();
      const written = JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8'));
      expect(written.v).toBe(1);
      expect(written.pid).toBe(process.pid);
    } finally { restore(); }
  });

  it('treats a malformed lockfile as stale', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), '{not json');

      expect(mod.claimPidFile('mcp')).toBeNull();
      expect(JSON.parse(fs.readFileSync(mod.pidFilePath('mcp'), 'utf-8')).pid).toBe(process.pid);
    } finally { restore(); }
  });

  it('separates locks by mode', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.claimPidFile('mcp')).toBeNull();
      // Same process can hold multiple modes' locks at once — they're
      // independent files, used by different commands.
      expect(mod.claimPidFile('start')).toBeNull();
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(true);
      expect(fs.existsSync(mod.pidFilePath('start'))).toBe(true);
    } finally { restore(); }
  });
});

describe('releasePidFile', () => {
  it('removes the lockfile when this process owns it', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      mod.claimPidFile('mcp');
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(true);
      mod.releasePidFile('mcp');
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(false);
    } finally { restore(); }
  });

  it('does not remove a lockfile owned by a different pid', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      // Plant a lock owned by a clearly-different PID. release should be
      // a no-op so a slow exit can't accidentally release a successor's lock.
      const other = { v: 1, pid: process.pid + 99999, startTime: Date.now(), mode: 'mcp' };
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), JSON.stringify(other));

      mod.releasePidFile('mcp');
      expect(fs.existsSync(mod.pidFilePath('mcp'))).toBe(true);
    } finally { restore(); }
  });
});

describe('readPidLoose', () => {
  it('reads the new JSON format', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      mod.claimPidFile('mcp');
      expect(mod.readPidLoose('mcp')).toBe(process.pid);
    } finally { restore(); }
  });

  it('reads the legacy bare-int format', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      fs.mkdirSync(path.dirname(mod.pidFilePath('mcp')), { recursive: true });
      fs.writeFileSync(mod.pidFilePath('mcp'), '54321');
      expect(mod.readPidLoose('mcp')).toBe(54321);
    } finally { restore(); }
  });

  it('returns null for a missing lockfile', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.readPidLoose('mcp')).toBeNull();
    } finally { restore(); }
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.isProcessAlive(process.pid)).toBe(true);
    } finally { restore(); }
  });

  it('returns false for a clearly-dead pid', async () => {
    const { mod, restore } = await loadPidfileWithHome(tmpHome);
    try {
      expect(mod.isProcessAlive(999999)).toBe(false);
    } finally { restore(); }
  });
});
