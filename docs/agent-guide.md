# clawdcursor Agent Guide

> **This file is a stub.** The canonical agent-facing documentation is
> [`SKILL.md`](../SKILL.md) at the repo root. Load that — it has the full
> compact-tool workflow, compound → granular action reference, safety tiers,
> per-OS capability matrix, and error recovery.

## One-line summary

clawdcursor is the skill that gives AI agents eyes, hands, and ears on a real
desktop. If a human can do it on a screen, you can too — no app-specific API
required.

## Two ways to connect

**MCP (recommended for Claude Code / Cursor / Windsurf / Zed):**
```json
{
  "mcpServers": {
    "clawdcursor": { "command": "clawdcursor", "args": ["mcp", "--compact"] }
  }
}
```
You see 6 compound tools: `computer`, `accessibility`, `window`, `system`,
`browser`, `task`.

**REST (for any HTTP-capable agent):**
```bash
clawdcursor serve
curl "http://127.0.0.1:3847/tools?mode=compact"
```
Auth token at `~/.clawdcursor/token`.

## The simplest path

When you don't need step-level control, hand clawdcursor the whole task:
```
task({"instruction": "open Notepad and type hello"})
```
The built-in pipeline decomposes it, picks the cheapest execution path
(router → blind agent → hybrid → vision fallback), runs it, and returns a trace.

## For full detail

See [`SKILL.md`](../SKILL.md) at the repo root.

## Links

- Homepage: <https://clawdcursor.com>
- Repo: <https://github.com/AmrDab/clawdcursor>
- SKILL.md (canonical): [`../SKILL.md`](../SKILL.md)
