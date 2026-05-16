/**
 * End-to-end test for the orphan-teardown stdin handler in `clawdcursor mcp`.
 *
 * Background: MCP stdio servers receive their JSON-RPC traffic over stdin.
 * If the host editor (Claude Code, Cursor, etc.) crashes or exits without
 * killing its child, the child's stdin pipe closes — but the orphaned
 * process keeps running and holds its single-instance lockfile, blocking
 * every subsequent reconnect.
 *
 * The fix in src/surface/cli.ts (search for "// Parent-death detection")
 * attaches end / close / error handlers on process.stdin that release the
 * lockfile and call process.exit(0).
 *
 * This test spawns the real built CLI as a child process and asserts that:
 *   1. It claims the lockfile on startup.
 *   2. Closing its stdin causes a clean (exit-0) shutdown within 5s.
 *   3. The lockfile is gone after exit.
 *
 * HOME / USERPROFILE is redirected to a per-test tmpdir so the real user's
 * ~/.clawdcursor/ is never touched. A consent file is pre-written into
 * that tmpdir so the consent gate at src/surface/cli.ts:1192 doesn't block
 * MCP startup.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'surface', 'cli.js');

let tmpHome: string;
let child: ChildProcessWithoutNullStreams | null = null;

beforeAll(() => {
  // The test launches the compiled CLI; if dist/ was never built (or got
  // wiped) build it once for the whole file. `npm run build` is the same
  // command package.json uses — keeps test and CI behavior identical.
  if (!fs.existsSync(CLI_PATH)) {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
}, 120_000);

afterEach(() => {
  // Defensive cleanup so a failed assertion doesn't leak a live MCP child
  // that would hold its lockfile and trip later test runs.
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  }
  child = null;
  if (tmpHome) {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForReady(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`MCP did not signal ready within ${timeoutMs}ms; output so far:\n${buf}`));
    }, timeoutMs);
    // The CLI prints "MCP mode starting" before subsystem init and
    // "MCP ready" once tools are registered. Either is good enough — by
    // the time we see "starting" the stdin handlers are already attached
    // (they're installed synchronously after server creation).
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      if (buf.includes('MCP ready') || buf.includes('MCP mode starting')) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
}

describe('mcp orphan-teardown stdin handler', () => {
  it('exits cleanly and releases its lockfile when stdin closes', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-mcp-orphan-'));

    // Pre-seed consent so the gate at cli.ts:1192 doesn't block startup.
    // Format matches saveConsent() in src/surface/onboarding.ts; only the
    // file's existence is actually checked by hasConsent().
    const consentDir = path.join(tmpHome, '.clawdcursor');
    fs.mkdirSync(consentDir, { recursive: true });
    fs.writeFileSync(
      path.join(consentDir, 'consent'),
      JSON.stringify({ accepted: true, timestamp: new Date().toISOString(), platform: process.platform, version: 'test' }, null, 2),
    );

    // Redirect HOME *and* USERPROFILE — pidfile.ts uses os.homedir(), which
    // honors HOME on POSIX and USERPROFILE on Windows. Inherit PATH and the
    // rest so node can still find its own runtime libs.
    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      // Force non-TTY behavior on stdin so the consent prompt path isn't
      // even considered (defense in depth on top of the pre-written file).
      CI: '1',
    };

    child = spawn(process.execPath, [CLI_PATH, 'mcp', '--compact'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for the server to come up. 10s is generous — local dev sees ~1s,
    // cold CI runners can take 3-5s for the first compile-cache hit.
    await waitForReady(child, 10_000);

    const pidFile = path.join(tmpHome, '.clawdcursor', 'mcp.pid');
    expect(fs.existsSync(pidFile)).toBe(true);

    const lockData = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
    expect(lockData.pid).toBe(child.pid);
    expect(lockData.mode).toBe('mcp');
    expect(lockData.v).toBe(1);

    // Trigger the orphan path: parent closes its end of the stdin pipe.
    // The child's process.stdin should fire 'end' (and/or 'close') and the
    // handler in cli.ts calls releasePidFile('mcp') + process.exit(0).
    child.stdin.end();

    const { code, signal } = await waitForExit(child, 5_000);

    // process.exit(0) yields code === 0 / signal === null. Anything else
    // (signal kill, non-zero code) means teardown didn't run cleanly.
    expect(signal).toBeNull();
    expect(code).toBe(0);

    expect(fs.existsSync(pidFile)).toBe(false);
  }, 30_000);
});
