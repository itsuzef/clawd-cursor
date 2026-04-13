<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>OS-level desktop automation server. Gives any AI model eyes, hands, and ears on a real computer.</strong><br>
  Model-agnostic &middot; Works with Claude, GPT, Gemini, Llama, or any tool-calling model &middot; Free with local models
</p>

<p align="center">
  <a href="https://discord.gg/UGBWKvmj"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://clawdcursor.com"><img src="https://img.shields.io/badge/Website-clawdcursor.com-22c55e?style=for-the-badge" alt="Website"></a>
</p>

<p align="center">
  <a href="https://clawdcursor.com">Website</a> &middot;
  <a href="https://discord.gg/UGBWKvmj">Discord</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#connect">Connect</a> &middot;
  <a href="#api">API</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What's New in v0.7.14

- **macOS keystrokes fixed** — `keyPress()` now routes through `osascript` + System Events. TCC was silently blocking `CGEvent.post()` from Node child processes. Cmd+V, Cmd+N, Shift+Cmd+D all work.
- **Platform-aware shortcuts** — `Cmd` on macOS, `Ctrl` on Windows/Linux throughout the pipeline (URL bar, email compose, Find & Replace).
- **macOS Mail.app flow** — deterministic compose: Cmd+N → To → Tab → Subject → Tab → Body → Cmd+Shift+D.
- **Unified permission checking** — `doctor`, `status`, and `readiness` all use the same path. No more contradictory reports.
- **Screenshot CPU fix** — delegates to `screenshot-helper` subprocess. Eliminates ReplayKit CPU spin on macOS 14+.
- **`clawdcursor grant`** — triggers macOS system permission dialogs from the CLI.
- **Node.js v25 crash fix** — `EINVAL`/`setTypeOfService` from undici caught and suppressed.

Full history in [CHANGELOG.md](CHANGELOG.md).

---

## What It Does

Clawd Cursor is a **tool server**. It wraps your desktop as 42 callable tools — mouse, keyboard, screen, windows, browser. Any AI that can call functions can use it.

```
Your AI → "Click the Send button"  →  find_element + mouse_click
Your AI → "What's on screen?"      →  desktop_screenshot + read_screen
Your AI → "Open Chrome to gmail"   →  open_app + navigate_browser
```

No app-specific integrations. No per-service API keys. If it's on screen, clawdcursor can interact with it.

---

## Quick Start

**Windows**
```powershell
powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
clawdcursor start
```

**macOS**
```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor grant     # grant Accessibility + Screen Recording permissions
clawdcursor start
```

**Linux**
```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor start
```

First run auto-detects your AI provider from environment variables. Or be explicit:
```bash
clawdcursor start --provider anthropic --api-key sk-ant-...
clawdcursor start --provider gemini     # GEMINI_API_KEY in env
clawdcursor start                       # free with Ollama
```

> See [docs/MACOS-SETUP.md](docs/MACOS-SETUP.md) for macOS permission setup.

---

## Connect

Three modes. Same 42 tools.

### 1. Built-in Agent (`start`)
Full autonomous agent — send a task, get a result.
```bash
clawdcursor start
curl http://localhost:3847/task -d '{"task": "Open Notepad and write Hello"}'
```

### 2. Tools-Only Server (`serve`)
Exposes tools over REST. You bring the AI.
```bash
clawdcursor serve
curl http://localhost:3847/tools          # discover tools
curl http://localhost:3847/execute/mouse_click -d '{"x":500,"y":300}'
```

### 3. MCP Mode (`mcp`)
MCP stdio server for Claude Code, Cursor, Windsurf, Zed.
```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "clawdcursor": {
      "command": "node",
      "args": ["/path/to/clawdcursor/dist/index.js", "mcp"]
    }
  }
}
```

---

## Tools

42 tools across 6 categories:

| Category | Count | Examples |
|----------|-------|---------|
| Perception | 9 | `desktop_screenshot`, `read_screen`, `get_active_window`, `smart_read`, `ocr_read_screen` |
| Mouse | 6 | `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_scroll` |
| Keyboard | 5 | `key_press`, `type_text`, `smart_type`, `shortcuts_list`, `shortcuts_execute` |
| Window / App | 6 | `focus_window`, `open_app`, `get_windows`, `invoke_element` |
| Browser (CDP) | 10 | `cdp_connect`, `cdp_click`, `cdp_type`, `cdp_read_text`, `cdp_evaluate` |
| Orchestration | 6 | `smart_click`, `navigate_browser`, `delegate_to_agent`, `wait` |

---

## Pipeline

Tasks flow cheapest-first:

```
L1.5  Deterministic flows  →  hardcoded sequences for common tasks (email, app-switch). Zero LLM.
L2    Skill Cache          →  learned action patterns. Zero LLM.
L2.5  OCR Reasoner ★      →  OS OCR + cheap text LLM. Handles ~90% of tasks.
L2.5b A11y Reasoner       →  fallback when OCR unavailable.
L3    Computer Use         →  vision model. Last resort only.
```

Every action is ground-truth verified after execution. False success is blocked.

---

## API

`http://localhost:3847`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tools` | GET | All tools in OpenAI function-calling format |
| `/execute/:name` | POST | Execute a tool |
| `/task` | POST | Submit a plain-English task |
| `/status` | GET | Agent state |
| `/screenshot` | GET | Current screen as PNG |
| `/task-logs` | GET | Recent task logs (JSONL) |
| `/confirm` | POST | Approve/reject a safety-gated action |
| `/abort` | POST | Stop current task |
| `/health` | GET | Version + health check |

---

## Safety

| Tier | Actions | Behavior |
|------|---------|----------|
| Auto | Navigation, reading, opening apps | Runs immediately |
| Preview | Typing, form filling | Logged before executing |
| Confirm | Sending messages, deleting, purchases | Pauses for approval |

Server binds to `localhost` only. Dangerous key combos blocked. Consent required on first run.

---

## CLI

```
clawdcursor start        Full agent (built-in LLM pipeline)
clawdcursor serve        Tools-only REST server
clawdcursor mcp          MCP stdio server
clawdcursor doctor       Diagnose and configure
clawdcursor grant        Grant macOS permissions (interactive)
clawdcursor task <t>     Send task to running agent
clawdcursor stop         Stop server
clawdcursor dashboard    Open web dashboard

Options:
  --port <port>          Default: 3847
  --provider <name>      anthropic | openai | gemini | groq | ollama | deepseek | ...
  --model <model>        Override model
  --api-key <key>        Provider API key
  --base-url <url>       OpenAI-compatible endpoint
  --accept               Skip consent prompt (non-interactive)
```

---

## Platform Support

| Platform | UI Automation | OCR | Browser |
|----------|---------------|-----|---------|
| **Windows** x64/ARM64 | PowerShell + UI Automation | Windows.Media.Ocr | Chrome / Edge |
| **macOS** Intel/Apple Silicon | JXA + System Events | Apple Vision | Chrome / Edge |
| **Linux** x64/ARM64 | AT-SPI (planned) | Tesseract | Chrome / Edge |

## Prerequisites

- **Node.js 20+**
- **macOS**: Xcode CLI tools — `xcode-select --install`
- **Linux**: `sudo apt install tesseract-ocr`
- **AI key**: optional — works offline with Ollama

## Tech Stack

TypeScript · Node.js · nut-js · Playwright · sharp · Express · MCP SDK · Zod

## License

MIT

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
