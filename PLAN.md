# Plan: `claudex` — GPT-5.6 / GPT-6 Astra as an opt-in layer inside Claude Code

## Context

Goal: make GPT models available **in Claude Code's harness** (its tools, permissions, CLAUDE.md) as a purely additive, user-controlled layer — as **subagents/workers** (5.6 tiers, Astra) and as an **adversarial peer** (Astra vs. the Claude director, since Fable 5.1 and Astra are comparable) — while every Claude-native capability stays exactly as it is: any director model (Fable 5.1, Opus 5, Sonnet 5), native Claude subagents in any combination (Fable + Opus 5, Opus 5 + Sonnet 5, …), Workflow, Remote Control, auto/plan/skip-permissions modes. GPT usage is billed to the ChatGPT subscription Codex CLI is logged into; Codex's only role is owning that OAuth login.

Decisions (user, 2026-09-18):

| Decision | Choice |
|---|---|
| Architecture | **Sidecar workers.** Main Fable session is plain first-party `claude` with **no proxy** → Remote Control/phone, push notifications, auto mode, plan mode, skip-permissions, tool search, 1M, fast mode all untouched. GPT tiers run as child headless Claude Code processes (`claude -p --model <gpt slug>`) pointed at a local GPT-only proxy |
| Proxy | **Our own, written in C.** No third-party code touches a credential. GPT-only: no Claude passthrough, and the Claude credential never reaches it (child gets a dummy `ANTHROPIC_AUTH_TOKEN`, which per docs replaces the subscription login for that process) |
| Tiers | `luna`, `sol`, `astra` via family aliases resolved by the proxy's current catalog; the fallback table is `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`. Terra is deprecated and resolves to sol. |
| Client identity | Honest: identifies as Claude Code (third-party harness). Never `codex_cli_rs` or `x-openai-internal-*`. Backend refuses → STOP and report |
| Claude-native | Must remain fully intact and is the default. GPT is opt-in, in two roles (subagent, adversary), **fully user-controllable by prompt, slash command, config file, or CLI/env** |

### Main-session invariants (tested in Verification 1)
claudex never sets, in the main session: `ANTHROPIC_*`, `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)`, `ANTHROPIC_DEFAULT_*_MODEL` alias remaps, `model`/`modelSettings`/`agent` settings, or anything that shadows a built-in agent type. It adds only: new agent types (`claudex:gpt-luna|sol|astra` while enabled, plus `claudex:relay-*` couriers), new namespaced skills/commands, one SessionStart hook that prints a one-line policy, and optional permission rules. Disable the plugin → Claude Code is byte-for-byte what it was.

The Claude Mod follows F1–F8: it hooks session start, review/verdict and file-path tool calls,
`/claudex`, two panes, GPT agent offers/spawns and `turn.step` (F1). Worker actions use argv
calls to `claudex-worker`, never a shell string or `yolo` (F2); it reads no credentials (F3);
off starts no work (F4); unsolicited conversation writes are only owned-job completion,
user-sent decisions or an effective policy change (F5). Its single-flight poller is bounded
and generation-fenced (F6); panes open only on request or for unresolved findings needing
user arbitration (F7). A non-claudex agent's step, spawn, offer or tool call passes through
unchanged, and a main-loop `turn.step` makes no mod API call (F8).

Why not a proxy on the main session: since v2.1.196 Claude Code hard-disables Remote Control (and with it phone push) whenever `ANTHROPIC_BASE_URL` ≠ `api.anthropic.com`, no override, no loopback exemption. Defeating that check (TLS MITM / binary patch) is out of scope by design.

Environment (verified): claude 2.1.276, codex-cli 0.155.0 (ChatGPT OAuth; access token ~10-day life, current expires 2026-09-20). gcc 16.2 / clang 22.1, make, gdb, **libcurl 8.22 (HTTP/2, threadsafe), yyjson 0.13, libseccomp 2.6, Landlock active**, bubblewrap. No valgrind/AFL → clang ASan/UBSan/libFuzzer. OpenRC (no systemd) → on-demand launch. `~/.local/bin` already on PATH (no dotfiles/zshrc change).

Heads-up (not touched): `~/.config/claude-code-proxy/codex/auth.json` (2026-09-17) is a second live ChatGPT refresh token from an earlier upstream-proxy login. Keep or delete — user's call.

## Components

### 1. `claudex-proxy` (C17; libcurl + yyjson + pthreads + libseccomp; Makefile)
Surface: `POST /v1/messages` (stream + non-stream), `POST /v1/messages/count_tokens` (local estimate), `GET /v1/models`, `GET /healthz`; all else 404. Binds `127.0.0.1:18765` only. Upstream host **compiled in**: `https://chatgpt.com/backend-api/codex/responses` (HTTPS SSE; no WebSocket). Thread-per-connection, `Connection: close`, Content-Length bodies only, body cap.

Model handling: `gpt-luna|sol|astra` family aliases and versioned slugs (plus deprecated terra aliases) resolve to the highest served version of each current family; a family missing from the newest generation resolves to sol. The proxy refreshes the backend model catalog at startup and every six hours, with a fallback table if fetching fails. Optional `@effort` suffix (`gpt-astra@ultra`) → `reasoning.effort`; request `output_config.effort` honoured if present; else family default (luna low, sol high, astra xhigh). Non-GPT model names (headless child's background/haiku calls) → luna, logged.

Request translation (Anthropic → Responses):
- `system` → `instructions` (spike 0b fallback: `developer` input message)
- text/image → `input_text`/`input_image`; assistant text → `output_text`
- `tool_use` → `function_call`; `tool_result` → `function_call_output`
- `thinking` ↔ `reasoning`: encrypted reasoning rides in the Anthropic `signature` field, Claude Code echoes it back → proxy is **stateless**
- tools: `input_schema` → `parameters` through a sanitizer (strip `pattern`, `format`, other rejected keywords); `strict:false`; `tool_choice` mapped; Anthropic server tools dropped (v1)
- always `stream:true`, `store:false`, `include:["reasoning.encrypted_content"]`, `parallel_tool_calls:true`, `prompt_cache_key` = hash of session id
- headers: `Authorization: Bearer`, `ChatGPT-Account-Id`, `openai-beta: responses=experimental`, `session_id`, `originator: claude-code`, `User-Agent: claudex/<ver> (Claude Code; third-party harness)`

Response translation: incremental SSE parser → reducer (`output_item.added`, `output_text.delta`, `function_call_arguments.delta`, `reasoning_summary_text.delta`, `response.completed|incomplete|failed`) → Anthropic `message_start` / `content_block_*` / `message_delta` (stop_reason `tool_use`|`max_tokens`|`end_turn`; usage incl. cached → `cache_read_input_tokens`) / `message_stop`, periodic `ping`. Upstream errors → Anthropic error shape (429 → `rate_limit_error` + `retry-after`). Client disconnect aborts the curl transfer.

Auth — **read-only, Codex owns refresh**: re-read `~/.codex/auth.json` per request (`tokens.access_token`, `tokens.account_id`); on 401 re-read + retry once, else `authentication_error`: "ChatGPT token expired — run `codex exec 'ok'`". Recovers without restart; never contacts `auth.openai.com`; token buffers `explicit_bzero`'d.

Self-sandbox (after init, before `accept`): `PR_SET_NO_NEW_PRIVS`, `PR_SET_DUMPABLE=0`, `RLIMIT_CORE=0`; **Landlock** — fs read-only on `~/.codex` (dir, because Codex replaces `auth.json` by rename), CA bundle, resolver files; no write anywhere; TCP bind only :18765, connect only :443; **seccomp** denies `execve/execveat`, `ptrace`, `process_vm_*`, mount family. Logs: metadata only (id, model, status, ms, tokens) to stderr; never headers/bodies.

Build: `-std=c17 -Wall -Wextra -Werror -O2 -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now`. Test build: clang `-fsanitize=address,undefined`; `-DCLAUDEX_TEST` is the only build that allows overriding the upstream URL (fake upstream).

### 2. `claudex-worker` (bash) — runs headless GPT workers and native agent steps
`claudex-worker run|start|wait|result|resume <tier> [--cwd DIR] [--effort E] [--mode read|edit|yolo]`, brief on stdin. (`start`/`wait` exist because the Bash tool caps a call at 10 min.) Native agents use `claudex-worker admit TIER --running N` for policy/parallel admission, then `claudex-worker step TIER [--effort E]` for each streamed model request (no headless child, job or slot).
1. Token preflight: decode JWT `exp` (never print token); <36 h → trivial `codex exec -m gpt-6-luna` so Codex refreshes.
2. Ensure proxy: `/healthz`, else start under `flock` via `setsid`, stderr → `~/.local/state/claudex/proxy.log`; **identity check** — port owner's `/proc/<pid>/exe` must be our binary, bind 127.0.0.1.
3. Launch child with a scrubbed env (`env -i` + HOME/PATH/USER/LANG/TERM):
   `CLAUDE_CONFIG_DIR=~/.local/state/claudex/claude-config` (separate dir: no claude.ai login exists there, no superpowers plugin → no brainstorm gating in workers), `ANTHROPIC_BASE_URL=http://127.0.0.1:18765`, `ANTHROPIC_AUTH_TOKEN=claudex-local`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-luna`, `CLAUDE_CODE_SUBAGENT_MODEL=<alias@effort>`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
   `claude -p --model "<slug>@<effort>" --output-format json --max-turns N --append-system-prompt <worker contract> --permission-mode … --allowedTools …`
4. Modes: `read` = Read/Grep/Glob, `dontAsk`; `edit` (default) = + Edit/Write/NotebookEdit/Bash, `acceptEdits`, Claude Code Bash sandbox on via `--settings` (verify prerequisites); `yolo` = `bypassPermissions`, only on explicit user request. Auto mode is not used in children (its classifier is Claude-only); the **main session's** mode still gates every dispatch.
5. Output: worker's final report, `session_id` (for `resume`), usage, exit code.

### 3. Claude Code side (main session, first-party)
- `skills/delegating-to-gpt/SKILL.md` — for whichever Claude model is directing: **obey the policy in §5 first**; GPT agents add to, never replace, native Claude subagents. Primary dispatch path = Agent with `subagent_type: "claudex:gpt-<tier>"`, background by default; include goal, paths, constraints, done-criteria and verification command. The Agent tool delivers the task notification. **The director re-reads diffs and re-runs tests itself**; errors → report, no retry loop. Bash `claudex-worker` remains for Mods-off sessions.
- `agents/relay-{luna,sol,astra}.md` — Sonnet couriers (`tools: Bash`) for Workflow scripts and Mods-off sessions: pass the brief verbatim to `claudex-worker`, don't do the task, return the report + session id + `git diff --stat`.
- `agents/relay-adversary.md` — courier for the read-only adversarial role (below). There is no terra agent; deprecated terra requests resolve to sol.
- `~/.claude/settings.json`: one `permissions.allow` rule `Bash(claudex-worker:*)` + matching `autoMode.allow` line (via update-config skill). Only settings change.

Packaged as a **Claude Code plugin** (`claudex`, installed from the repo as a local marketplace) so the whole layer is one `/plugin` enable/disable. Works identically whichever Claude model is the director.

- **Claude Mod:** `plugin/hooks/` registers native `claudex:gpt-luna|sol|astra` agent types
  with GPT model aliases and `read` or `edit` tools. It checks spawn admission through the
  worker, serves GPT steps through `claudex-worker step`, and checks file paths lexically for
  Read/Write/Edit/Grep/Glob. Bash follows the session's permissions and sandbox alone. Rows
  show the agent type, tool rows appear live, and GPT text appears when each step completes.
  It adds a status line, workers pane, findings pane and completion toasts. The main session
  exposes only `mcp__claudex__review` and `mcp__claudex__verdict` for reviews;
  `/claudex status|config|workers|findings` are command views with no model turn. The worker
  remains the policy and job-lifecycle authority.

### 4. Adversarial role (Astra as peer, not subordinate)
`/claudex:adversary [plan|diff|<path>|<question>] [--rounds N] [--model <slug@effort>]`, or by prompt ("have Astra attack this plan").
1. Director packages the **artifact only** (plan file, `git diff`, design doc) — not its own reasoning or justification, to avoid anchoring the reviewer.
2. Astra runs as a read-only worker with full repo access and an adversarial contract: find what is wrong, missing, or unverified; each finding = severity, evidence (`file:line` / command output), proposed fix; "no findings" must be justified.
3. Director answers **every** finding: accept (and change the artifact) or rebut with evidence. Silent dismissal is not allowed.
4. Optional further rounds via `claudex-worker resume` (Astra sees only the rebuttals). Default 1 round.
5. Output to the user: findings table with accepted / rebutted / **unresolved** — unresolved disagreements between comparable models are surfaced for the user to arbitrate, never settled by the director alone.
Astra never edits in this role.

### 5. User control (precedence: prompt > slash command > CLI/env > config file > defaults)
Config `~/.config/claudex/config` (KEY=VALUE), every key overridable per session by env (`CLAUDEX_DELEGATION=auto claude`), shown/set with `/claudex:config`, reported by `claudex-worker config`:

| Key | Values (default first) | Meaning |
|---|---|---|
| `CLAUDEX` | `on` / `off` | master switch; `off` → hook prints nothing, skills refuse, Claude-only |
| `CLAUDEX_DELEGATION` | `on-request` / `suggest` / `auto` / `off` | GPT as subagents: only when the user asks / director may propose and wait / director may dispatch on its own within limits |
| `CLAUDEX_ADVERSARY` | `on-request` / `plans` / `plans+diffs` / `off` | when the adversarial pass runs unprompted |
| `CLAUDEX_TIERS` | `luna,sol,astra` | tiers allowed at all; terra accepted as sol |
| `CLAUDEX_DEFAULT_WORKER` | `sol` | tier when the user says "use GPT" without naming one; terra accepted as sol |
| `CLAUDEX_ADVERSARY_MODEL` | `gpt-astra@xhigh` | family alias or versioned slug + effort, up to `@ultra` |
| `CLAUDEX_MAX_PARALLEL` | `4` | headless jobs queue on slots; native agent admission denies at the limit |
| `CLAUDEX_WORKER_MODE` | `edit` / `read` | worker and native agent tools; headless `yolo` is per-call only, never for native agents |

Defaults are conservative: **nothing GPT happens unless the user asks.** A SessionStart hook prints the effective policy in one line so the director knows it; the skill tells the director that the user's in-conversation instruction ("no GPT this session", "use sol for all implementation", "Astra reviews every plan") overrides config for the rest of the session. `claudex-worker` re-checks `CLAUDEX`, `CLAUDEX_TIERS` and `CLAUDEX_MAX_PARALLEL` itself, so policy holds even if the model ignores the skill.

Slash commands: `/claudex:delegate <tier> <task>`, `/claudex:adversary …`, `/claudex:config [key value]`, `/claudex:status` (proxy health, token expiry, enabled tiers, policy).

## Layout — new git repo `~/Documents/Programming/claudex/`
```
src/   main.c http_server.c sse.c auth.c models.c translate_req.c schema.c
       translate_stream.c errors.c sandbox.c log.c buf.c  (+ headers)
tests/ unit/*.c  fuzz/{sse,http,translate_req,schema}_fuzz.c  fake_upstream/  fixtures/ (sanitized)
plugin/  .claude-plugin/plugin.json   agents/relay-{luna,sol,astra,adversary}.md
         skills/{delegating-to-gpt,delegate,adversary,config,status}/SKILL.md
         hooks/hooks.json (SessionStart → `claudex-worker policy-line`)   bin/claudex-worker
.claude-plugin/marketplace.json (repo doubles as a local marketplace)
Makefile (all, test, asan, fuzz, install, uninstall)   PROTOCOL.md
```
`make install` → `~/.local/bin/{claudex-proxy,claudex-worker}`, default `~/.config/claudex/config` if absent, then `claude plugin marketplace add <repo>` + `claude plugin install claudex@claudex-local` (exact spellings checked with `claude plugin validate` / docs at implementation).

## Phases
1. **Protocol notes (read-only):** from `openai/codex` source extract required fields/headers, `instructions` handling, SSE events, error + rate-limit formats → `PROTOCOL.md`.
2. **Spike 0 with plain `curl` before any C** (historical, 2026-09-18; token via `$(jq -r …)`, never echoed): honest-ID text request on the then-served terra + astra; 0b `instructions` = a Claude Code-style system prompt; function-tool call on astra (code_mode_only risk). Save sanitized SSE as fixtures. **Any honest-ID refusal → STOP, report.**
3. **Proxy, TDD:** buf → sse parser → http parser → auth → schema sanitizer → request translation → stream reducer → errors → server; each under ASan/UBSan; libFuzzer targets for the four parsers; fake-upstream integration (parallel tool calls, mid-stream error, client disconnect).
4. **Sandbox + hardening;** negative tests (write, exec, connect to non-443 all fail).
5. **Worker + spikes (historical):** fresh `CLAUDE_CONFIG_DIR` runs headless without onboarding; deprecated `--model gpt-5.6-terra` accepted as sol; which non-GPT requests the child emits; `@effort`; `resume`; Bash sandbox prerequisites.
6. **Policy layer:** config file + env precedence + `claudex-worker config|policy-line`, enforcement of `CLAUDEX`, `CLAUDEX_TIERS`, `CLAUDEX_MAX_PARALLEL` in the worker (shell tests).
7. **Plugin:** skills/commands, relay + adversary agents, SessionStart hook, permission rule; `make install`.
8. **End-to-end verification.**

## Verification
1. **Claude-native intact (run before install, and again after, results must match):** `env | grep -E 'ANTHROPIC|CLAUDE_CODE_SUBAGENT'` empty; a native Claude director spawning native Claude subagents; a Workflow script with mixed Claude models; built-in agent types unchanged in the Agent list; Remote Control pairs from phone; auto mode, plan mode, `--dangerously-skip-permissions`, `[1m]`, tool search all behave as before. Then a **mixed** run: native Claude subagent + `claudex:gpt-sol` agent + Astra adversary in one task.
1b. **User control:** default policy → director does not touch GPT unprompted; "use astra to attack this plan" works by prompt; `/claudex:delegate luna …` works; `CLAUDEX=off claude` → no policy line, skills refuse, `claudex-worker` exits non-zero; `CLAUDEX_TIERS=luna,sol` blocks astra even if asked; `CLAUDEX_MAX_PARALLEL=2` queues a third headless worker and denies a third agent spawn; "no GPT this session" in-prompt is honoured over `CLAUDEX_DELEGATION=auto`; plugin disabled → no `claudex:gpt-*` agents, nothing else changed.
1c. **Adversary:** on a seeded flawed plan, Astra returns evidenced findings; director answers each; an intentionally contested finding is surfaced to the user as unresolved; Astra made no edits.
2. **Each tier:** "which model are you", then create/edit/run a file in a scratch repo; proxy log shows the slug + effort.
3. **Credential isolation:** proxy log/capture never sees a Claude bearer; `claude-config` dir contains no login; `~/.codex/auth.json` mtime unchanged by proxy activity.
4. **Identity:** one spike capture shows `originator: claude-code`, our UA, no `x-openai-internal-*`.
5. **Fan-out:** 3× luna + 1× sol in background, visible in the Agent list and on phone; no 429/5xx; relay agents work from a Workflow script and Mods-off session.
6. **Sandbox:** `ss -tnp` shows only `chatgpt.com:443`; negative tests pass; `make asan test` + 10-min fuzz runs clean.
7. **Expiry path:** expired auth copy (test build) → clean `authentication_error` with the `codex` hint; recovers without restart.
8. **Permissions:** `read` headless worker cannot edit; `edit` headless worker cannot write outside cwd; native agent file-tool paths are checked lexically (not symlinks), and native agent Bash follows the main session's permissions and sandbox; dispatch in main-session auto mode is classified by Claude.

## Rollback
Instant: `CLAUDEX=off` or disable the plugin. Full: `make uninstall` (binaries + plugin + marketplace entry), remove the one settings rule, delete `~/.local/state/claudex/` and `~/.config/claudex/`. `~/.codex`, dotfiles and the rest of `~/.claude` are never modified.

## Unverified going in (resolved by phases 1, 2, 5)
Backend acceptance of honest identity and of non-Codex `instructions`; Astra with plain function tools on this account; exact schema keywords the backend rejects; headless run with a fresh `CLAUDE_CONFIG_DIR`; whether Claude Code forwards effort for unknown model IDs (covered by `@effort`); whether `codex exec` proactively refreshes before expiry; Claude Code Bash-sandbox prerequisites on this machine.
