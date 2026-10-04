# claudex: one-command install, native GPT agents, model lineup — design

Date: 2026-10-03. Status: sections C1–C3 approved by the user; awaiting review of this written
spec. Evidence: `SPIKES.md`, "Native-agent spikes (2026-10-03)", and `spikes/native-agents/`.
Requires Claude Code ≥ 2.1.288. Plugin version becomes 0.3.0.

## Goal

1. **Publish** claudex with a one-command install.
2. **GPT agents that are native subagents**: a GPT worker shows up everywhere Claude Code shows
   its own subagents (the Agent row, the agent panel and its transcript, background tasks, task
   notifications, TaskStop), because it *is* one: the engine runs the loop and the tools, and the
   mod supplies the model's answers from GPT.
3. **Model lineup**: retire terra (no GPT-6 model); every tier follows the newest model of its
   family (`gpt-6.1-sol` today) without a claudex release.

Decisions made with the user (2026-10-03):

| Question | Choice |
|---|---|
| Install | **`curl \| bash` bootstrap**; the mod is not part of installing |
| Proxy binary | **build from source only**; no prebuilt binaries, no release CI |
| Agent design | **fully native** (spike A), not the native shell (spike B) |
| Courier agents | renamed **`claudex:relay-*`**; kept for Workflow scripts and Mods-off sessions |
| `mcp__claudex__run` / `wait` | **removed**; the Agent tool replaces them |
| Terra | **deprecated**, served by sol |
| Luna | **current** (`gpt-6-luna` is served) |
| Who builds it | design in the main session; code, tests and adversarial review by GPT agents |

## C1. One-command install

```
curl -fsSL https://raw.githubusercontent.com/parka5040/claudex/main/install.sh | bash
curl -fsSL …/install.sh | bash -s -- --service        # flags pass through
curl -fsSL …/install.sh | bash -s -- --uninstall
```

`install.sh` has two modes, chosen by where it runs:

- **Local mode** (a `Makefile` sits next to `${BASH_SOURCE[0]}`: a checkout or an unpacked
  tarball): today's flow — prerequisite checks with per-distro package hints, build, copy the
  plugin to `~/.local/share/claudex/marketplace`, `make install`, keep the uninstall kit,
  optional `--service`.
- **Bootstrap mode** (anything else: piped into `bash`, or `bash <(curl …)`):
  1. Checks `uname -s` is Linux and that `curl` and `tar` exist.
  2. `--uninstall`: runs `~/.local/share/claudex/kit/install.sh --uninstall` if present, else
     exits non-zero with "claudex is not installed". Nothing is downloaded.
  3. Resolves the ref: `--ref REF` or `CLAUDEX_REF`; otherwise `tag_name` from
     `https://api.github.com/repos/$CLAUDEX_REPO/releases/latest` (`CLAUDEX_REPO` defaults to
     `parka5040/claudex`). No published release → exit non-zero: "no claudex release is
     published yet; pass --ref main to install the development branch". Never a silent
     fallback to a branch.
  4. Downloads `https://github.com/$CLAUDEX_REPO/archive/$REF.tar.gz` with
     `curl -fsSL --proto '=https' --tlsv1.2` into a `mktemp -d` directory removed by a trap on
     exit. Unpacks it; requires exactly one top-level directory holding `install.sh`,
     `Makefile` and `plugin/.claude-plugin/plugin.json`.
  5. If REF is `v<semver>` and differs from `plugin.json`'s `version`, warns (does not stop).
  6. Runs the unpacked `install.sh` (local mode) with the remaining arguments and
     `</dev/null`, then removes the temp directory and exits with its status.

Rules for being piped:

- The whole script is functions; the last line is `main "$@"`. A truncated download defines
  functions and runs nothing.
- Nothing reads the pipe: every child process in both modes gets `</dev/null`.
- Test-only overrides `CLAUDEX_GITHUB` and `CLAUDEX_GITHUB_API` replace the two base URLs;
  only when one is set does `--proto` also allow `http` (for a loopback test server).

Re-running the command is the update path (it already stops the proxy, rebuilds, re-copies and
runs `claude plugin marketplace update` / `claude plugin update`). The closing message lists
the permission rules still worth adding — `Bash(claudex-worker *)` (relays),
`mcp__claudex__review`, `mcp__claudex__verdict` — and the installer still never edits
`~/.claude/settings.json`. The `run`/`wait` rules are gone with those tools.

**Releasing**: bump `plugin.json` `version`, commit, `git tag vX.Y.Z`, push the tag, publish a
GitHub release for it (`gh release create vX.Y.Z --generate-notes`); `releases/latest` sees
published releases, not bare tags. GitHub serves the source tarball; nothing else is hosted.
README: the one-liner leads "Install"; the release steps go under "Build and test".

**Tests** (`tests/install/bootstrap_test.sh`; new `make install-test`, part of `check`): a
throwaway tree whose stub `install.sh` records its arguments, working directory and whether
stdin is `/dev/null`, packed as `claudex-v9.9.9/` in a tarball and served by
`python3 -m http.server` on a free loopback port beside a fake `repos/x/y/releases/latest`;
temporary `HOME`/`PREFIX`/`XDG_*`. Cases:
- `cat install.sh | bash -s -- --service` with the overrides: the stub ran once with
  `--service`, stdin was `/dev/null`, the temp directory is gone afterwards.
- `--ref main` downloads `main.tar.gz` and skips the releases API.
- No release (API 404): non-zero exit, the message above, the stub never ran.
- Version mismatch (`v1.0.0` tag, `9.9.9` manifest): warning on stderr, install proceeds.
- `head -c <half> install.sh | bash`: no side effects (stub never ran, no new files in HOME).
- `--uninstall` with no kit: non-zero, "claudex is not installed", the server saw no request.

## C2. Model lineup

**Families** are `luna`, `sol`, `astra`, `terra`. A served model belongs to a family when its slug
matches `^gpt-(\d+)(?:\.(\d+))?-(luna|sol|astra|terra)$`; its version is (major, minor), minor
0 when absent. The **newest generation** is the highest major version any served model has (6
today). A family is **current** while it has a served model of the newest generation and then
resolves to its highest-version served model; otherwise it is **deprecated** and resolves to
what sol resolves to.

| Asked for | Resolves to (2026-10-03) | Note |
|---|---|---|
| `luna`, `gpt-luna`, `gpt-6-luna`, `gpt-5.6-luna` | `gpt-6-luna` | 6.1-luna is not served (400) |
| `sol`, `gpt-sol`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-5.6-sol` | `gpt-6.1-sol` | served (200), priority 1 |
| `astra`, `gpt-astra`, `gpt-6-astra` | `gpt-6-astra` | 6.1-astra is not served (400) |
| `terra`, `gpt-terra`, `gpt-5.6-terra` | sol's model | deprecated |

**Discovery (the proxy).** At start and every 6 hours, and at most once a minute after a request
the backend rejected as an unsupported model, the proxy fetches
`GET https://chatgpt.com/backend-api/codex/models?client_version=<V>` with the same honest
headers it sends today. `<V>` is the installed Codex CLI's version, which `claudex-worker` reads
with `codex --version` and passes when it starts the proxy (`CLAUDEX_CODEX_VERSION`); absent, a
pinned default (`0.160.0`). From the `models` array it keeps rows with `visibility == "list"`
and `supported_in_api == true` whose slug matches the family pattern, and applies the rule above.
`priority` is not used (it ranks across families, and there is no release-date field).

- **Fallback table** in `src/models.c`, used before the first successful fetch and whenever the
  last fetch failed or produced no current family: luna `gpt-6-luna`, sol `gpt-6.1-sol`, astra
  `gpt-6-astra`, terra deprecated. Updated by hand when a release changes the lineup.
- **Rejected model**: when the backend answers 400 "model … not supported" for a resolved slug,
  the proxy marks that slug unusable until the next successful fetch, re-resolves the family
  (next lower version, else the fallback table), and returns the error for that one request; the
  caller's retry lands on the replacement. No silent guessing of slugs that were never listed.
- **Parsing** lives in `src/models.c` (`models_catalog_load(const char *json, size_t len)`,
  yyjson; resolution stays a pure function of the loaded catalog), fetching in `src/upstream.c`.
  The catalog is swapped atomically under the server's existing threading model.
- **Names accepted** by the proxy: family aliases `gpt-luna|sol|astra|terra`, any
  `gpt-<version>-<family>` slug (it resolves to its family's current model), each with an optional
  `@effort`. Unknown families are rejected as today. Claude Code's own background calls (non-`gpt-`
  names) go to luna as today.
- **Efforts**: per family — luna `low` (no `ultra`, clamped to `max`), sol `high`, astra `xhigh`.
  A deprecated family takes the efforts of the family it resolves to.
- **`/v1/models`** lists the current families' resolved slugs. `/healthz` adds
  `"models": {"luna": "gpt-6-luna", …, "source": "backend"|"fallback", "fetched_age_s": N}`.
- **`claudex-worker`**: tiers `luna,sol,astra` (default `CLAUDEX_TIERS`); `CLAUDEX_DEFAULT_WORKER`
  default `sol`; `terra` stays accepted in `CLAUDEX_TIERS`, `CLAUDEX_DEFAULT_WORKER` and on the
  command line and means sol; `CLAUDEX_ADVERSARY_MODEL` accepts family aliases and slugs, default
  `gpt-astra@xhigh` (`gpt-6-astra@xhigh` stays valid). Workers start Claude Code with
  `--model gpt-<family>[@effort]`, so the proxy alone decides the slug. `status` (and the
  SessionStart policy line) shows the resolution from `/healthz` when the proxy is up, and
  `terra is deprecated (served by sol)` once while any setting names terra.
- **Mod**: tier enums become `luna|sol|astra` (`terra` accepted as input and mapped to sol).
- **Tests**: `tests/unit/models_test.c` covers the rule with catalog fixtures (today's list; a
  list adding `gpt-6.1-luna`; one adding `gpt-7-sol` only, which deprecates luna and astra; an
  empty list; malformed JSON; hidden or `supported_in_api: false` rows), alias and slug
  resolution, effort clamping, and the rejected-model path. Worker tests cover the defaults,
  terra mapping and the status line. A fuzz seed for `models_catalog_load`.

## C3. GPT agents as native subagents

### Agent types

While `CLAUDEX=on`, the mod registers with `$.agent.register` one type per enabled tier:
`claudex:gpt-luna`, `claudex:gpt-sol`, `claudex:gpt-astra`. Each has:

- `description`: the tier's use (luna: bulk mechanical work from an exact spec; sol: complex
  multi-file implementation and debugging; astra: the hardest problems and peer-level second
  opinions), plus "Runs on GPT through claudex; use only when the claudex policy or the user
  permits GPT."
- `prompt`: the worker contract (`WRITE_CONTRACT` or `READ_CONTRACT` text, moved into the mod
  as the single copy the agents use; `claudex-worker` keeps its own for headless workers).
- `tools`: per `CLAUDEX_WORKER_MODE` — `read`: `Read, Grep, Glob`; `edit`: those plus
  `Edit, Write, Bash`. `yolo` does not exist for agents.
- `model`: the tier's family alias (`gpt-sol`), never a Claude model. It is the fall-through
  guard (below); verified at the gate: a skipped hook ends the agent with `model_not_found, HTTP
  404` and no Claude reply. The Agent row and agent list show the type name
  (`claudex:gpt-sol`), as they show a native agent's type, not its model.
- `effort`: the family default.

An `agent.offer` hook matched to each `claudex:gpt-*` type answers `{ isOffered: false }` while
claudex is off or that tier is disabled (the API has no unregister). A policy change re-registers
the types (mode change) and flips the offer answers.

The courier files become `plugin/agents/relay-{luna,sol,astra,adversary}.md`
(`claudex:relay-*`), unchanged in behaviour except the tier names; their descriptions say they
are for Workflow scripts and for sessions where the Mods switch is off. `gpt-terra.md` is
deleted. Workflow scripts use `claudex:relay-*`: a workflow's agents carry ids
`$.agent.list()` does not name, so native agents are not promised there.

### Spawn admission

An `agent.spawn` hook matched to `claudex:gpt-*` subagent types:

1. Counts running claudex agents from `$.agent.list()` (`type` starts with `claudex:gpt-`,
   `status === 'running'`).
2. Runs `claudex-worker admit <tier> --running <n>` (`$.process.run`, 15 s timeout). The worker
   applies `CLAUDEX`, the tier list and `CLAUDEX_MAX_PARALLEL` (its own running jobs plus `n`),
   exits 0, or exits non-zero with the reason on stderr.
3. Non-zero → `{ deny: <reason> }` (the model sees it as the Agent tool's error). Zero →
   `await next(e)`; on an `agentId`, records `{ tier, cwd: e.cwd ?? session cwd, prompt:
   e.prompt, mode, model }` in the agent registry.

The registry lives in `$.state` (`claudex.agents`) so it survives a module reload; entries are
dropped when `$.agent.list()` no longer reports the agent running, on the poller's tick.

### Steps

A `turn.step` hook (async generator):

- **Pass-through**: a step without `e.agentId`, or whose `agentId` is not a claudex agent, is
  `return yield* next(e)` — no `$` call, nothing else. For an `agentId` missing from the
  registry, one `$.agent.list()` lookup decides, and the answer is cached for that id. A
  `claudex:gpt-*` agent found that way gets an entry built from its type (tier from the name, cwd
  = the session's, no spawn prompt to re-inject) and is served like any other.
- **A claudex agent's step** never calls `next`. It:
  1. Reads `$.session.messages({ agentId, as: 'api' })`.
  2. If no user text block contains the registered spawn prompt, prepends it as a text block to
     the first user message (spike A4: the interactive background spawn omitted it).
  3. Splices back the agent's retained signed thinking blocks (below).
  4. Builds the request: `system` = the registered prompt; `messages`; `tools` = the shipped
     schema table (`plugin/hooks/tool-schemas.ts`, generated from
     `spikes/native-agents/tool-schemas-2.1.288.json`) filtered to the type's tools and to the
     names `$.tool.list()` reports now (spike A6: Glob can be absent); `max_tokens` 32000;
     `stream: true`. No `model` field: the worker sets it.
  5. Runs `$.process.spawn({ argv: [root/bin/claudex-worker, 'step', tier] })` with the
     request on stdin. Reads the worker's NDJSON stream, translating as it arrives: text
     deltas → `text` chunks; `tool_use` start → `tool` chunk; input JSON deltas → `input`
     chunks; thinking → `thinking` chunks (shown, not recorded) and kept; `message_delta` /
     `message_stop` → one `stop` chunk with `stopReason` and `usage` carrying all four counts
     (missing counts are 0 — spike A: a usage without all four makes the engine skip the hook).
  6. Returns a complete `TurnStepResult` (`turnId`, `index`, `answer`, `toolUses`,
     `stopReason`, `usage`) — spike B: chunks without a result make the engine skip the hook.
- **Handback**: when the agent's previous step ended with `end_turn` (no tool calls), the next
  step answers without running GPT: one `tool` chunk `SubagentHandback` with input
  `{ "message": <that step's final text> }`, a `stop` (`tool_use`, usage null) and its result
  (spike B). The final text is kept in the registry entry from the step that produced it.
- **Reasoning continuity**: thinking blocks from a step (text and signature as the proxy sent
  them) are kept in the registry entry keyed by that step's first `tool_use` id; when building
  a later request, each assistant message whose first `tool_use` id has kept blocks gets them
  re-inserted before its other content. Kept blocks are dropped with the entry. (Spike A7: the
  engine drops hook-made thinking.)
- **Fails closed**: every claudex step body is one `try` whose `catch` (and every non-zero worker
  exit or malformed stream) yields a text chunk `claudex: <reason>`, a `stop` (`end_turn`, usage
  null) and a result, so the agent's next step hands the error back to the parent. The hook never
  throws for a claudex step. Second guard: the registered `model` is a GPT alias, so if the engine
  ever runs its own request for such a step (hook skipped), it fails at Anthropic instead of
  running Claude. Verification gate item 1 confirms this.
- **What the agent view shows** (gate items 2–3): tool rows appear live, as for the native
  control; GPT's text appears when its step completes, although the hook streams it (the engine
  renders hook-supplied text then). Documented as a known limitation.
- **Cancellation**: TaskStop closes the generator and kills the spawned worker (spike B4). The
  worker's `step` holds no state that outlives its process.

### `claudex-worker step` and `admit`

- `claudex-worker step TIER [--effort E] < request.json`: checks `CLAUDEX` and the tier (same
  messages and exit codes as `start`), `ensure_proxy`, token preflight; sets `model` to
  `gpt-<family>[@effort]` and `stream: true`; POSTs to the proxy's `/v1/messages` with `curl -N`;
  writes each SSE `data:` payload as one NDJSON line to stdout. HTTP errors: the error body on
  stderr, exit 7. No job directory, no slot (admission already counted the agent). Stdin limit
  32 MiB.
- `claudex-worker admit TIER --running N`: the policy checks of `start` plus
  `N + running worker jobs < CLAUDEX_MAX_PARALLEL`; exit 0 or the same non-zero codes as `start`.

### File-path rule

A `tool.call` hook matched to `Read`, `Write`, `Edit`, `Grep`, `Glob` passes through untouched
unless `e.agentId` is a claudex agent. For a claudex agent, it resolves the call's path argument
(`file_path`, or `path` for Grep/Glob, defaulting to the agent's cwd) against the agent's cwd
lexically (`.`/`..` collapsed, no filesystem access) and answers `{ deny: 'claudex: <tool> outside
<cwd> refused' }` when it falls outside. It is lexical (a symlink inside the directory can
point out); the docs say so.

### Permissions and sandbox: "yolo, but sandboxed" (revised 2026-10-04)

Found live after the build: in an auto-mode session every GPT agent write was refused ("the
server-side auto mode classifier gave no verdict"), because the auto-mode classifier's verdict
rides on Anthropic's response to the request that produced the action, and a GPT step makes no
such request. Decided with the user: GPT agents run without permission prompts, confined by
claudex instead.

- **Approval.** `turn.step` records the `tool_use` id of every tool call it yields for a claudex
  agent (including the synthesized `SubagentHandback`), in a module-level set capped at the 2000
  most recent ids. A `tool.check` hook answers for exactly those ids: it calls `next(e)` first;
  only a core `ask` becomes `{ decision: 'allow', reason: 'claudex: GPT agent call, confined by
  claudex' }`; core `allow` and `deny` stand unchanged. `SubagentHandback` is never touched because
  the engine accepts only its own verdict for it. Every other check returns
  `next(e)` unchanged with no `$` call. The agents keep the session's permission mode; no
  `bypassPermissions`.
- **Files.** The path rule above.
- **Bash.** A `tool.call` hook matched to `Bash`, for a claudex agent's call, rewrites
  `command` to `'<root>/bin/claudex-worker' sandbox --cwd '<agent cwd>' -c '<original
  command>'` (POSIX single-quote escaping, built in `worker.ts`), all other fields unchanged. A
  read-mode agent's Bash call is denied (it has no Bash tool anyway). Unknown agents follow the F6
  classification; main-loop and foreign calls reach `next` unchanged, the main loop with no `$`
  call. The agent view shows the wrapper around the command; the docs say so.
- **`claudex-worker sandbox --cwd DIR -c COMMAND`** runs `bash -c COMMAND` under `bwrap`
  (`CLAUDEX_BWRAP` overrides the path, for tests): `--ro-bind / /`, `--dev /dev`, `--proc /proc`,
  `--tmpfs /tmp`, `--tmpfs $HOME`, then read-only binds of the toolchain directories that exist
  (`~/.local/bin`, `~/.local/lib`, `~/.cargo`, `~/.rustup`, `~/go`, `~/.cache`, `~/.npm`), then
  `--bind DIR DIR`, `--unshare-all` (no network), `--die-with-parent`, `--new-session`,
  `--chdir` = the caller's `$PWD` when it is inside DIR, else DIR. Exit status is the command's.
  It refuses (exit 2) a DIR that is not an absolute existing directory, or is `/` or any ancestor of
  `$HOME` (binding it would re-expose the hidden home); refuses an empty COMMAND; and fails closed (exit 126, "refusing to run unsandboxed",
  the command never runs) when `bwrap` is missing or cannot start. This is the confinement the
  headless edit workers had (writes confined to the directory, no network, `$HOME` unreadable
  except the directory and toolchains).

**Round-2 hardening** (adversarial review round 2; decisions by the user marked *):
- **No host IPC** (F1*): the sandbox also mounts an empty `--tmpfs /run` (and `/var/run` when it is
  a real directory), removing the D-Bus, compositor, docker and agent sockets. Abstract sockets
  are cut by the network namespace. Residual, documented: pathname sockets inside DIR or the
  read-only toolchain directories.
- **Symlink bridge** (F2*): before a claudex agent's Read/Write/Edit/Grep/Glob runs, after the
  lexical rule, the mod runs `claudex-worker resolve --cwd DIR PATH` (exit 0 when `realpath -m`
  of PATH lies inside `realpath -e` of DIR, exit 3 otherwise) and denies on non-zero. Glob
  patterns that are absolute or contain a `..` segment are denied. GPT agents may not use
  background Bash (`run_in_background: true` is denied), so no command runs concurrently with
  a file tool (the engine already runs Edit, Write and Bash serially).
- **Deny rules see the real command** (F3): before rewriting, the Bash hook asks
  `$.tool.check({ tool: 'Bash', input: <original input> })`; a deny ends the call.
- **Trusted launch** (F4): the rewrite is `/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin
  /bin/bash '<root>/bin/claudex-worker' sandbox --cwd '<cwd>' --path "$PATH" -c '<command>'`;
  `sandbox` finds `bwrap` only in `/usr/bin` or `/bin` (`CLAUDEX_BWRAP` for tests), and
  `--path` becomes `PATH` inside the sandbox only.
- **Spawn metadata** (F5): admission is serialized, so the in-flight spawn's tier, cwd, prompt
  and mode are held as "pending" and bound to a claudex agent the step hook discovers while the
  spawn has not returned. An agent discovered with no metadata has `cwd: null`, and every tool
  call of it is denied.
- **Fail closed on hook failure** (F6): the spawn hook, the five path-rule hooks and the Bash
  hook have `.catch` handlers that deny (pass-through for calls without an agentId); the wait for
  a previous admission is bounded at 5 s, then denied with "another GPT agent spawn is in
  progress; retry".
- F7–F10: native steps pass through outside claudex's error handler; tests touch only
  directories they own and signal only children listed by `jobs -pr`.

### What is removed

`mcp__claudex__run`, `mcp__claudex__wait`, their registration and handlers in
`plugin/hooks/tools.ts`, and the `worker` kind in ownership and delivery
(`plugin/hooks/delivery.ts`, `jobs.ts`, `types/index.d.ts`). The adversary path
(`mcp__claudex__review`, `verdict`, delivery of `adversary` jobs, the findings pane) is unchanged.
The workers pane, `/claudex` and the status line stay; the status line's running count adds the
claudex agents from `$.agent.list()`.

### Footprint rules F1 and F2, amended

- **F1 hooks** (the footprint test's expected list): `session.start`;
  `tool.call{tool=mcp__claudex__review}`, `tool.call{tool=mcp__claudex__verdict}`;
  `tool.call{tool=Read|Write|Edit|Grep|Glob}` (the path rule; pass-through for every other
  caller); `tool.call{tool=Bash}` (the sandbox rewrite); `tool.check` (approval of recorded GPT
  call ids only); `command.run{command=claudex}`; the two panes' `ui.render`; `turn.step`
  (pass-through as specified); `agent.spawn{subagentType=claudex:gpt-*}`;
  `agent.offer{agent=claudex:gpt-*}`. Still no `prompt.compose`.
- **F1 capabilities**, added: `$.agent.register`, `$.agent.list`, `$.session.messages`,
  `$.process.spawn`. Still never `$.fs`, `$.http`, `$.settings`, `$.session.append`, `$.model.*`,
  `$.env`.
- **F2** holds: every action is a `claudex-worker` argv built in `worker.ts`; policy is decided by
  the worker (`admit`, `step`), never by the mod.
- **New F8 — other loops untouched**: a step, spawn, offer or tool call that is not a claudex
  agent's reaches `next` unchanged, and the main loop's steps make no `$` call. A test enforces it.

### Verification gate (plan task 0, before any production code)

A sol worker (yolo, user-approved for spikes) extends `spikes/native-agents/` and runs it from an
environment without `CLAUDE_CODE_CHILD_SESSION` (unset explicitly), with a **native control**
(a `general-purpose` agent doing the same task) in the same interactive session:

1. `$.agent.register` accepts `model: "gpt-sol"`; the Agent row shows it; a deliberately skipped
   hook makes the step fail at the API rather than run Claude.
2. The agent panel (`↓ to manage`, open the agent) shows the GPT agent's tool rows as it shows
   the control's.
3. Text streamed through `$.process.spawn` appears live in the agent's view, compared with the
   control.
4. The spawn-prompt fix: an interactive background spawn gets its prompt.
5. A sol@high step of over 5 minutes through `$.process.spawn` completes.

Any failure stops the plan and comes back to the main session.

**Result (2026-10-03, `spikes/native-agents/FINDINGS-GATE.md`):** items 2 and 4 GO; item 1's
guard GO, its model-display check did not hold (rows show the type, as for native agents);
item 3 text appears on step completion (native control's text timing not captured); item 5 a
107 s sol@high step completed, > 5 min untested. The user decided GO with the two corrections
above.

### Tests

- **Mod** (`claude plugin test`): request builder (prompt injection, thinking splice, tool
  filtering), NDJSON→chunk translation incl. four-count usage and a complete result, handback
  step, fail-closed on worker exit/garbage/throw, pass-through for main-loop and foreign-agent
  steps with zero `$` calls (F8), admission allow/deny, registry survives reload, path rule
  (inside, outside, `..`, relative, foreign agent untouched), offer hidden when off.
- **Worker** (`tests/worker/`): `step` against a stub proxy (stream passed through, error exit 7,
  policy refusals, stdin limit), `admit` (switch, tier, parallel count).
- **Footprint** (`tests/worker/mod_footprint_test.sh`): the amended F1 lists.
- **Live** (`tests/live/native_agent.sh`, manual, not in `check`): the verification-gate script
  kept as a regression check, plus `capture_tool_schemas.sh` to refresh the schema table after a
  Claude Code update.

## Out of scope

Prebuilt binaries and release CI; the official plugin directory; native agents inside Workflow
scripts; a native adversary (it stays an external read-only worker); per-call `yolo` for agents;
`userConfig`-based settings.
