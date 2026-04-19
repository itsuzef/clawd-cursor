/**
 * Build / check the MCP schema snapshot.
 *
 * Thin entrypoint around src/schema/snapshot.ts. Run without args to check;
 * pass --write to intentionally update the committed snapshot (rare; must be
 * approved in PR review since this releases the MCP contract freeze).
 */

import {
  canonicalize,
  currentSnapshot,
  readStoredSnapshot,
  writeSnapshot,
} from '../src/schema/snapshot';

function main(): void {
  const writeMode = process.argv.includes('--write');
  const current = currentSnapshot();
  const stored = readStoredSnapshot();

  if (writeMode) {
    writeSnapshot();
    process.stdout.write(`Wrote schema.snapshot.json (${canonicalize().length} tools)\n`);
    return;
  }

  if (stored === null) {
    process.stderr.write('schema.snapshot.json missing. Generate it with: npx tsx scripts/build-mcp-schema.ts --write\n');
    process.exit(2);
  }

  if (stored !== current) {
    process.stderr.write('MCP schema has drifted from the committed snapshot.\n');
    process.stderr.write('If this change is intentional, update the snapshot with:\n');
    process.stderr.write('  npx tsx scripts/build-mcp-schema.ts --write\n');
    process.stderr.write('\nDiff (first 2000 chars):\n');
    const a = stored.split('\n');
    const b = current.split('\n');
    const maxLen = Math.max(a.length, b.length);
    let buf = '';
    for (let i = 0; i < maxLen && buf.length < 2000; i++) {
      if (a[i] !== b[i]) {
        buf += `L${i + 1}- ${a[i] ?? '(missing)'}\n`;
        buf += `L${i + 1}+ ${b[i] ?? '(missing)'}\n`;
      }
    }
    process.stderr.write(buf);
    process.exit(1);
  }

  process.stdout.write(`MCP schema snapshot OK (${canonicalize().length} tools)\n`);
}

main();
