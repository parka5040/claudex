# claudex on Claude Mods — Implementation Plan (v2)

> **For agentic workers:** executed by claudex GPT workers and native Claude agents, directed
> from the main session. By the user's instruction **code is written by the agents, not the
> director**: this plan fixes files, interfaces, behaviours and test cases; you write the code.
> Steps use checkbox (`- [ ]`) syntax. **No commits**: never run `git commit`, `stash`,
> `reset`, `checkout`, `restore` or `clean`; the tree holds the user's uncommitted GPT-6 tier
> changes, which you must leave intact.

**Goal:** add a Claude Code mod to the claudex plugin: live visibility, a native worker tool
with completion wake-up, no-model-turn `/claudex` commands, and an adversary findings panel.

**Architecture:** `claudex-worker` (bash) gains a supervised job registry and JSON views and
stays the only place policy is enforced; a TypeScript hooks module in `plugin/hooks/` drives it
through `$.process.run`, gates launches on the engine's permission verdict, and draws status
line, panes and toasts.

**Tech stack:** bash + jq + flock + /proc (worker); TypeScript hooks module on the Claude Code
2.1.287 mods API (no Node, no DOM; everything via `$`); `claude plugin validate|test`;
`deno check` for types.

**Spec (read it first, it is the authority):** `docs/superpowers/specs/2026-10-01-claude-mods-design.md`
(v2). F1–F7 are acceptance criteria.

**API reference:** `.cache/mods-api/claude-code.d.ts` (authoritative: grep it for every event,
op, noun, element and the `claude-code/testing` kit), `.cache/mods-api/reference.md`,
`.cache/mods-api/examples/`, and the working probe `.cache/probe-mod/` (a test that stubs ops
beneath the plugin: every op the plugin calls must be answered with `{ value: … }` by a test
hook; `mock.clock(on).advance(ms)` drives `$.clock.every`).

## Global Constraints

- Claude Code ≥ 2.1.287; the `.d.ts` wins over any prose, including this plan's.
- Hooks module rules: ES modules, `.ts`/`.tsx` only, `import` declarations only (no
  `import()`/`require`), no Node/DOM globals, JSX factory `h`, elements only from
  `$.ui.resolve(e)`, single-width glyphs (no emoji).
- F1 hooks (exactly): `session.start`; `tool.call` on `mcp__claudex__run|wait|review|verdict`;
  `command.run` on `{ command: 'claudex' }`; `ui.render` on `{ component: 'Pane', requestId:
  'claudex-workers' }` and `{ … 'claudex-findings' }`.
- F1 calls (allow-list): `$.process.run`, `$.tool.register`, `$.tool.check`,
  `$.command.register`, `$.clock.*`, `$.state.*` (and `atom`/`read`/`update`/`derive` from
  `claude-code`), `$.store.*`, `$.session.id`, `$.prompt.submit`,
  `$.ui.status|toast|open|close|resolve|invalidate`. Nothing else.
- F2: argv built only in `plugin/hooks/worker.ts`; never a shell string; never `yolo`; every
  `$.process.run` has an explicit `timeoutMs`; launches gated by `$.tool.check`.
- F3: never read `~/.codex` or any credential.
- Render hooks never write state; writes go through `update()` in handlers/events.
- `claudex-worker` keeps `set -euo pipefail`, parses config as data, never `eval`s, stays bash.
- Do not touch `src/`, `tests/unit/`, `tests/integration/`, `tests/fuzz/`, `spikes/`, `service/`.

## File map

| File | Task |
|---|---|
| `plugin/bin/claudex-worker` (lifecycle, jobs, status --json, cancel, findings, --resume) | 1 |
| `tests/worker/jobs_test.sh` (+ wire into `Makefile` `check`) | 1 |
| `plugin/hooks/hooks.json`, `plugin/.claude-plugin/plugin.json`, `plugin/types/index.d.ts` | 2 |
| `plugin/hooks/register.ts`, `worker.ts`, `jobs.ts`, `commands.ts`, `panes.tsx` | 2 |
| `plugin/tests/harness.ts`, `plugin/tests/foundation.test.ts(x)` | 2 |
| `tests/mod/deno.json`, `tests/worker/mod_footprint_test.sh` | 2 |
| `plugin/hooks/tools.ts`, `plugin/hooks/delivery.ts`, `plugin/tests/tools.test.ts` | 3 |
| `plugin/hooks/adversary.tsx`, `plugin/tests/adversary.test.tsx` | 4 |
| skills, agents, README, PLAN.md, SPIKES.md, Makefile targets, `.gitignore` | 5 |

---

### Task 0: spikes — DONE except S1 (see spec "Spikes")

S1 (permission go/no-go): **GO** (spec Spikes table).

---

### Task 1: `claudex-worker` supervised job registry (spec C1)

**Who:** `gpt-sol`, `edit`, `--cwd` repo. Parallel with Task 2.
**Files:** Modify `plugin/bin/claudex-worker`; Create `tests/worker/jobs_test.sh`; Modify
`Makefile` (run `tests/worker/jobs_test.sh` in `check` next to `policy_test.sh`).

**Produces (Tasks 2–4 depend on these exact shapes; spec C1 has the full semantics):**

```
start TIER [--cwd D] [--effort E] [--mode read|edit|yolo] [--max-turns N] [--resume UUID] < brief
    sync preflight (switch, tier, args, cwd, non-empty brief) -> same exit codes/messages as run;
    on success prints JOB and launches the supervisor in the background
run   TIER [same options] < brief      # foreground supervisor; adopts CLAUDEX_JOB_ID if set
resume SESSION TIER [options] < brief  # alias of run --resume
jobs [--json] [--limit N] [--id JOB]...
    --json -> JSON array, newest first, default limit 20 (ignored when --id given):
    {id, tier, kind:"worker"|"adversary", model, mode, cwd, origin:"mod"|"bash", owner:str|null,
     state:"running"|"done"|"failed"|"cancelled"|"lost", started:int, elapsed_s:int,
     rc:int|null, session:str|null, has_findings:bool, findings_error:str|null}
    unknown/pruned --id -> {id, state:"missing"}
status [--json]
    {policy:{8 keys: effective}, policy_sources:{KEY:"default"|"file"|"env"},
     proxy:{up:bool, ours:bool, port:int}, token_hours_left:int|null,
     plan:{used_pct:number, limit:str, age_s:int}|null}
cancel JOB      # exit 0 "cancelled JOB"; exit 2 unless running
findings JOB    # prints findings.json, exit 0; exit 1 when absent
wait JOB [--timeout S]   # unchanged: exit = job rc when finished, 5 = still running
result JOB               # unchanged
env: CLAUDEX_JOB_ORIGIN=mod -> origin "mod" (else "bash"); CLAUDEX_JOB_OWNER=<str> -> owner
```

Job id `<epoch>-<8 lowercase hex from /dev/urandom>`; `job_dir` validation regex becomes
`^[0-9]+-[0-9a-f]{8}$` but must still accept legacy ids `^[0-9]+-[0-9]+$` for `wait`/`result`
of jobs created by the old version. Files in a job dir: `meta.json` (also `supervisor:
{pid, starttime, boot_id}`), `brief`, `child.json`, `out`, `err`, `session`, `findings.json`,
`cancelled`, `lock`, `rc` (published last, by rename). Identity rule, cancel protocol,
states, permissions, collision retry, pruning (only jobs with `rc`, older than 7 days by `rc`
mtime), findings contract and validation (≤50 items, title ≤200, mechanism/evidence/fix ≤2000,
enums, unique ids, last block wins, `findings_error` one line) and plan parsing (newest
`used_pct=<number>` line in `$STATE_DIR/proxy.log`; read the real line format in
`src/server.c:266` and `src/log.c` first; `age_s` from that line's timestamp; `-` ignored) are
exactly as in spec C1. Note the existing bug the spec fixes: today `start`'s background
subshell inherits `set -e`, so a failing `run` never writes `rc`.

- [ ] **1.1** Write `tests/worker/jobs_test.sh` in the style of `tests/worker/policy_test.sh`
  (stub `claude` via `CLAUDEX_CLAUDE_BIN`, `CLAUDEX_TEST_SKIP_PROXY=1`, isolated
  `CLAUDEX_STATE_DIR`, `check`/`contains`/`absent` helpers, summary line, non-zero exit on
  failure). Cases:
  1. `run` → exactly one job dir; `meta.json` tier/kind/model `gpt-6-sol@high`/mode/cwd/
     origin `bash`/owner null; `rc`=0; `session` = stub id; `out` ends with the
     `--- claudex-worker ---` footer and `follow up with:` line (unchanged stdout too).
  2. `CLAUDEX_JOB_ORIGIN=mod CLAUDEX_JOB_OWNER=abc` → origin `mod`, owner `abc`.
  3. `start` + `wait`: exactly one job dir; `jobs --json` shows `running` while the stub sleeps
     (`STUB_SLEEP=2`), then `done`.
  4. Failing stub (exit 1) via `start` → `rc`=1 is written, state `failed`, `wait` exits 1.
  5. `CLAUDEX_CLAUDE_BIN=/nonexistent` via `start` → `rc` written (non-zero), state `failed`.
  6. `start` with tier not enabled / `CLAUDEX=off` / empty brief / bad cwd → non-zero exit,
     same message as `run`, and **no job dir created**.
  7. `lost`: job dir with `meta.json` + `child.json` of a dead process and dead supervisor, no
     `rc` → `lost`.
  8. Cancel: running sleeping job → `cancel` exit 0; within 7 s state `cancelled`, `rc`=130,
     stub process gone. `cancel` on a done job → exit 2.
  9. Cancel safety: start a sentinel `sleep 300` (its own process group); write a job whose
     `child.json` names the sentinel's pid but a different `starttime` → `cancel` refuses
     (exit 2) and the sentinel is alive; same with wrong `boot_id`; with `pgid` 1; with
     malformed `child.json`. Kill the sentinel at the end.
  10. Cancel vs completion: stub `STUB_SLEEP=1`; call `cancel` right as it finishes, 20 times
      in a loop; every job ends with exactly one `rc` and a consistent state.
  11. `jobs --id A --id B` returns those two; `--id` of a nonexistent id → `{id, state:
      "missing"}`; default list limit 20 with 25 jobs.
  12. `status --json`: valid JSON, 8 policy keys, `policy_sources` reflects a file value and
      an env override; `plan` null with no log; numeric after appending a real-format log line;
      a `used_pct=-` line is ignored; `age_s` grows with an older timestamp.
  13. Findings (adversary stub reports): valid block → `findings.json` equals it; two blocks →
      last wins; malformed JSON, missing key, bad severity, title > 200, 51 items, duplicate ids
      → no `findings.json`, `findings_error` set, report still printed; `[]` → `[]`;
      `findings JOB` exit 0/1; `has_findings` matches.
  14. `--resume <uuid>` on `run` and on `start` reaches the stub argv as `--resume <uuid>`;
      `resume <uuid> sol` still works.
  15. Permissions: `jobs/` and job dirs mode 700; a pre-existing `jobs/` at 755 becomes 700; a
      job dir that is a symlink → the worker refuses to use it (non-zero, message).
  16. Pruning: `rc` mtime 8 days old → removed on next `run`; 1 day old → kept; no `rc` and 8
      days old → kept.
  17. Legacy id `1790909617-7892` still accepted by `wait`/`result`.
- [ ] **1.2** `bash tests/worker/jobs_test.sh` → FAIL (show it).
- [ ] **1.3** Implement; update `usage`; `VERSION="0.2.0"`.
- [ ] **1.4** `bash tests/worker/jobs_test.sh`, `bash tests/worker/policy_test.sh`,
  `bash tests/worker/proxy_test.sh` all pass (do not weaken existing expectations; if one must
  change because the spec changed that behaviour, say which and why). Report full output.

---

### Task 2: mod foundation and visibility

**Who:** `gpt-sol`, `edit`, `--cwd` repo. Parallel with Task 1 (code against Task 1's shapes;
tests stub `process.run`).
**Files:** Modify `plugin/hooks/hooks.json` (add `"modules": ["./register.ts"]`, keep the
shell hook), `plugin/.claude-plugin/plugin.json` (version `0.2.0`, `"types":
"./types/index.d.ts"`). Create `plugin/types/index.d.ts`, `plugin/hooks/register.ts`,
`plugin/hooks/worker.ts`, `plugin/hooks/jobs.ts`, `plugin/hooks/commands.ts`,
`plugin/hooks/panes.tsx`, `plugin/tests/harness.ts`, `plugin/tests/foundation.test.tsx`,
`tests/mod/deno.json`, `tests/worker/mod_footprint_test.sh`.

**Produces:**

```ts
// plugin/types/index.d.ts  (types exported at top level; state declared on PluginState)
export type ClaudexJobState = 'running'|'done'|'failed'|'cancelled'|'lost'|'missing'
export type ClaudexJob = { id: string; tier: string; kind: 'worker'|'adversary'; model: string;
  mode: string; cwd: string; origin: 'mod'|'bash'; owner: string|null; state: ClaudexJobState;
  started: number; elapsed_s: number; rc: number|null; session: string|null;
  has_findings: boolean; findings_error: string|null }
export type ClaudexStatus = { policy: Record<string,string>;
  policy_sources: Record<string,'default'|'file'|'env'>;
  proxy: { up: boolean; ours: boolean; port: number }; token_hours_left: number|null;
  plan: { used_pct: number; limit: string; age_s: number }|null }
export type ClaudexDelivery = 'pending'|'waiting'|'claimed'|'notified'|'dropped'|'delivered'
export type ClaudexOwned = { job: string; kind: 'worker'|'adversary'; review: string|null;
  delivery: ClaudexDelivery; since: number }
export type ClaudexFinding = { id: string; severity: 'critical'|'high'|'medium'|'low';
  title: string; mechanism: string; evidence: string; fix: string; unverified: boolean }
export type ClaudexVerdict = { stance: 'accepted'|'rebutted'|'unresolved'; note: string }
export type ClaudexRound = { round: number; job: string; session: string|null;
  findings: ClaudexFinding[]|null; findings_error: string|null; report: string|null;
  verdicts: Record<string,ClaudexVerdict>; decisions: Record<string,'claude'|'gpt'>; sent: string[] }
export type ClaudexReview = { id: string; cwd: string; model: string; rounds: ClaudexRound[];
  active_round: number; running: boolean }
declare module 'claude-code' { interface PluginState { claudex: {
  generation: number; on: boolean; status: ClaudexStatus|null; jobs: ClaudexJob[];
  owned: Record<string, ClaudexOwned>; reviews: Record<string, ClaudexReview>;
  selected: string|null; report: { job: string; text: string }|null; toasted: string[] } } }

// plugin/hooks/worker.ts — the only place argv is built (WORKER = $.plugin.root + '/bin/claudex-worker')
export type Run = { exitCode: number; stdout: string; stderr: string; truncated: boolean }
export class WorkerUnavailable extends Error {}        // $.process.run rejected (timeout, cannot start)
export function worker($, args: string[], init: { stdin?: string; env?: Record<string,string>; timeoutMs: number }): Promise<Run>
export function getStatus($): Promise<ClaudexStatus>                               // 15 s
export function listJobs($, o?: { limit?: number; ids?: string[] }): Promise<ClaudexJob[]>  // 15 s
export function startJob($, a: { tier: string; brief: string; owner: string; cwd?: string;
  mode?: 'read'|'edit'; effort?: string; resume?: string }): Promise<Run>          // 30 s; env ORIGIN=mod, OWNER
export function waitJob($, job: string, seconds: number): Promise<Run>             // timeoutMs (seconds+30)*1000
export function cancelJob($, job: string): Promise<Run>                            // 20 s
export function getFindings($, job: string): Promise<ClaudexFinding[]|null>        // 15 s
export function getResult($, job: string): Promise<Run>                            // 15 s
export function setKey($, key: string, value: string): Promise<Run>                // 15 s
// plugin/hooks/jobs.ts
export const S: { generation, on, status, jobs, owned, reviews, selected, report, toasted }  // atom refs, plugin 'claudex'
export function activate($): Promise<void>      // bump generation, read status, apply on/off (F4), (re)arm poller
export function poll($, gen: number): Promise<void>   // single-flight; refresh jobs list (+status every 30 s); toasts; calls hooks registered via onTick
export function onTick(fn: ($, gen: number, jobs: ClaudexJob[]) => Promise<void>): void   // Task 3 registers delivery here
export function rearm($): void                  // cancel interval; 2 s if running/undelivered else 60 s
export function statusLine(s: ClaudexStatus|null, jobs: ClaudexJob[]): string|undefined   // pure
export function stillCurrent($, gen: number): Promise<boolean>   // generation fence
// plugin/hooks/commands.ts
export const subcommands: Record<string, ($, args: string[]) => Promise<{ text: string; context?: string[] }>>
export function onEnable(fn: ($) => Promise<void>): void   // Task 3 registers tool registration here
// plugin/hooks/panes.tsx
export const WORKERS_PANE = 'claudex-workers'
// plugin/tests/harness.ts
export function harness(on, opts): Harness   // answers every op the plugin calls, in memory:
  // state.get/set (versions), store.*, tool.register, command.register, tool.check (scripted),
  // session.id (scripted, changeable), prompt.submit (recorded; can return {drop}),
  // ui.status/toast/open/close (recorded), process.run (router on argv[1] -> scripted Run or rejection),
  // clock = mock.clock(on); exposes recorded calls and current state for assertions
```

Behaviour (spec C2 "Visibility", "/claudex", F4, F6):
- `register.ts`: `session.start` → `next(e)` then `activate`; always `$.command.register({ name:
  'claudex', description: 'claudex: status, config, workers, findings', argumentHint:
  '[status|config [KEY VALUE]|workers|findings [JOB]]' })`.
- `activate`: generation +1 in state; `getStatus`; `on` = effective `CLAUDEX === 'on'`; on →
  call `onEnable` fns, arm poller, set status line; off (cold) → nothing else.
- Poller per F6: single-flight flag; generation fence after every await; `listJobs({limit:20})`
  each tick; `getStatus` every 30 s; then `onTick` fns; status line; toasts (login < 24 h once,
  plan ≥80/≥95 once each; keys in `toasted`); off with no undelivered owned jobs → stop.
- Status line exact strings: `claudex: idle · plan 34% · login 5d`, `claudex: 2 running · plan
  34% · login 5d`, `… · login 5h!` (< 24 h), `plan ?` when `age_s > 3600`, plan omitted when
  null, login omitted when null, `claudex: port taken` when `up && !ours`; `undefined` when off.
- `/claudex` subcommands: `status` (default; aligned table + last 5 jobs), `config` (key,
  effective value, source, one-line meaning copied from the README control table), `config KEY
  VALUE` (`setKey` → non-zero: text = stderr; success: re-`getStatus`; effective changed → text
  = new line, `context: ["claudex policy changed: KEY=VALUE. This overrides the session-start
  policy line for the rest of this session."]`; env-shadowed → explanatory text, no context;
  `CLAUDEX` changes → `activate`), `workers` (`$.ui.open({ id: WORKERS_PANE, title: 'claudex
  workers' })`, text `Workers pane opened.`), unknown → usage. (`findings` is added in Task 4.)
- Workers pane (spec "Visibility"): rows from `jobs`, Buttons keyed `cancel-<id>` (running →
  `cancelJob`, then poll), `report-<id>` (finished → `getResult` in the handler, store in
  `report`), `close` (`$.ui.close`). Report shown as `Markdown`, cut to the room.
- `tests/mod/deno.json`: compilerOptions per the `.d.ts` header (strict, jsx react, factory
  `h`, fragment `Fragment`), import map `claude-code` → `../../plugin/.claude-plugin/types/claude-code/index.d.ts`
  if that file exists after `claude plugin test plugin` / `validate`, else
  `../../.cache/mods-api/claude-code.d.ts`; find out which exists and say so in the report.
- `tests/worker/mod_footprint_test.sh`: runs `claude plugin validate plugin`; parses the
  `hooks:` and `calls:` lines; fails if any hook or call is outside the F1 allow-lists (subset
  check); prints `UNVERIFIED: claude not found` and exits 0 when `claude` is absent.

- [ ] **2.1** `plugin/tests/foundation.test.tsx` with the harness: `statusLine` table over all
  strings; poll interval 2 s with a running job, 60 s without (mock clock); single-flight (a
  slow `jobs` stub does not start a second poll); generation fence (status flipped off while a
  poll is in flight → the late result sets no status line); cold `CLAUDEX=off` → no status
  line, no timer, `/claudex` registered, `onEnable` not called; `/claudex config CLAUDEX off`
  then `on` → poller stops then restarts, `onEnable` called; `config KEY VALUE` argv `[WORKER,
  'set', KEY, VALUE]`, context only on effective change, shadowed text when
  `policy_sources[KEY]==='env'` and value unchanged; usage on unknown; workers pane on
  `terminal` and `desktop` lists jobs, `cancel-<id>` press → cancel argv, `report-<id>` →
  Markdown with the stub report; no argv contains `yolo`; every `process.run` has `timeoutMs`.
- [ ] **2.2** `claude plugin test plugin` → FAIL. **2.3** Implement. **2.4** `claude plugin
  validate plugin`, `claude plugin test plugin`, `bash tests/worker/mod_footprint_test.sh`,
  `deno check --config tests/mod/deno.json plugin/hooks/*.ts plugin/hooks/*.tsx plugin/tests/*`
  all pass. Report full output.

---

### Task 2 as built (read before Tasks 3–4; it overrides the Task 2 "Produces" block)

`claude plugin validate` **refuses passing `$` to a function imported from another file,
assigning `$`, and passing it to dynamic callbacks**. So Task 2 built:
- `worker.ts` exports **pure request builders** — `statusRequest(root)`, `jobsRequest(root,
  {limit?, ids?})`, `startRequest(root, {...})`, `waitRequest(root, job, s)`,
  `cancelRequest`, `findingsRequest`, `resultRequest`, `setRequest` — each returning `{ argv,
  init }` with `timeoutMs` set; the file that owns a hook runs `$.process.run(r.argv, r.init)`
  itself. (Its `$`-taking helpers are not callable from other files.)
- Every file registers its own hooks with an exported `registerX(on: On)` that `register.ts`
  calls; `$` is used only inside hooks of that file or functions in that file called from them,
  or captured in a closure set during that file's own `session.start` hook (see
  `activateLater`/`pollLater` in `jobs.ts`).
- `jobs.ts` exports atoms `S`, `onTick(fn: (gen: number, jobs: ClaudexJob[]) => Promise<void>)`,
  `onEnable(fn: () => Promise<void>)` — **no `$` parameter**: a Task 3/4 file captures its own
  `$` in its own `session.start` hook (registered after `registerJobs`, so it runs inside jobs'
  `next(e)`, before `activate` calls the enable fns) — plus `rearm`, `stillCurrent`,
  `activateCurrent()`, `pollCurrent()`. `rearm($)`/`stillCurrent($, gen)` take `$` and so
  cannot be called from another file: Task 3 may add `$`-free wrappers to `jobs.ts` in the same
  style as `pollCurrent` (e.g. `rearmCurrent()`, `currentGeneration()`); that is the only
  change Task 3 may make to `jobs.ts`.
- Tests: `plugin/tests/harness.ts` answers every op; reuse and extend it (do not fork it).

### Task 3: native tools, ownership, delivery state machine (S1 = GO)

S1 facts: a hook-served tool's input arrives flat on `e` (`e.tier`); the hook returns
`{ result: <string> }` (an object result is refused: "expected string/array/undefined") —
check `ToolCallResult` in the `.d.ts` for how to mark an error; `ask` must be treated as "do
not run" by the hook itself.

**Who:** `gpt-sol`, `edit`, `--cwd` repo. After Tasks 1, 2 and S1.
**Files:** Create `plugin/hooks/tools.ts`, `plugin/hooks/delivery.ts`,
`plugin/tests/tools.test.ts`; Modify `register.ts` (wire), `plugin/tests/harness.ts` (extend),
`plugin/hooks/jobs.ts` (only `$`-free wrappers, see above), `plugin/types/index.d.ts` only if a
field is missing (say so).

**Consumes:** Task 2 (`worker.ts`, `S`, `onTick`, `onEnable`, `rearm`, `stillCurrent`,
harness). **Produces:** `registerWorkerTools($)` (idempotent; via `onEnable`),
`own($, job, kind, review)`, `deliver($, gen, jobs)` (via `onTick`), `ingestHooks` registry
`onIngest(fn: ($, owned: ClaudexOwned, job: ClaudexJob) => Promise<string /*notification text*/>)`
for Task 4, `gate($, tool, input): Promise<{ ok: true } | { deny: string }>`.

Behaviour: spec "Tools", "Ownership and identity", "Delivery state machine", "Completion
notification text" and F2/F4/F5, exactly. Specifics:
- `gate`: `$.tool.check({ tool, input })` (input nested — verified in S1, see `.cache/probe-mod/hooks/register.ts`); `allow` → ok;
  `deny` → `{ deny: reason ?? 'denied by permission rules' }`; `ask` → `{ deny: 'claudex:
  <tool> needs permission. Add "<tool>" to permissions.allow in ~/.claude/settings.json, or
  dispatch with Bash: claudex-worker start … (that path prompts).' }`. On deny the handler
  returns `{ deny }` and calls nothing else.
- Handlers validate input themselves: tier enum, mode enum (`read|edit` only), effort enum,
  `wait_seconds`/`timeout_seconds` integers 1–540, `cwd` absolute (existence is the worker's
  check), `brief` non-empty ≤ 200 000 chars, `resume` UUID shape, `job` id shape.
- Off (state `on` false) → `run`/`review` return `isError` `claudex is off`; `wait` works.
- `run`: gate → `startJob({…, owner: await $.session.id()})` → non-zero → `isError` with
  stderr; zero → `own(job,'worker',null)` with delivery `pending`, `rearm`, text `Started job
  <id> on <tier> (<model>, <mode>). You will get a notification when it finishes;
  mcp__claudex__wait blocks for it.` With `wait`: reservation (`pending`→`waiting` via
  `update`) → `waitJob` → mapping per spec (0 → report, `delivered`; 5 → still running,
  `pending`; other → `isError` report+stderr, `delivered`; rejection → `isError`, `pending`;
  truncated → say so).
- `wait`: only owned jobs (else `isError` `not a job of this session`); same mapping.
- `deliver` (each tick, generation-fenced): for every owned job whose delivery is `pending`:
  look up by id (`listJobs({ ids })`); if terminal or `missing`: re-read `$.session.id()` —
  differs from the job's owner → toast `claudex: job <id> finished in an earlier conversation`,
  delivery `dropped`; else claim (`pending`→`claimed` via versioned `update`; lost race → skip),
  build text (`onIngest` fns for adversary; worker text per spec; `missing` → `claudex job <id>:
  result expired (pruned)`), `$.prompt.submit({ text })` → `{drop}` → `dropped` + toast with the
  reason; else `notified` + toast `claudex: <tier> job <id> <state> (<m>m<s>s)`.
- Persistence: every `owned` write mirrored to `$.store` key `claudex:v1:<session id>` as
  `{v:1, jobs:{id:{kind, review, delivery, since}}}`; at `session.start` (in `activate`, before
  arming) load it when state `owned` is empty, evict entries older than 7 days, and also adopt
  jobs from `listJobs` whose `owner` equals the session id and are not yet known (delivery
  `pending`); a rejected store write → toast once (`toasted` key `store-full`), continue.
- [ ] **3.1** `plugin/tests/tools.test.ts` (harness): gate allow/deny/ask with **zero**
  `process.run` calls on deny/ask and the exact hint text; invalid inputs rejected before any
  op; `mode: 'yolo'` rejected; off → `run` isError, `wait` works; `startJob` argv/stdin/env
  (`CLAUDEX_JOB_ORIGIN=mod`, `CLAUDEX_JOB_OWNER=<session id>`); `start` exit 4 → isError with
  stderr; wait mapping incl. `timeoutMs == (s+30)*1000`, exit 5, exit 1 with stdout+stderr,
  rejection, truncation; delivery: job already `done` at first tick → exactly one submit; wait
  returning the report → no submit; wait vs tick race (wait in flight while tick sees `done`)
  → exactly one delivery; `{drop}` → `dropped` + toast, no retry; reload (re-run `activate`
  with existing state) → no second submit; store reload after state loss → still exactly one
  submit; 25 newer bash jobs do not hide an owned job; `missing` → expired text once; session
  id changed → toast only, no submit; adoption of an owner-matching job unknown to state.
- [ ] **3.2** FAIL. **3.3** Implement. **3.4** validate, test, footprint, deno check all pass.
  Report full output.

---

### Task 4: adversary review, verdicts, findings pane, arbitration

**Who:** `gpt-sol`, `edit`, `--cwd` repo. After Task 3.
**Files:** Create `plugin/hooks/adversary.tsx`, `plugin/tests/adversary.test.tsx`; Modify
`register.ts`, `commands.ts` (add `findings`).
**Consumes:** Tasks 2–3 (`gate`, `own`, `onIngest`, `startJob`, `getFindings`, `getResult`,
`S.reviews`). **Produces:** `registerReviewTools($)` (via `onEnable`), `ingest($, owned, job)`
(via `onIngest`, idempotent), `FINDINGS_PANE = 'claudex-findings'`.

Behaviour: spec "Review aggregate and findings pane", "Tools" (`review`, `verdict`),
"Completion notification text", F7, exactly. Specifics:
- `review`: validate (`artifact` non-empty ≤ 200 000 chars, `context` ≤ 20 000, `cwd`
  absolute); gate; brief `Context:\n<context or "(none)">\n\nArtifact:\n<artifact>`;
  `startJob({ tier: 'adversary', … })`; create `reviews[job]` `{id: job, cwd, model (from
  start output or status policy), rounds: [{round: 1, job, …empty}], active_round: 1, running:
  true}`; `own(job, 'adversary', job)`; with `wait`, same reservation/mapping as `run` plus
  `ingest` before returning.
- `ingest` (idempotent per round job): `getFindings` → findings or null; `listJobs({ids})` →
  `findings_error`; null findings → `getResult` → `report`; set `session` from the job; `running:
  false`; return the notification text per spec (structured or unstructured variant).
- `verdict`: validate; unknown review → isError; `round !== active_round` → isError `stale
  round <n>; active is <m>`; unknown finding id → isError naming it; store stances; reply
  `Recorded N. Unanswered: F2, F5.` or `All findings answered.`; if any stance in the active
  round is `unresolved` and the pane is not open, `$.ui.open({ id: FINDINGS_PANE, title:
  'claudex adversary review' })` + toast `claudex: <n> findings need your decision —
  /claudex findings`.
- Pane per spec; Buttons keyed `claude-<fid>`, `gpt-<fid>` (only on `unresolved`; toggles
  `decisions[fid]`), `send` (n>0; one `$.prompt.submit` with the exact text format in the spec;
  then `sent += ids`, decisions cleared), `round` (enabled iff any rebutted/unresolved stance
  and `!running`; gate with tool `mcp__claudex__review`; brief = lines `F2 (rebutted): <note>`
  only; `startJob({ tier: 'adversary', resume: <active round session>, cwd: <review cwd>, … })`;
  push round n+1 `{job, …}`; `active_round` = n+1; `running: true`; `own(job, 'adversary',
  reviewId)`), `close` (`$.ui.close`). Unstructured active round → explanatory line +
  `Markdown` report.
- `/claudex findings [JOB]` opens the pane on that review or the newest (asked open).
- [ ] **4.1** `plugin/tests/adversary.test.tsx`: `review` gate/argv/brief; ingestion from the
  delivery path and from `wait` (both, once); notification lists every id and the verdict
  instruction; unstructured variant text and pane; `verdict` unknown id / stale round /
  unknown review → isError; unresolved → pane opened + toast once; buttons only on unresolved;
  `send` one submit with all pending, cleared after; `round` disabled while running and when
  nothing is rebutted/unresolved, argv `start adversary --resume <session> --cwd <cwd>`, brief
  only the notes, round 2 replaces the view and round-1 verdicts are rejected as stale; pane on
  `terminal` and `desktop`.
- [ ] **4.2** FAIL. **4.3** Implement. **4.4** validate (hooks now equal the F1 list exactly —
  say so), test, footprint, deno check pass. Report full output.

---

### Task 5: routing, docs, build wiring

**Who:** `gpt-terra`, `edit`, `--cwd` repo. After Task 4.
**Files:** Delete `plugin/skills/status/`, `plugin/skills/config/`. Modify
`plugin/skills/delegating-to-gpt/SKILL.md`, `plugin/skills/adversary/SKILL.md`,
`plugin/agents/gpt-{luna,terra,sol,astra,adversary}.md` (description line only), `README.md`,
`PLAN.md`, `SPIKES.md`, `Makefile`, `.gitignore`.
- [ ] **5.1** `delegating-to-gpt`: new first section "In the main session (claudex mod
  loaded)": prefer `mcp__claudex__run` / `mcp__claudex__review` (results arrive as a
  notification; do not poll; `wait` only for short jobs); answer every finding with
  `mcp__claudex__verdict` naming review and round; unresolved findings go to the user via the
  findings pane — do not settle them; a tool denied for permission → tell the user the hint,
  do not route around it unless the user says so; Bash `claudex-worker` and `claudex:gpt-*`
  agents are for Workflow scripts and when the tools are absent; `/claudex` subcommands.
  Policy and worker-facts sections unchanged.
- [ ] **5.2** `adversary` skill: dispatch via `mcp__claudex__review` when present, else the
  Bash path. Agent descriptions: append ` For Workflow scripts; in the main session prefer
  mcp__claudex__run.` (adversary: `… prefer mcp__claudex__review.`).
- [ ] **5.3** README "Claude Mods" section: what status line/panes/toasts show; `/claudex`
  subcommands; the four tools and the permission gate (add the four `mcp__claudex__*` names to
  permissions.allow to use them without denial; plan mode and deny rules are honoured);
  Claude Code ≥ 2.1.287; fallback `! claudex-worker status|config|set`; footprint F1–F7 in one
  paragraph; plan usage unknown under systemd. Replace `/claudex:config`/`/claudex:status`
  mentions. PLAN.md: append F1–F7 to "Main-session invariants"; add the mod to Components.
  SPIKES.md: S1–S5 results from the spec's Spikes table.
- [ ] **5.4** Makefile: `plugin-check` target = `claude plugin validate plugin`, `claude plugin
  test plugin`, `bash tests/worker/mod_footprint_test.sh`, `deno check --config
  tests/mod/deno.json …`; each missing tool prints `UNVERIFIED: plugin checks skipped (<tool>
  not found)` and continues; add to `check`. Install note lists the four tool names beside the
  Bash rule. `.gitignore`: `plugin/.claude-plugin/types/`.
- [ ] **5.5** `make check` passes. Report full output.

---

### Task 6: verification and adversarial review of the diff

- [ ] **6.1** Native Claude agent, independent of implementers: `make check`, `claude plugin
  validate plugin` (hooks/calls vs F1), `claude plugin test plugin`; raw output + exit codes;
  confirm no `UNVERIFIED` skip line.
- [ ] **6.2** `gpt-adversary` on the full diff + new files against the spec. Director answers
  every finding; unresolved → user.
- [ ] **6.3** Fixes by `gpt-sol`; repeat 6.1.
- [ ] **6.4** Director reads the final diff; user does the manual checks (S3, real terminal,
  one real `run` and one real `review`, the permission allow rules).
