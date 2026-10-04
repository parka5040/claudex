# Spike log

## Spike 0 — honest identity on the normal lane (2026-09-19) — PASS
`spikes/spike0.sh tiers`: one-word prompt, `originator: claude-code`,
`User-Agent: claudex/0.1 (Claude Code; third-party harness)`, no `x-openai-internal-*`,
no `x-codex-*`, no `OpenAI-Beta`, uncompressed JSON body.

| model | HTTP | result |
|---|---|---|
| gpt-5.6-luna | 200 | "hello" |
| gpt-5.6-terra | 200 | "hello" |
| gpt-5.6-sol | 200 | "hello" |
| gpt-6-astra | 200 | "hello" |

Resolved PROTOCOL.md open questions: #1 (normal lane serves all four tiers, incl. luna,
on plan `pro`), #2 (`claude-code` originator accepted), #7 (uncompressed bodies accepted),
#9 partially (no keepalive/rate-limit typed events seen on a short HTTP stream).
Server echoed `reasoning.context: "all_turns"` and `summary: "detailed"` without being asked.

Observed: event order created → in_progress → output_item.added → content_part.added →
output_text.delta → output_text.done → content_part.done → output_item.done → completed.
`event:` lines are present; JSON `type` matches. Message items carry `phase: "final_answer"`.
Usage: `input_tokens`, `input_tokens_details.{cached_tokens,cache_write_tokens}`,
`output_tokens`, `output_tokens_details.reasoning_tokens`, plus a large `usage.attribution` map.

Rate-limit headers: `x-codex-primary-used-percent`, `-window-minutes` (10080 = weekly),
`-reset-after-seconds`, `x-codex-active-limit`, `x-codex-credits-balance`.
NOTE: weekly window was at 100% during this run and `active-limit: premium` with a credits
balance — requests appear to draw on paid credits once the plan window is exhausted.
The proxy should surface these headers in its log line.

Still open: function tools on each tier (esp. astra), Claude-Code-sized `instructions`,
reasoning-item echo, parallel tool calls, non-auto tool_choice, schema keywords rejected.

## Spike 1 — release proxy (sandboxed) against the real backend (2026-09-19) — PASS
`spikes/spike1.sh`, Anthropic-format requests through `build/claudex-proxy`.
- TLS + DNS work under Landlock/seccomp.
- A Claude-Code-sized system prompt is accepted as `instructions` (no developer-message fallback needed).
- **gpt-6-astra accepts plain function tools** (`code_mode_only` is client-side only); luna too. Full tool loop (call -> result -> answer) works on both.
- Reasoning round-trip verified on gpt-5.6-sol@high: leg 1 returned a thinking block with a 1.5 KB
  `cx1:rs_…` signature; leg 2 echoed it back as a `reasoning` item with `id` + `encrypted_content` -> HTTP 200, correct answer.
- `x-codex-active-limit: premium` is present at 0 % usage too, so it names the limit family; it does not
  by itself mean paid credits are being drawn (correcting the Spike 0 note).

## Spike 2 — real `claude -p` child through claudex-worker (2026-09-19) — PASS
Claude Code 2.1.278, fresh `CLAUDE_CONFIG_DIR`, placeholder `ANTHROPIC_AUTH_TOKEN`.
- No onboarding/trust prompt; `--model gpt-5.6-luna@low` accepted verbatim; `--tools` restricts the tool list
  (request carried exactly Glob, Grep, Read); `--permission-mode dontAsk|acceptEdits` work headless.
- read worker (luna): used Read, diagnosed the seeded bug, identified itself as gpt-5.6-luna@low.
- edit worker (sol): fixed `calc.py`, ran the test, reported real output; verified independently with
  `git diff` + re-running the test. `resume <session>` continues the same conversation.
- Request shape seen from the child: `metadata.user_id` is a JSON document with `session_id`
  (older `_session_<uuid>` form no longer used) — extractor fixed; `output_config.effort` IS sent for
  unknown model names; `thinking:{type:adaptive}`; header `x-claude-code-session-id`; path `/v1/messages?beta=true`.
- Prompt caching: with `prompt_cache_key`/`session-id` set from that session id, turn 2+ report
  `cached=2560` of ~3 k input tokens (before the fix: always 0).
- The proxy is non-dumpable, so `ss -p` / `/proc/<pid>/exe` cannot identify it -> launcher nonce via /healthz.

## Spike 3 — worker confinement, verified against ground truth on disk (2026-09-19)
Finding: `--allowedTools Write` (bare name) approves Write **everywhere** — an edit worker created a file
in `$HOME`. Same for `Read` (a worker could read `~/.ssh` / `~/.codex/auth.json` and send it upstream).
Probed flag combinations live; `permission_denials` in the `-p` JSON is the harness's own record and is
more reliable than the worker's narration (workers reported denied/virtualised operations as "succeeded").

| mode | flags | result |
|---|---|---|
| read | `--permission-mode dontAsk --tools Read,Grep,Glob`, **no** `--allowedTools` | reads inside cwd OK; Read/Glob outside cwd denied |
| edit | `acceptEdits`, `--tools …`, `--allowedTools Bash`, sandbox on (`failIfUnavailable`, no unsandboxed retry, `filesystem.denyRead:[$HOME]`, `allowRead:[cwd, toolchains]`) | Write/Edit outside cwd denied; Bash writes outside cwd never reach the real fs; `$HOME` invisible to Bash except cwd; no network from Bash; python/git inside cwd work |

Consequence: worker Bash has no network by default (no `pip install`, `cargo fetch`, `git fetch`). Use
`--mode yolo` per call, on the user's explicit request, when a task genuinely needs it.

## Installed-system verification (2026-09-19)
- Main session: no `ANTHROPIC_*`, `CLAUDE_CODE_SUBAGENT*` or `CLAUDEX*` variables; settings change is exactly two appended entries.
- Fresh first-party `claude -p`: sees the SessionStart policy line, agent types `claudex:gpt-{luna,terra,sol,astra,adversary}`,
  skill `claudex:delegating-to-gpt`. With `CLAUDEX=off` the hook prints nothing.
- Installed worker: `CLAUDEX=off` -> exit 3; disabled tier -> exit 4; luna read worker through the installed proxy OK;
  proxy reports `NoNewPrivs: 1`, `Seccomp: 2`; `/proc/<pid>/exe` and `environ` unreadable, `ss -p` cannot attribute the socket.
- Adversary live (gpt-6-astra@xhigh, read-only) on a seeded flawed plan: caught "edit the test to match the bug" with
  `calc.py:2` / `test_calc.py:2` evidence, marked the step it could not run as UNVERIFIED, changed no files.
- Relay agent from a fresh session via the Agent tool: works with Sonnet as the relay model (see tests/skills/RESULTS.md).
Not yet exercised by me: Remote Control pairing from the phone, a Workflow script using the agent types, and a
Fable-director + Opus-subagent + GPT-worker mixed run in an interactive session. Nothing in the main session was
changed that could affect them, but they are the user's to confirm.

## GPT-6 Luna and Sol (2026-09-23) — PASS
`codex debug models` (codex-cli 0.156.1) now lists `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` and the
older `gpt-5.6-sol|terra|luna`; there is no `gpt-6-terra`. `gpt-6-luna` supports `low..max` (no `ultra`),
`gpt-6-sol` supports `low..ultra`. The luna and sol tiers moved to the GPT-6 slugs; terra stays on 5.6.
- `spikes/spike0.sh tiers`, normal lane, honest identity: `gpt-6-luna`, `gpt-5.6-terra`, `gpt-6-sol`,
  `gpt-6-astra` all HTTP 200, "hello".
- `spikes/spike1.sh` through the release proxy: tool loop with the reasoning round-trip OK on `gpt-6-luna@low`
  (the background tier) and `gpt-6-astra@xhigh`.

## Claude Mods spikes (2026-10-01)

| Spike | Result |
|---|---|
| S1 permission gate | **GO.** Without the gate, a hook-served tool ran with no prompt in default and plan mode. `$.tool.check({ tool, input })` returned `ask` by default, `allow` for an allow rule, and hid the tool for a deny rule. Plan mode declined or returned `ask`. No non-allow decision had a side effect. Served tools must return `{ result: string }`. |
| S2 stub process and clock | **PASS.** Stubs return `{ value: … }`; `mock.clock(on).advance(ms)` drives `$.clock.every`; state is observed beneath `state.get/set`; every called operation needs a beneath answer. |
| S3 prompt submission from an idle timer | Manual user check. |
| S4 plugin test in a GPT edit worker | **PASS.** |
| S5 type check | **PASS.** `deno check` with a `deno.json` mapping to the Claude Code declarations caught `context` being `readonly string[]`. |

## Native-agent spikes (2026-10-03)
Two sol workers in yolo mode (user's choice), Claude Code 2.1.288, nested sessions under the
claudex config dir. Throwaway mods, drivers and captures: `spikes/native-agents/`
(`FINDINGS-A.md`, `FINDINGS-BC.md` hold the evidence). Design that followed:
`docs/superpowers/specs/2026-10-03-publish-agents-lineup-design.md`.

| Spike | Result |
|---|---|
| A1 tool loop | **PASS.** Tool calls a `turn.step` hook yields without `next` run as real subagent tools; the next step sees the results in `$.session.messages({agentId, as:'api'})`. |
| A2 result | The report reaches the parent through `SubagentHandback`, as for native agents (native transcripts in `~/.claude/projects` use it too); a hook must synthesize it. |
| A3 transcript | **PASS.** tool_use/tool_result and usage recorded; hook-made thinking (even proxy-signed) is dropped. |
| A4 prompt | Headless: first user message holds env, CLAUDE.md and the Agent prompt. Interactive background spawn: **the Agent prompt was missing** — capture it at `agent.spawn`. |
| A5 fetch | `$.http.fetch` reaches the proxy (2–9 s replies); timeout and size limits UNVERIFIED. |
| A6 schemas | `$.tool.list()` has no schemas; captured table in `tool-schemas-2.1.288.json`. The engine validates inputs (`InputValidationError`). Glob was unavailable in one run. |
| A8 permissions | Session mode (auto here) governs the agent's tools; a `tool.call` hook can deny by `agentId`. |
| U1 UI | Agent row, background task and agent list appear. No tool rows inline under the Agent row — **no native control was run**, and the agent panel was not opened: UNVERIFIED as a difference. |
| B1 long step | **PASS.** A made-up step of 225 s with a 75 s silence completed. |
| B2–B4 | Handback works foreground and background; TaskStop closes the generator and kills its `$.process.spawn` child; a whole-session SIGINT does not reliably run async `finally` work. |
| B6 progress | Jobs expose state and elapsed only; `stream-json --verbose` would give per-tool events. |
| U2 live text | Streamed text did not show until the step ended (no native control). |
| Hook shape | A `turn.step` hook must return a complete `TurnStepResult`, and a `stop` chunk's usage needs all four token counts, **or the engine skips the hook and runs its own model**. |
| C1 lineup | `GET /backend-api/codex/models?client_version=…` → `{models:[…]}` with `slug`, `priority`, `visibility`, `supported_in_api`; no release date. |
| C2 probes | `gpt-6.1-sol` 200 "hello"; `gpt-6.1-luna` and `gpt-6.1-astra` 400 "not supported". |
| Gate (plan task 0) | `FINDINGS-GATE.md`: with the agent panel open, a GPT agent's view shows the same tool rows as a native `general-purpose` control; a skipped hook fails the step with HTTP 404 `model_not_found` (no Claude reply); rows show the agent type, not a model; GPT text appears when its step completes; a 107 s sol@high step completed through `$.process.spawn`. User decided GO. |
