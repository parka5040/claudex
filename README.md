# claudex

An opt-in GPT layer for Claude Code. GPT families (luna / sol / astra) run as native
**subagents**, headless workers and an **adversarial reviewer** inside Claude Code's harness,
billed to the ChatGPT subscription the Codex CLI is logged into. Claude-native behaviour is
not touched, and nothing GPT happens unless you ask for it.

## How it works

```
your Claude Code session (first-party, no proxy, no env changes)
        │  Bash: claudex-worker run sol <<< "brief"   (headless path)
        ▼
claude -p --model gpt-sol@high            headless child: own config dir, placeholder token
        │  ANTHROPIC_BASE_URL=http://127.0.0.1:18765
        ▼
claudex-proxy (C, sandboxed)              Anthropic Messages  ⇄  OpenAI Responses
        │  reads ~/.codex/auth.json read-only, per request
        ▼
https://chatgpt.com/backend-api/codex/responses
```

Native `claudex:gpt-luna|sol|astra` agents use the Agent tool in the main session. The mod
serves their model steps through `claudex-worker step` and the same proxy; they are not
headless `claude -p` children. `claudex:relay-*` couriers still use the headless path above
for Workflow scripts and sessions where Claude Mods are off.

- **Main session untouched.** No `ANTHROPIC_*` variables or model remapping in the main
  session. Optional permissions allow Bash workers or review tools; native GPT agents keep
  the session's permission mode and explicit deny rules, but run without prompts inside
  claudex's confinement. Remote Control, auto mode, plan mode, native Opus/Sonnet
  subagents and everything else behave as before. Disable the plugin and it is gone.
- **No Claude credential ever reaches the proxy.** Headless workers run with a placeholder
  `ANTHROPIC_AUTH_TOKEN` and a separate `CLAUDE_CONFIG_DIR` that has no login in it;
  native agents' steps go through the local `claudex-worker step` bridge.
- **Codex owns the ChatGPT login.** The proxy only reads `auth.json`; it never refreshes or
  writes tokens. If the login lapses, run `codex exec 'ok'` (or `codex login`).
- **Honest client identity.** Requests say `originator: claude-code` and
  `User-Agent: claudex/<ver> (Claude Code; third-party harness)`. The proxy never sends
  `codex_cli_rs` or any `x-openai-internal-*` header.

## The proxy

C17, libcurl + yyjson + libseccomp. Loopback only. Before serving it confines itself and
refuses to run if it cannot: Landlock (read-only on the Codex auth dir, trust store and
resolver files; no writes anywhere; TCP bind only on its port, connect only to 443/53),
seccomp (no exec, ptrace, mount, bpf, io_uring, namespaces), non-dumpable, no core files.
The upstream URL is compiled in; only `-DCLAUDEX_TEST` builds can point elsewhere. Logs are
one metadata line per request (model, status, timings, token counts, rate-limit headers),
never headers or bodies.

Model families: `luna`, `sol`, `astra`. Use `gpt-luna`, `gpt-sol`, `gpt-astra` (or a
versioned slug such as `gpt-6.1-sol`) with optional `@low|medium|high|xhigh|max|ultra`.
The proxy resolves even a versioned slug to its family's current model. It fetches the
backend model catalog at startup and every six hours; only listed, API-supported GPT family
slugs count. A family is current when served in the newest generation. Otherwise it uses
sol. Until a successful catalog fetch (or after a failed one), fallback models are
`gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`. As of 2026-10-03 those are also the served
models for the three families. A rejected model triggers a refresh; retrying a failed
request may reach a replacement, but that request still fails. `/v1/models` lists the
current families; `/healthz` reports the resolution and whether it came from the backend
or fallback.

`terra`, `gpt-terra` and versioned terra names remain accepted for old settings and
resolve to sol; terra is deprecated and has no agent or courier. Defaults: luna low
(`ultra` clamps to `max`), sol high, astra xhigh. A headless worker's internal background
requests (which name Claude models) go to luna at low effort.

## Control

Precedence: what you say in the conversation > slash command > environment > config file > defaults.

| Key (`~/.config/claudex/config`, or env) | Values (default first) |
|---|---|
| `CLAUDEX` | `on`, `off` — master switch |
| `CLAUDEX_DELEGATION` | `on-request`, `suggest`, `auto`, `off` |
| `CLAUDEX_ADVERSARY` | `on-request`, `plans`, `plans+diffs`, `off` |
| `CLAUDEX_TIERS` | `luna,sol,astra` (`terra` accepted as sol) |
| `CLAUDEX_DEFAULT_WORKER` | `sol` (`terra` accepted as sol) |
| `CLAUDEX_ADVERSARY_MODEL` | `gpt-astra@xhigh` (family aliases or versioned slugs accepted) |
| `CLAUDEX_MAX_PARALLEL` | `4` (1–16; native agent spawns count running native agents plus headless jobs and are denied at the limit; headless workers (Bash, relays, the adversary) count only headless jobs and queue, so they can exceed the limit while native agents run) |
| `CLAUDEX_WORKER_MODE` | `edit`, `read` (headless `yolo` is per call only; not for agents) |

`claudex-worker` enforces the master switch, tier list and parallel limit (including native
agent admission) itself, so they hold even if a model ignores its instructions. One session
only: `CLAUDEX=off claude`. `claudex-worker status` shows the current proxy model resolution
when available, and warns once if any setting uses terra.

```
claudex-worker run TIER [--cwd DIR] [--effort E] [--mode read|edit|yolo] < brief
claudex-worker resume SESSION_ID TIER < follow-up
claudex-worker start TIER … | wait JOB [--timeout S] | result JOB
claudex-worker config | set KEY VALUE | status | stop-proxy
```

## Claude Mods

Claude Code 2.1.288 or later can load the claudex mod. With `CLAUDEX=on` it registers
`claudex:gpt-luna`, `claudex:gpt-sol` and `claudex:gpt-astra` as native Agent types for
enabled tiers. Dispatch them with the Agent tool, normally in the background: their tool
rows appear live in the agent panel and the Agent tool notifies the parent when they finish.
GPT agents finish by calling SubagentHandback like native agents, and each is capped at 200 turns.
GPT text appears when each step completes, not live as its text is streamed. The Agent row
shows the agent **type**, not the resolved GPT model. TaskStop cancels the agent's step.
Agent admission checks the switch, enabled tiers and parallel limit; a refused spawn does
not start an agent. The separate `claudex:relay-*` agents remain for Workflow scripts and
Mods-off sessions; the adversary remains a read-only worker.

Native GPT agents run **without permission prompts, confined by claudex** ("yolo, but
sandboxed"). Auto mode cannot judge GPT calls: its classifier verdict comes with the
Anthropic response that produced a tool call, and GPT steps make no such request. The mod
approves only tool-call ids emitted by GPT steps, after checking the core verdict;
explicit deny rules and plan-mode denials still apply. Agents keep the session's permission
mode; this is not `bypassPermissions`.

A mod path check confines Read, Write, Edit, Grep and Glob calls to paths lexically inside
the agent's working directory, then checks resolved paths to reject symlinks pointing outside.
Bash is rewritten to `/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash
'<plugin>/bin/claudex-worker' sandbox --cwd '<agent cwd>' --path "$PATH" -c '<command>'`;
**Bash rows show this wrapper**. Background Bash is not available to GPT agents.
Bubblewrap allows writes only in that directory and private temporary storage, with no
network. The rest of the filesystem is read-only; `/run` is hidden (as is `/var/run` when
it is a real directory). Home is hidden except for the working directory and existing
read-only toolchain and cache directories (`~/.local/bin`, `~/.local/lib`, `~/.cargo`,
`~/.rustup`, `~/go`, `~/.cache`, `~/.npm`). Residual reachable pathname sockets are those
inside the working directory and these read-only toolchain directories. Missing or unusable
bubblewrap refuses the command, never runs it unsandboxed. Native agents have `read`
(Read, Grep, Glob; Bash denied) or `edit` (those plus Edit, Write, Bash) tools, not a
per-agent `yolo` mode.

The mod shows running workers **and agents**, plan use and login life in the status line;
headless workers and adversary findings in panes; and completion, low-login and
plan-limit toasts. `/claudex status` (the default), `/claudex config [KEY VALUE]`,
`/claudex workers`, and `/claudex findings [JOB]` run without a model turn. The review
tools are `mcp__claudex__review` and `mcp__claudex__verdict`; add those names to
`permissions.allow` for unattended reviews. For Bash relays, add
`Bash(claudex-worker *)` if desired. Plan mode and deny rules still apply.

Without the mod (Claude Mods is early access and can be switched off for an account), use the
`/claudex:status` and `/claudex:config [KEY VALUE]` skills, or `! claudex-worker status`,
`! claudex-worker config`, `! claudex-worker set KEY VALUE`. The mod hooks its session,
review tools, file-path tools, Bash sandbox rewrite, GPT-call permission checks, command,
panes, GPT agent offer/spawn and agent steps only. A non-claudex agent or main-loop step
or Bash call passes through unchanged (F8); main-loop steps and Bash calls make no mod API
call. All actions use worker builders, including the quoted Bash sandbox wrapper, never
an unsandboxed command or `yolo` (F2);
the mod never reads credentials (F3). When off it starts no new work (F4). It submits only
owned-job completion notices, user-sent decisions, and effective policy changes (F5).
Polling is bounded and generation-fenced (F6). Panes open on request, except unresolved
findings needing user arbitration (F7). Plan usage is unknown when the proxy runs under
systemd because its log is in the journal.

## Install

Needs Linux 6.7+ (Landlock ABI 4), Claude Code, the Codex CLI logged in (`codex login`), and
the build dependencies (a C compiler, make, pkg-config, libcurl, yyjson, libseccomp).
Install the latest published release from source:

```
curl -fsSL https://raw.githubusercontent.com/parka5040/claudex/main/install.sh | bash
```

Pass flags after `bash -s --`:

```
curl -fsSL https://raw.githubusercontent.com/parka5040/claudex/main/install.sh | bash -s -- --service
curl -fsSL https://raw.githubusercontent.com/parka5040/claudex/main/install.sh | bash -s -- --uninstall
```

`--service` runs the proxy as a per-user systemd/OpenRC service; `--uninstall` removes it
without downloading a release. The bootstrap selects the latest **published GitHub release**,
downloads its source archive, checks it, then builds locally; there is no prebuilt binary. If no release is published,
it stops and asks you to pass `--ref main` for the development branch (no silent fallback).
Re-run the install command to update. It never edits your Claude Code permission settings;
consider `Bash(claudex-worker *)`, `mcp__claudex__review` and `mcp__claudex__verdict`.

From an unpacked release archive or a checkout instead:

```
./install.sh              # checks prerequisites, builds, installs to ~/.local, registers the plugin
./install.sh --service    # same, and runs the proxy as a per-user systemd/OpenRC service
```

The unpacked directory can be deleted afterwards. To remove everything:
`~/.local/share/claudex/kit/install.sh --uninstall`. Build a source zip with `make dist`.

## Build and test

```
make            # hardened release binary -> build/claudex-proxy
make check      # unit tests (ASan+UBSan), fake-upstream integration, worker and plugin checks
make fuzz       # libFuzzer harnesses, FUZZ_SECONDS=60 each
```

To release: bump the version in `plugin/.claude-plugin/plugin.json`, commit, tag and push
`vX.Y.Z`, then publish a GitHub release (`gh release create vX.Y.Z --generate-notes`).
The bootstrap's `releases/latest` sees published releases, not bare tags.

`PROTOCOL.md` documents the backend as spoken by the open-source Codex client;
`SPIKES.md` records what was verified live. `tests/live/native_agent.sh` is a manual
regression check, not part of `make check`.

## Caveats

Anthropic documents routing Claude Code to non-Claude models through a gateway as
unsupported (the headless workers use that path; native agents receive GPT steps through
the mod; your main session is not routed through a gateway).
OpenAI's docs do not address using a ChatGPT-plan login from a third-party harness. The
backend is undocumented and can change. Usage counts against your ChatGPT plan limits, and
once a plan window is exhausted requests may draw on paid credits — the proxy log shows
`used_pct` and `limit` on every line.
