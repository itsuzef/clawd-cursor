/**
 * Post-build script — runs after tsc.
 *
 * Does two things:
 *  1. Copies non-TS assets into dist/ (bundled app-knowledge guides and any
 *     other static files tsc doesn't touch). tsc only emits JS/d.ts; static
 *     files must be copied explicitly or they're missing at runtime.
 *  2. Prints available commands.
 */

import * as fs from 'fs';
import * as path from 'path';

function copyDir(srcDir: string, dstDir: string): number {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      count += copyDir(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

const repoRoot  = path.join(__dirname, '..');
const srcGuides = path.join(repoRoot, 'src', 'llm', 'knowledge', 'guides');
const dstGuides = path.join(repoRoot, 'dist', 'llm', 'knowledge', 'guides');
const guideCount = copyDir(srcGuides, dstGuides);

console.log(`
🐾 Clawd Cursor built successfully!
   (bundled ${guideCount} app-knowledge guides → dist/llm/knowledge/guides/)

  Start here:
    clawdcursor consent     One-time desktop control authorization

  Then pick a path:
    Autonomous agent →  clawdcursor doctor   Configure AI provider + models
                        clawdcursor agent    Start the daemon (HTTP + MCP on :3847)

    MCP-only         →  clawdcursor mcp      stdio MCP for editor integration
                                             (Claude Code, Cursor, Windsurf, Zed)

  Other:
    clawdcursor status      Check setup readiness
    clawdcursor stop        Stop a running daemon
    clawdcursor uninstall   Remove all config and data
`);
