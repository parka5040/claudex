# claudex: one-command install, native GPT agents, model lineup — Implementation Plan

> **For agentic workers:** executed by claudex GPT workers and native Claude agents, directed
> from the main session. By the user's instruction **code is written by the agents, not the
> director**: this plan fixes files, interfaces, behaviours and test cases; you write the code.
> Steps use checkbox (`- [ ]`) syntax. **No commits**: never run `git commit`, `stash`,
> `reset`, `checkout`, `restore` or `clean`; the tree holds the user's uncommitted work, which
> you must leave intact. Edit only the files your task names.

**Goal:** a `curl | bash` install; GPT workers that are real Claude Code subagents
(`claudex:gpt-luna|sol|astra`) whose model steps a mod serves from GPT; tiers that follow the
newest model of each family, with terra retired.

**Architecture:** `install.sh` gains a bootstrap mode. The proxy discovers the backend's model
list and resolves family aliases (`gpt-sol`) itself. `claudex-worker` gains `step` (one streamed
request through the proxy) and `admit` (spawn policy). The mod registers agent types, admits
spawns, answers those agents' `turn.step` events by streaming `claudex-worker step`, and confines
their file tools; `mcp__claudex__run|wait` go away.

**Tech stack:** C11 + libcurl + yyjson + pthreads (proxy); bash + jq + curl (worker,
installer); TypeScript hooks module on the Claude Code 2.1.288 mods API; `claude plugin
validate|test`; `deno check`.

**Spec (the authority; read it first):**
`docs/superpowers/specs/2026-10-03-publish-agents-lineup-design.md`. Spike evidence:
`SPIKES.md` "Native-agent spikes (2026-10-03)", `spikes/native-agents/FINDINGS-A.md`,
`FINDINGS-BC.md`, and the working spike mods `spikes/native-agents/mod-a/`, `mod-b/`.

**API reference:** `.cache/mods-api/claude-code.d.ts` (2.1.288; authoritative — grep it for
every event, op and type), `.cache/mods-api/reference.md`, `.cache/mods-api/examples/`, and the
existing mod in `plugin/hooks/` with its tests in `plugin/tests/` (house style, test harness).

## Global Constraints

- Claude Code ≥ 2.1.288; the `.d.ts` wins over any prose, including this plan's.
- Hooks module rules: ES modules, `.ts`/`.tsx`, `import` declarations only, no Node/DOM
  globals, JSX factory `h`, elements only from `$.ui.resolve(e)`, single-width glyphs.
- F1 hooks (exactly, after Task 5): `session.start`; `tool.call` on
  `mcp__claudex__review|verdict`; `tool.call` on `Read|Write|Edit|Grep|Glob` (path rule);
  `command.run{command=claudex}`; `ui.render` on panes `claudex-workers`, `claudex-findings`;
  `turn.step`; `agent.spawn` on `claudex:gpt-*`; `agent.offer` on `claudex:gpt-*`.
- F1 calls (allow-list): `$.process.run`, `$.process.spawn`, `$.tool.register`, `$.tool.check`,
  `$.tool.list`, `$.command.register`, `$.clock.*`, `$.state.*` (and `atom`/`read`/`update`/
  `derive`), `$.store.*`, `$.session.id`, `$.session.messages`, `$.prompt.submit`,
  `$.agent.register`, `$.agent.list`, `$.ui.status|toast|open|close|resolve|invalidate`.
  Never `$.fs`, `$.http`, `$.settings`, `$.session.append`, `$.model.*`, `$.env`.
- F2: every argv is built in `plugin/hooks/worker.ts`; never a shell string; never `yolo`;
  every `$.process.run` has an explicit `timeoutMs`; policy is decided by `claudex-worker`.
- F3: never read `~/.codex` or any credential (the proxy and the installer's warnings excepted).
- F8: a step, spawn, offer or tool call that is not a claudex agent's reaches `next` unchanged;
  a main-loop `turn.step` makes no `$` call.
- Tiers: `luna`, `sol`, `astra`; `terra` accepted everywhere as input and meaning sol.
- `claudex-worker` keeps `set -euo pipefail`, parses config as data, never `eval`s, stays bash.
- C: `-std=c11 -Wall -Wextra -Werror` as the Makefile sets; no new library dependencies.
- No step of any task may weaken an existing test's expectation unless the spec changed that
  behaviour; say which test and why.

## File map

| File | Task |
|---|---|
| `spikes/native-agents/gate/**`, `spikes/native-agents/FINDINGS-GATE.md` | 0 |
| `install.sh`, `tests/install/bootstrap_test.sh`, `Makefile` (`install-test`, `check`) | 1 |
| `src/models.{c,h}`, `src/upstream.{c,h}`, `src/server.c`, `src/main.c`, `src/translate_req.c` | 2 |
| `tests/unit/models_test.c`, `tests/unit/translate_req_test.c`, `tests/fuzz/models_fuzz.c` + seeds, `tests/fixtures/models-*.json` | 2 |
| `plugin/bin/claudex-worker` (tier maps, defaults, validation, status, proxy start env) | 2 |
| `tests/worker/policy_test.sh`, `tests/worker/proxy_test.sh` (lineup cases) | 2 |
| `plugin/bin/claudex-worker` (`step`, `admit`), `tests/worker/step_test.sh` | 3 |
| `plugin/hooks/{agents,confine,prompts}.ts`, `worker.ts`, `register.ts`, `jobs.ts`, `delivery.ts`, `tools.ts` (removed), `plugin/types/index.d.ts` | 4 |
| `plugin/tests/agents.test.ts`, `plugin/tests/confine.test.ts`, existing tests touching run/wait | 4 |
| `plugin/hooks/{step,tool-schemas}.ts`, `plugin/tests/step.test.ts`, `tests/live/capture_tool_schemas.sh` | 5 |
| `tests/worker/mod_footprint_test.sh` | 5 |
| `plugin/agents/*`, skills, `README.md`, `PLAN.md`, `plugin/.claude-plugin/plugin.json`, `Makefile` (`step_test`), `tests/live/native_agent.sh` | 6 |

Order: **0 ∥ 1 ∥ 2**; then **3** (after 2); **4** after 0 = GO and 3; **5** after 4; **6** after
1 and 5; **7** last.

---

### Task 0: verification gate (spec C3 "Verification gate")

**Who:** `gpt-sol`, **`yolo`** (user-approved for spikes), `--cwd` repo. Writes only
`spikes/native-agents/gate/` and `spikes/native-agents/FINDINGS-GATE.md`.
**Environment:** every nested `claude` runs with `env -u CLAUDE_CODE_CHILD_SESSION
CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` on top of the worker's own environment (claudex config
dir, proxy base URL); models only `gpt-6-luna`/`gpt-luna` for the parent and control; one
sol@high step for item 5. Interactive runs through a 200x50 PTY rendered with `pyte` (venv
outside the repo, as `spikes/native-agents/run-bc.sh ui-b` does).

Gate mod `gate/mod/` = `mod-a` adapted: agent type `gate:gpt` registered with
`model: "gpt-sol"`; steps served by spawning
`bash gate/step.sh` through `$.process.spawn` with the request as `input` (the script POSTs to
`http://127.0.0.1:18765/v1/messages` with `curl -N` and prints each SSE `data:` line — a stand-in
for `claudex-worker step`); stop usage with all four counts; a complete `TurnStepResult`;
`SubagentHandback` synthesized after `end_turn` (as `mod-b` does); spawn prompt captured in an
`agent.spawn` hook and prepended when missing from the first user message.

- [ ] **0.1** Item 1: registration with `model: "gpt-sol"` succeeds (or the exact refusal);
  the Agent row / agent list shows which model; with the hook deliberately disabled for one
  run (env switch), the agent's step fails at the API (record the message) and no Claude reply
  appears in its transcript.
- [ ] **0.2** Item 2: one interactive session, parent prompt makes the main model start, in
  the background, `gate:gpt` and a `general-purpose` control with the same small task (read a
  file, run `pwd`, edit the file, report) in separate temp dirs. Open the agent panel (`↓`),
  select each agent, capture its view several times while running and after. Answer: does the
  GPT agent's view show tool rows the way the control's does? Save `gate/captures/panel-*.txt`.
- [ ] **0.3** Item 3: in the same captures, does assistant text stream live in either view?
  Compare GPT vs control.
- [ ] **0.4** Item 4: the interactive background spawn's first user message (log it from the
  hook) contains the spawn prompt after the fix.
- [ ] **0.5** Item 5: a `gate:gpt` step on `gpt-sol@high` with a prompt that needs long
  reasoning (target > 5 min; record the real duration) completes through `$.process.spawn`.
- [ ] **0.6** `FINDINGS-GATE.md`: table item → GO / NO-GO / UNVERIFIED with evidence paths;
  final line `GATE: GO` only if items 1–4 are GO and item 5 is GO or its only failure is a
  duration short of 5 min with the step completing. Report it.

**Director:** read the captures yourself before declaring GO; any NO-GO returns to the user.

---

### Task 1: one-command install (spec C1)

**Who:** `gpt-sol`, `edit`, `--cwd` repo. Parallel with Tasks 0 and 2.
**Files:** Modify `install.sh`; Create `tests/install/bootstrap_test.sh`; Modify `Makefile`
(new phony `install-test: ; bash tests/install/bootstrap_test.sh`, add it to `check`). Do not
touch README (Task 6).

**Produces:** the behaviour of spec C1 exactly: modes, ref resolution, download, version warning,
`</dev/null` for every child, `main "$@"` last line, test overrides `CLAUDEX_GITHUB`,
`CLAUDEX_GITHUB_API`, `CLAUDEX_REPO`, `CLAUDEX_REF`, option `--ref REF`. The closing message's
permission list becomes `Bash(claudex-worker *)`, `mcp__claudex__review`,
`mcp__claudex__verdict` (in `install.sh` and in the Makefile `install` target's echo).

- [ ] **1.1** Write `tests/install/bootstrap_test.sh` in the style of
  `tests/worker/policy_test.sh` (`check`/`contains` helpers, summary, non-zero on failure,
  everything under one `mktemp -d`, server killed by trap). Fixture: a tree `claudex-v9.9.9/`
  with `Makefile` (empty), `plugin/.claude-plugin/plugin.json` (`"version": "9.9.9"`) and a stub
  `install.sh` that appends `args=<"$*"> cwd=<PWD> stdin=<devnull|other>` to `$STUB_LOG`
  (test `[[ /dev/stdin -ef /dev/null ]]`); tar it as `v9.9.9.tar.gz`, `main.tar.gz`,
  `v1.0.0.tar.gz` (same tree) under `x/y/archive/`; `repos/x/y/releases/latest` JSON
  `{"tag_name":"v9.9.9"}`; `python3 -m http.server --bind 127.0.0.1 0` (read the port from its
  output) with request logging to a file. Cases — the six of spec C1 "Tests", plus:
  7. local mode untouched: running the repo's own `install.sh --help` from the checkout prints
     usage and exits 0 without network (no request in the server log).
  8. `--ref` with no value → usage error, exit 2.
- [ ] **1.2** Run it → FAIL (show it).
- [ ] **1.3** Implement in `install.sh`. Restructure the existing body into functions
  (`install_local`, `uninstall_local`, `prereqs`, …) without changing local-mode behaviour;
  `bootstrap` is new; `main` dispatches. Keep `set -euo pipefail`.
- [ ] **1.4** `bash tests/install/bootstrap_test.sh` passes; `bash -n install.sh`; run
  `shellcheck install.sh tests/install/bootstrap_test.sh` if installed (report if not). Report
  full output.

---

### Task 2: model lineup (spec C2)

**Who:** `gpt-sol`, `edit`, `--cwd` repo. Parallel with Tasks 0 and 1.
**Files:** `src/models.{c,h}`, `src/upstream.{c,h}`, `src/server.c`, `src/main.c`,
`src/translate_req.c`; `tests/unit/models_test.c`, `tests/unit/translate_req_test.c`;
Create `tests/fuzz/models_fuzz.c`, `tests/fuzz/seeds/models_fuzz/*.json`,
`tests/fixtures/models-2026-10-03.json` (the real list's shape with the ten slugs seen in spike
C; non-secret fields only: `slug`, `display_name`, `priority`, `visibility`,
`supported_in_api`); `plugin/bin/claudex-worker`; `tests/worker/policy_test.sh`,
`tests/worker/proxy_test.sh`. Read `spikes/native-agents/FINDINGS-BC.md` section C and
`captures/b-c-summary.txt` for the list's shape (never copy identity fields).

**Produces (Task 3 and later rely on these):**

```c
/* models.h */
#define MODEL_SLUG_MAX 64
typedef struct {
    char        slug[MODEL_SLUG_MAX]; /* resolved upstream id, copied under the catalog lock */
    const char *effort;               /* static storage */
    int         remapped;             /* 1 if a non-GPT name was mapped to the background family */
} model_sel_t;
int  model_resolve(const char *requested, const char *body_effort, model_sel_t *out); /* same codes */
int  models_catalog_load(const char *json, size_t len); /* 0 = installed; -1 = rejected, catalog unchanged */
void models_mark_rejected(const char *slug);            /* until the next successful load */
typedef struct { char family[4][MODEL_SLUG_MAX]; int current[4]; int from_backend; long loaded_at; } models_view_t;
void models_view(models_view_t *out);                   /* families in order luna, sol, astra, terra */
size_t models_list(char out[][MODEL_SLUG_MAX], size_t cap); /* current families' slugs, for /v1/models and errors */
```

`model_slugs()` is removed (callers use `models_list`). Catalog: immutable struct swapped under
a `pthread_mutex_t`; `model_resolve` copies the slug while holding it. Fallback table: luna
`gpt-6-luna`, sol `gpt-6.1-sol`, astra `gpt-6-astra`, terra deprecated. Resolution, aliases,
efforts, rejected-model handling: spec C2 exactly. Effort table per family (luna low/no ultra,
sol high, astra xhigh); terra uses sol's.

Upstream: `int upstream_fetch_models(char **json, size_t *len)` (GET with the same honest headers
as `upstream_post`, `client_version` from `CLAUDEX_CODEX_VERSION` or `0.160.0`, 30 s timeout).
A detached refresher thread started in `main.c` after the sandbox is up: load at start, then
every 6 h; `models_mark_rejected` signals it (condition variable) for an early refresh no sooner
than 60 s after the last one. When `upstream_post` gets HTTP 400 whose error text contains
`not supported`, the server calls `models_mark_rejected(slug)` before returning the error.
`/healthz` gains `"models":{"luna":…,"sol":…,"astra":…,"terra":…,"source":"backend"|"fallback","fetched_age_s":N}`
(terra's value is what it resolves to); `/v1/models` lists `models_list`.

Worker: `tier_slug` → family aliases (`luna`→`gpt-luna`, `sol`→`gpt-sol`, `astra`→`gpt-astra`,
`terra`→`gpt-sol`); `--model gpt-<family>[@effort]`; defaults `CLAUDEX_TIERS=luna,sol,astra`,
`CLAUDEX_DEFAULT_WORKER=sol`, `CLAUDEX_ADVERSARY_MODEL=gpt-astra@xhigh`; validation regexes
accept `terra` (tiers) and, for the adversary model, `gpt-(luna|sol|astra|terra)` or
`gpt-[0-9]+(\.[0-9]+)?-(luna|sol|astra|terra)`, optional `@effort`; a tier list naming terra
behaves as naming sol (deduplicated); `status` prints `models: luna=… sol=… astra=… (backend|fallback)`
from `/healthz` when the proxy is up and `terra is deprecated (served by sol)` once when any
effective setting names terra; `status --json` gains `models` (the `/healthz` object or null) and
`deprecations` (array of strings). The proxy is started (in `ensure_proxy` and `proxy-exec`) with
`CLAUDEX_CODEX_VERSION` = the version `codex --version` prints, when `codex` exists.

- [ ] **2.1** Tests first. `models_test.c`: the spec C2 fixture cases (today's list →
  luna `gpt-6-luna`, sol `gpt-6.1-sol`, astra `gpt-6-astra`, terra → sol; plus `gpt-6.1-luna`
  → luna moves; `gpt-7-sol` only → luna and astra deprecated → sol `gpt-7-sol`; empty list,
  malformed JSON, all rows hidden or `supported_in_api:false` → `-1` and the previous catalog
  stays); aliases and every listed slug resolve per the table; `@effort` parsing and the luna
  `ultra`→`max` clamp; non-`gpt-` names → luna, `remapped=1`; unknown family → `MODEL_E_UNKNOWN`;
  `models_mark_rejected("gpt-6.1-sol")` → sol resolves to `gpt-6-sol`, a new load clears it.
  `translate_req_test.c`: the request's upstream model is the resolved slug; the unknown-model
  error lists `models_list`. `models_fuzz.c` (`LLVMFuzzerTestOneInput` →
  `models_catalog_load`) with two seeds. Worker tests: defaults; `CLAUDEX_TIERS=luna,terra` →
  start of `terra` launches `--model gpt-sol@high` (stub argv); `set CLAUDEX_DEFAULT_WORKER
  terra` accepted; adversary model validation accepts/rejects per the regexes; status
  deprecation line; proxy start env carries `CLAUDEX_CODEX_VERSION` when a stub `codex` prints
  `codex-cli 0.161.0`.
- [ ] **2.2** `make test` and `bash tests/worker/policy_test.sh` → FAIL (show).
- [ ] **2.3** Implement.
- [ ] **2.4** `make check` (or, if `claude`/`deno` are unavailable in the worker, `make test
  integration worker-test` and say so); `make fuzz FUZZ_SECONDS=20` for `models_fuzz` if clang
  with libFuzzer exists. Report full output.

---

### Task 3: `claudex-worker step` and `admit` (spec C3)

**Who:** `gpt-sol`, `edit`, `--cwd` repo. After Task 2.
**Files:** `plugin/bin/claudex-worker` (new subcommands, usage text); Create
`tests/worker/step_test.sh` (stub proxy: a tiny `python3 -m http.server`-style script under
the test's temp dir serving `/healthz` like the real proxy and `/v1/messages` from a fixture SSE
file; follow how `tests/worker/proxy_test.sh` fakes the proxy and its identity).

**Produces (Tasks 4–5 rely on these exactly):**

```
claudex-worker step TIER [--effort E] < request.json
    TIER luna|sol|astra|terra(=sol). Same policy checks, messages and exit codes as `start`
    (switch off, tier disabled). ensure_proxy; token preflight. Reads stdin (max 32 MiB,
    else exit 2 "request too large"); must be a JSON object (else exit 2). Sets
    .model = "gpt-<family>[@E]" and .stream = true (jq). POSTs to /v1/messages with curl -N.
    stdout: each SSE `data:` payload, one JSON object per line, in arrival order, flushed per
    line. HTTP status >= 400: the response body on stderr, exit 7. Curl failure: exit 7 with
    curl's message. Exit 0 after the stream ends.
claudex-worker admit TIER --running N
    Same policy checks/codes as `start` for switch and tier; then if N + (running jobs) >=
    CLAUDEX_MAX_PARALLEL: exit 4 "claudex: N GPT agents/workers already running
    (CLAUDEX_MAX_PARALLEL=M)". N must be a non-negative integer (else exit 2). Exit 0 otherwise.
    No output on success.
```

(Use the existing exit code for "max parallel reached" if `start` already has one; then the
plan's `4` is replaced by it — say so in the report.)

- [ ] **3.1** Tests first: `step` streams three `data:` lines from the fixture as three NDJSON
  lines; request reaches the stub with `model` = `gpt-sol` (no effort) / `gpt-sol@xhigh`
  (`--effort xhigh`) / `gpt-sol` for tier `terra`, `stream:true`, the rest unchanged; switch off →
  `start`'s code and message, no request sent; disabled tier → same; 400 from the stub → exit 7,
  body on stderr; empty stdin / non-object / > 32 MiB → exit 2; `admit` with `--running 3` and
  max 4 → 4 (code per note); `--running 0` → 0; `--running x` → 2; switch off → `start`'s code.
- [ ] **3.2** Run → FAIL. **3.3** Implement. **3.4** `bash tests/worker/step_test.sh` and the
  other three worker test files pass. Report full output.

---

### Task 4: mod — agent types, admission, registry, path rule; remove run/wait (spec C3)

**Who:** `gpt-sol`, `edit`, `--cwd` repo. After Task 0 = GO and Task 3.
**Files:** Create `plugin/hooks/agents.ts`, `plugin/hooks/confine.ts`, `plugin/hooks/prompts.ts`;
Modify `plugin/hooks/worker.ts`, `register.ts`, `jobs.ts`, `delivery.ts`, `commands.ts` (status
text only if it names run/wait), `plugin/types/index.d.ts`; Delete `plugin/hooks/tools.ts`;
Create `plugin/tests/agents.test.ts`, `plugin/tests/confine.test.ts`; Modify every existing test
under `plugin/tests/` that exercises `mcp__claudex__run|wait` or the `worker` delivery kind
(delete those cases; keep every adversary case).

**Produces (Task 5 relies on these exactly):**

```ts
// prompts.ts — WRITE_CONTRACT and READ_CONTRACT, verbatim from claudex-worker
export const WRITE_PROMPT: string; export const READ_PROMPT: string
// worker.ts
export const admitRequest: (root: string, tier: Tier, running: number) => Request // timeoutMs 15_000
export const stepArgv: (root: string, tier: Tier) => string[]   // [root/bin/claudex-worker, 'step', tier]
// agents.ts
export type Tier = 'luna' | 'sol' | 'astra'
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
export type ClaudexAgent = {
  tier: Tier; cwd: string; prompt: string | null; mode: 'read' | 'edit'; model: string
  final: string | null                       // set when a step ended with end_turn; cleared by the handback
  thinking: Record<string, ThinkingBlock[]>  // keyed by the step's first tool_use id
}
export const AGENT_PREFIX = 'claudex:gpt-'
export function tierOf(type: string): Tier | null      // 'claudex:gpt-sol' -> 'sol'
export function agentFor(agentId: string): ClaudexAgent | undefined          // live copy, sync
export function lookupAgent($: EngineInterface, agentId: string): Promise<ClaudexAgent | null> // registry, else one $.agent.list() lookup, cached (negative too)
export function changeAgent(agentId: string, fn: (a: ClaudexAgent) => ClaudexAgent | null): void // null deletes; publishes to $.state claudex.agents
export function systemPrompt(agent: ClaudexAgent): string  // WRITE_PROMPT or READ_PROMPT
export function toolsFor(mode: 'read' | 'edit'): string[]  // read: Read,Grep,Glob; edit: + Edit,Write,Bash
export function registerAgents(on: On): void
// confine.ts
export function insideCwd(cwd: string, path: string): boolean  // lexical; relative paths join cwd
export function registerConfinement(on: On): void
```

Behaviour (spec C3 "Agent types", "Spawn admission", "File-path rule", "What is removed"):
registration of the enabled tiers through `onEnable` (the `jobs.ts` hook point) and again when
`CLAUDEX_WORKER_MODE` or `CLAUDEX_TIERS` change; `agent.offer` answers `{ isOffered: false }`
while off or the tier is disabled (read `live.status.policy`); `agent.spawn` counts running
`claudex:gpt-*` agents, runs `admitRequest`, denies with the worker's stderr on non-zero, else
`next(e)` and records the registry entry with `cwd: e.cwd ?? <session cwd>`, `prompt: e.prompt`,
`mode` from policy, `model: 'gpt-<tier>'`; the poller's tick drops entries whose agent is no
longer running in `$.agent.list()`; the status line's running count adds running claudex
agents. State contract: `claudex.agents: Record<string, ClaudexAgent>`.

- [ ] **4.1** Tests first (`claude plugin test`, harness style of `plugin/tests/harness.ts`):
  registration specs per mode (tools, model, prompt) and only for enabled tiers; offer hidden
  when off / tier disabled, shown when on; spawn denied with the worker's message (stub
  `process.run` exit 4 + stderr), admitted → `next` called once, entry recorded with cwd
  fallback; foreign `subagentType` → `next(e)` unchanged and no `process.run` (F8); entry
  survives a module reload (state); tick drops a finished agent; `insideCwd` table
  (`/r/a` in `/r` true, `/r/../x` false, `/r2` false for `/r`, `a/b` true, `../x` false, `/r`
  itself true); path rule denies outside for each of Read/Write/Edit (`file_path`) and
  Grep/Glob (`path`, absent = cwd → allowed); non-claudex agent and main-loop calls reach `next`
  unchanged with no `$` call; run/wait tools are no longer registered.
- [ ] **4.2** Run → FAIL. **4.3** Implement. **4.4** `claude plugin validate plugin`,
  `claude plugin test plugin`, and the `deno check` command from the Makefile's `plugin-check`
  pass (if the rollout switch is off in the worker, run them with the claudex config dir as
  `SPIKES.md` notes, and report). Report full output.

---

### Task 5: mod — the step pipeline (spec C3 "Steps")

**Who:** `gpt-sol`, `edit`, `--cwd` repo. After Task 4.
**Files:** Create `plugin/hooks/step.ts`, `plugin/hooks/tool-schemas.ts` (generated: a
`export const TOOL_SCHEMAS: Record<string, { name: string; description: string; input_schema:
unknown }>` from `spikes/native-agents/tool-schemas-2.1.288.json`, with a header comment naming
the source and Claude Code version), `plugin/tests/step.test.ts`,
`tests/live/capture_tool_schemas.sh` (adapted from `spikes/native-agents/run-a.sh capture`:
prints the JSON for the six tools from a throwaway `claude -p` pointed at a local capture
server); Modify `plugin/hooks/register.ts`, `tests/worker/mod_footprint_test.sh` (amended F1
lists from the Global Constraints).

**Produces:**

```ts
export function buildRequest(agent: ClaudexAgent, messages: ApiMessage[], available: string[]): object
  // { system, messages (prompt injected, thinking spliced), tools, max_tokens: 32000, stream: true }
export type StepState = { /* per-step accumulator */ }
export function translate(line: string, s: StepState): TurnStepChunk[]
  // one NDJSON line from `claudex-worker step` -> chunks; updates s (answer, toolUses, stop, usage, thinking)
export function registerSteps(on: On): void
```

Behaviour: spec C3 "Steps" exactly — pass-through first (no `$` before deciding when
`e.agentId` is absent; `agentFor` sync check, then `lookupAgent` only for unknown ids);
`$.process.spawn({ argv: stepArgv(...), input: JSON.stringify(request) })`; line-buffer stdout
pieces (a line may span pieces); `content_block_start` text/tool_use/thinking,
`content_block_delta` `text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta`,
`message_delta` (stop_reason, usage), `message_stop`; usage → all four counts (missing = 0);
yield `stop` once; return a complete `TurnStepResult`; on `end_turn` store `final` via
`changeAgent`; kept thinking keyed by the first tool_use id; a step for an agent whose `final`
is set yields the `SubagentHandback` tool call with `{ message: final }`, `stop` `tool_use` with
null usage, a result, and clears `final`; fail-closed per spec (non-zero exit with stderr,
malformed line, spawn throw, anything) → `claudex: <reason>` text, `stop` `end_turn` null usage,
result, and `final` set to that text so the next step hands it back.

- [ ] **5.1** Tests first: `buildRequest` (prompt prepended only when absent; thinking re-inserted
  before the matching assistant message's content and only there; tools filtered by mode and by
  `available`; no `model` field); `translate` over a recorded proxy SSE fixture
  (`tests/fixtures/` has some; add one with thinking + two tool calls + usage) → exact chunk
  sequence and result; split-line pieces; hook with a stubbed `process.spawn` stream: text-only
  step → chunks, `final` stored; next step → handback chunks with the text, no spawn; tool step →
  `tool`+`input` chunks, thinking kept; worker exit 7 with stderr → fail-closed chunks; garbage
  line → fail-closed; main-loop step and foreign agent step → `next` result passed through
  unchanged, zero `$` calls on main loop (F8); usage always has four numeric counts. Footprint
  test updated and passing.
- [ ] **5.2** Run → FAIL. **5.3** Implement. **5.4** Same checks as 4.4 plus
  `bash tests/worker/mod_footprint_test.sh`. Report full output.

---

### Task 6: relays, skills, docs, wiring

**Who:** `gpt-sol`, `edit`, `--cwd` repo. After Tasks 1 and 5.
**Files:** Rename `plugin/agents/gpt-{luna,sol,astra,adversary}.md` → `relay-*.md` (`name:`
updated; description: "… For Workflow scripts and sessions where Claude Mods are off; in the main
session use claudex:gpt-<tier> (or mcp__claudex__review for the adversary)."; body: tier names
only); Delete `plugin/agents/gpt-terra.md`; Modify `plugin/skills/delegating-to-gpt/SKILL.md`,
`plugin/skills/delegate/SKILL.md` (tiers), `plugin/skills/adversary/SKILL.md` (relay name),
`plugin/skills/status/SKILL.md`, `plugin/skills/config/SKILL.md` (tier lists), `README.md`,
`PLAN.md`, `plugin/.claude-plugin/plugin.json` (`"version": "0.3.0"`), `Makefile` (run
`tests/worker/step_test.sh` in `worker-test`), `tests/skills/*` scenarios that name terra or the
removed tools; Create `tests/live/native_agent.sh` (the Task 0 gate driver turned into a manual
regression check against the real `claudex:gpt-luna`; header says manual, not in `check`).

- [ ] **6.1** `delegating-to-gpt`: main session dispatches with the **Agent tool**,
  `subagent_type: "claudex:gpt-<tier>"`, background by default, results arrive as the Agent
  tool's notification; tiers table luna/sol/astra (terra deprecated → sol); the facts section
  rewritten for native agents (they run with the session's permissions and sandbox; file tools
  confined to the agent's directory by the mod; Bash governed by the session; usage counts against
  the ChatGPT plan; a report is still a claim); adversary flow unchanged; Bash/relay path for
  Workflow scripts and Mods-off sessions.
- [ ] **6.2** README: Install leads with the one-liner (C1), then checkout install; "Releasing"
  under "Build and test"; model section per C2 (families, discovery, fallback, terra
  deprecation); Claude Mods section: native agents replace run/wait, what the agent panel shows,
  the path rule's limits, F1–F8 paragraph updated; config table defaults updated. PLAN.md: F8 in
  "Main-session invariants", components updated.
- [ ] **6.3** `make check` passes. Report full output.

---

### Task 7: verification, adversarial review, live check

- [ ] **7.1** Native Claude agent, independent of the implementers: `make check`,
  `claude plugin validate plugin`, `claude plugin test plugin`; raw output and exit codes;
  confirm no `UNVERIFIED` skip line (else rerun under the claudex config dir).
- [ ] **7.2** `mcp__claudex__review` (astra) on the full diff plus new files against the spec.
  Director answers every finding with `mcp__claudex__verdict`; unresolved → user.
- [ ] **7.3** Fixes by `gpt-sol`; repeat 7.1.
- [ ] **7.4** Director: read the final diff; run `tests/live/native_agent.sh` once; reload the
  mod in this session and dispatch one real `claudex:gpt-luna` agent; check the agent panel.
  User: one piped install from a pushed branch (`--ref`) when the repo is published.
