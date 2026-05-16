# Draft reply to GitHub Issue #13 — Security Audit

**Status: not yet posted. Review and edit, then paste into github.com/AmrDab/clawdcursor/issues/13.**

---

Thanks for the thorough audit, and apologies for the delay in responding — this slipped through during the v0.9 architecture work and shouldn't have. Going through it now and tracking everything below. Where items have already landed I'm linking commits; where they haven't, I'm flagging what's planned and when.

## Already addressed in 0.9.x (with commits)

- **Credential redaction in the dashboard task-history UI** — `looksLikeCredential` had silently been broken since 0.7.x: the regexes lived inside an outer JS template literal, so the `\s`/`\S` backslashes were stripped at parse time and the runtime regex matched literal `s` characters, not whitespace. **No password the regex was designed to catch was actually being caught.** Fixed in `9400e31` (v0.9.2), end-to-end verified. 0.9.3 (this week) extends the pattern set to also catch Stripe (`sk_live_`/`rk_live_`), GitHub PATs (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), Slack tokens (`xox[abprs]-`), AWS access keys (`AKIA…`), Google OAuth (`ya29.…`), JWTs, and the newer OpenAI `sk-proj-` keys.
- **PID-lock + orphan reaping** — the single-instance lockfile was a bare integer, which on Windows is fooled by PID recycling (the OS reassigns dead PIDs and `process.kill(pid,0)` returns true for the unrelated live process). The lockfile is now JSON `{v, pid, startTime, mode}` verified by start-time match. Orphaned MCP children also now exit cleanly on stdin EOF. Fix landed in v0.9.2, ref `ef270db`. Test coverage at `tests/pidfile.test.ts`.
- **`clawdcursor uninstall` regression** — the uninstall command's pidfile fallback was parsing the new JSON format with `parseInt`, silently failing to kill running processes and leaving orphans. Fixed in v0.9.3.
- **PowerShell quoting in `uri-handler.ts` and `relaunch_with_cdp`** — defense-in-depth: `processNameLower` is now apostrophe-escaped before PS interpolation; `port` is numerically coerced. Both inputs are not currently LLM-controlled but the gap is closed regardless.
- **ANSI escape codes moved to picocolors** — 58 inline `\x1b[NNm` literals replaced with a vetted dependency. Source no longer carries hex escapes that scanners might flag as obfuscation, and the runtime behavior is identical. Landed v0.9.2, ref `710426f`.
- **Bearer auth on all mutating endpoints** — `/mcp` (POST/GET/DELETE), `/stop` are bearer-gated. `/health` is the only public endpoint and returns nothing sensitive. `crypto.timingSafeEqual` with a length-equal sentinel call when lengths differ (no length-leak). Verified in code-review pass `2026-05-16`.
- **CORS is restrictive.** Only `http://localhost:3847` and `http://127.0.0.1:3847` allowed; cross-origin POSTs return 403, OPTIONS terminates cleanly. Ref `src/surface/http-utility.ts:218-238`.
- **Prompt-injection defense documented and active** — screen content from tool results is wrapped in `<untrusted-screen-content>` delimiters with explicit instructions in the system prompt that text inside is DATA, not instructions. Ref `src/core/agent-loop/prompt.ts:14-28, 122-125`.
- **No shell-string command injection in the granular tools** — every spawn site uses argv arrays. The one remaining `Start-Process "…"` interpolation in `navigate_browser` (Win32 branch) is fixed in v0.9.3 — direct `execFile()` against `msedge.exe`.
- **Lockfile JSON.parse is hardened.** `src/surface/pidfile.ts:135-144` only reads explicit known properties from `Partial<LockData>`; no `Object.assign`/spread → no prototype-pollution path.
- **`screenshot_full` MIME type honesty** — declared `image/png`, returned JPEG bytes. Fixed in v0.9.3.

## On the list, not yet addressed (with target version)

- **TOCTOU on consent file**: opening the wrapper described would let two simultaneous starts race. Mitigation in mind: use `flock`/`LockFileEx` semantics for the consent gate. Target: 0.9.4.
- **Keystroke-injection visibility** — the safety layer correctly blocks tier-3 combos (`Alt+F4` on the agent itself, `Ctrl+Alt+Del`, power chords) but the runtime trace doesn't always make the block visible to the consumer LLM. Target: 0.9.4 — make the safety-decision event part of the standard tool-result envelope.
- **No process sandboxing** — clawdcursor runs as the user. Sandboxing would require platform-specific work (AppContainer on Windows, sandbox-exec on macOS, namespaces on Linux). On the long-term roadmap; not a 0.9.x deliverable.
- **`cdp_evaluate` runs arbitrary JS in any attached tab** — by design, but the safety tier should make this more visible. The 0.9.4 work above will surface it. Description will also be updated to warn explicitly.
- **`learn_app` reliability** — the old shape silently succeeded when nothing was written; fixed in 0.9.3 to require a real payload and return `isError: true` with reason when neither lesson nor guide was persisted.

## Defense posture summary (post-0.9.3)

| Threat | Status |
|---|---|
| Command injection via LLM-controlled URLs / app names | Argv-form everywhere; PS quoting defended in depth |
| PID-recycling lockfile bypass on Windows | Closed (JSON lockfile + start-time identity check) |
| Credential leakage in dashboard history | Patterns now match actual credentials; verified end-to-end |
| Unauthenticated /mcp access | Bearer-gated; 401 verified live |
| Cross-origin /mcp access | 403; verified live |
| Prompt injection via screen content | Tagged; agent prompt instructs to ignore embedded commands |
| Stale PID file blocking new instance | Self-heals via identity check |
| Orphan MCP processes after parent crash | Stdin EOF triggers clean shutdown |

## What helps me prioritize

If you can rank the remaining items from your audit by realistic exploit difficulty, I'll align the next two releases against that order. Defense-in-depth items where the threat is "if attacker has shell already" are valuable but lower priority than items where the threat surface is "LLM-controlled tool argument flows into a shell."

Thanks again. Sorry for the silence; that won't repeat.

---

(Edit before posting:
- Confirm the v0.9.3 commit SHAs are correct after merge.
- If you'd rather defer some of the "on the list" items, edit those out — the post should only commit to what you actually intend to ship.
- Drop the "going through it now and tracking everything below" line if it reads as defensive — open with the gratitude + work landed instead.
)
