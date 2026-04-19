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
const srcGuides = path.join(repoRoot, 'src', 'pipeline', 'knowledge', 'guides');
const dstGuides = path.join(repoRoot, 'dist', 'pipeline', 'knowledge', 'guides');
const guideCount = copyDir(srcGuides, dstGuides);

console.log(`
🐾 Clawd Cursor built successfully!
   (bundled ${guideCount} app-knowledge guides → dist/pipeline/knowledge/guides/)

  clawdcursor start     Start the desktop control agent
  clawdcursor mcp       Run as MCP server (for Claude Code, Cursor, etc.)
  clawdcursor doctor    Auto-detect and configure AI providers
  clawdcursor status    Check setup status
  clawdcursor stop      Stop the agent
  clawdcursor uninstall Remove all config and data

  Run 'clawdcursor consent' first to grant desktop control permissions.
`);
