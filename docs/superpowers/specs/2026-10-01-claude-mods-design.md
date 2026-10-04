# claudex on Claude Mods — design (v2)

Date: 2026-10-01. Status: approved for implementation ("Run it"); v2 answers the adversarial
review of v1 (job `1790909617-7892`, gpt-6-astra@xhigh; see "Review log" at the end) and
records spikes S2/S4/S5.
Requires Claude Code ≥ 2.1.287 (function hooks / Mods, early access).

## Goal

Use Claude Mods (in-process function hooks) to give claudex four things a shell-hook + skills
plugin cannot have:

1. **Live visibility** — status line, a workers pane, toasts.
2. **Native worker tool** — the main session calls `mcp__claudex__run` instead of Bash or a
   Sonnet courier agent.
3. **No-model-turn commands** — `/claudex status|config|workers|findings` answered by the mod;
   no model turn runs (their output is a normal command row the model can read later).
4. **Adversary panel** — structured findings, the director's stance on each, the user's
   arbitration of unresolved ones with buttons, fed back to the director.

Decisions made with the user (2026-10-01):

| Question | Choice |
|---|---|
| Scope | all four, one spec |
| Courier agents `claudex:gpt-*` | **kept for Workflow scripts only**; the main session uses the tool |
| Tool run mode | **background + wake-up**: returns a job id; on completion the mod submits a notification prompt; `wait: true` blocks for short jobs |
| Who builds it | design in the main session; code, tests and adversarial review by agents |

## Footprint rules (acceptance criteria; appended to PLAN.md's invariants)

A mod runs *inside* the main session, so it is held to explicit rules:

- **F1 — hooks only its own things.** The module hooks exactly: `session.start`; `tool.call`
  matched to its own tools (`mcp__claudex__run|wait|review|verdict`); `command.run` matched to
  `{ command: 'claudex' }`; `ui.render` matched to its own panes (`claudex-workers`,
  `claudex-findings`). No other hook — in particular no `prompt.compose` (a policy change must
  never rewrite the system prompt and invalidate the prompt cache) and no `tool.check`.
  **Capabilities** (`$` calls, as `claude plugin validate` lists them) are allow-listed too:
  `$.process.run`, `$.tool.register`, `$.tool.check`, `$.command.register`, `$.clock.*`,
  `$.state.*`/`atom`/`read`/`update`, `$.store.*`, `$.session.id`, `$.prompt.submit`,
  `$.ui.status|toast|open|close|resolve|invalidate`. Never `$.fs`, `$.http`, `$.settings`,
  `$.session.append`, `$.agent.*`, `$.model.*`, `$.env`. A test enforces both lists.
- **F2 — no policy of its own, and no permission bypass.** Every action is a `claudex-worker`
  argv via `$.process.run`, built in one module; the worker keeps enforcing switch, tiers,
  parallel limit, modes and confinement. The tool never passes `yolo`. **Launching tools
  (`run`, `review`) first ask the engine's permission verdict** with
  `$.tool.check({ tool, input })` (input nested, S1) — a plugin-served tool otherwise skips the permission system
  entirely, because `tool.call`'s `next(e)` is where core's permission prompt lives and a served
  tool never calls it (`.cache/mods-api/claude-code.d.ts:3717`). `allow` → run; `deny` → deny
  with the engine's reason; `ask` → deny with: *needs permission — add `mcp__claudex__run` to
  permissions.allow, or dispatch with Bash `claudex-worker` (which prompts)*. The mod opens no
  permission UI of its own. **Go/no-go:** spike S1 must show that `$.tool.check` returns `deny`
  under a deny rule and in plan mode, `ask` with no rule in default mode, and `allow` with an
  allow rule, and that a denied call has no side effect. If it cannot, the native tools are
  dropped (visibility, commands and panel remain; dispatch stays on Bash).
- **F3 — no credentials.** The mod never reads `~/.codex` or any token file.
- **F4 — off means off.**
  - *Cold start with `CLAUDEX=off`:* no tools registered, no status line, no timer. Only
    `/claudex` is registered (`status`, `config CLAUDEX on` work).
  - *Switched off during the session* (via `/claudex config` or observed by a poll): `run` and
    `review` refuse in the handler before any argv is built (and the worker refuses too); no new
    jobs; the status line is cleared; the poller keeps running **only while owned jobs are
    undelivered** (they were sanctioned when started), then stops. `wait`, `verdict`, the panes
    and *Cancel* stay usable. Tools stay listed (the API has no unregister).
  - *Switched on during the session:* tools registered, poller started.
- **F5 — unsolicited writes to the conversation, only three:** (a) an owned job's completion
  that was not delivered by `wait`; (b) the user's *Send decisions* in the findings pane;
  (c) the `context` note when `/claudex config` changed the **effective** policy. Results of
  tools the model called and output of commands the user typed are requested, not unsolicited.
  Jobs the mod did not start (Bash, couriers) never cause (a).
- **F6 — bounded polling.** One single-flight poller: a tick that finds the previous one still
  running skips; every `$.process.run` has an explicit `timeoutMs`; each activation has a
  generation number checked after every await and before every side effect, so a late result
  from a previous activation (reload, off) does nothing. Cadence 2 s while any job is running or
  any owned job is undelivered, else 60 s; the old interval is cancelled before re-arming; a
  launch re-arms immediately.
- **F7 — panes open on request or when the user must act.** The workers pane opens only from
  `/claudex workers`. The findings pane opens from `/claudex findings`, and is also opened (as an
  unasked open) when the director's verdicts leave at least one finding `unresolved`. Unasked
  opens follow the engine's rule: placed from 144 terminal columns (110 for a pane the person
  opened before and has not closed by hand), otherwise waiting undrawn until the person opens it
  (`claude-code.d.ts:13116`); a toast always accompanies it. *Close* buttons call
  `$.ui.close` (`role="dismiss"` is only a drawing hint).

## C1. `claudex-worker` — the single source of truth

### Job lifecycle

- **One job, one id, one supervisor.** Every entry path (`run`, `resume`, `start`; so Bash,
  couriers, the mod) creates exactly one job. `start` validates synchronously everything `run`
  would refuse before launching (switch, tier enabled, args, cwd, non-empty brief) and exits
  non-zero with the same messages, so a blocked dispatch never becomes a job. It then launches
  the supervisor in the background, passing the job id through an internal env var
  (`CLAUDEX_JOB_ID`, validated `^[0-9]+-[0-9a-f]{8}$`); `run` called with it adopts that job
  instead of creating another.
- **The supervisor** is the `run_worker` process itself. It starts the `claude` child with
  `setsid` (own session and process group), records the child's identity, waits, and always
  publishes a terminal state: exit status is captured explicitly (`rc=0; … || rc=$?`, never
  lost to `set -e`), preflight and spawn failures included. Publishing order: `out`, `err`,
  `session`, `findings.json` (adversary) — each written to a temp file and renamed — then `rc`
  last, by rename. A supervisor killed uncatchably leaves no `rc`; the job reads as `lost` once
  the recorded child identity is gone.
- **Records.** `$STATE_DIR/jobs/` is created under `umask 077`; an existing jobs dir is
  re-`chmod`ed `0700`; the dir and each job dir must be owned by the user and not a symlink, or
  the worker refuses. A job dir is created with plain `mkdir` (no `-p`) under an id
  `<epoch>-<8 hex from /dev/urandom>`, retried on collision. `meta.json` (written by rename):
  `{id, tier, kind: "worker"|"adversary", model, mode, cwd, started, origin, owner}` —
  `origin` is `mod` when `CLAUDEX_JOB_ORIGIN=mod`, else `bash`; `owner` is
  `CLAUDEX_JOB_OWNER` (the mod passes its session id) or null. `child.json`:
  `{pid, pgid, starttime, boot_id}` — `starttime` = field 22 of `/proc/<pid>/stat`,
  `boot_id` = `/proc/sys/kernel/random/boot_id`.
- **Identity check** (`alive`): `child.json` parses, `pgid > 1`, `pid == pgid`, the boot id
  matches, and `/proc/<pid>/stat` exists with the same `starttime`. Anything else is "not
  alive" — never "alive by pid".
- **States:** `running` (no `rc`, child alive), `done` (`rc`=0), `failed` (`rc`≠0),
  `cancelled` (`rc`=130 and a `cancelled` marker), `lost` (no `rc`, child not alive and
  supervisor gone — supervisor pid recorded in `meta.json` and checked with the same identity
  rule).
- **`cancel JOB`** — takes the job's `lock` (`flock`), refuses unless the job is `running`,
  writes the `cancelled` marker, sends SIGTERM to `-pgid` after the identity check, waits up to
  5 s, re-checks identity, then SIGKILL. The **supervisor** (not `cancel`) publishes `rc`=130
  when its child dies with the marker present. Publishing `rc` also takes the lock, so cancel
  and completion serialize.
- **Retention.** Job dirs whose `rc` is older than 7 days are pruned at each `run`/`start`;
  never a job without `rc`. A pruned job reads as missing (the mod reports it as expired).

### Commands

```
claudex-worker jobs [--json] [--limit N] [--id JOB]...   # newest first; --id selects exact jobs
claudex-worker status [--json]
claudex-worker cancel JOB
claudex-worker findings JOB          # findings.json; exit 1 when absent
claudex-worker run|start TIER ... [--resume SESSION_ID]  # `resume SESSION TIER` stays as alias
claudex-worker wait JOB [--timeout S]   # unchanged contract: 0/≠0 = finished with that rc, 5 = still running
claudex-worker result JOB            # unchanged
```

`jobs --json` items: `{id, tier, kind, model, mode, cwd, origin, owner, state, started,
elapsed_s, rc, session, has_findings, findings_error}`; `--id` with an unknown or pruned id
yields `{id, state: "missing"}` for it. `status --json`: `{policy: {8 keys, effective values},
policy_sources: {KEY: "default"|"file"|"env"}, proxy: {up, ours, port}, token_hours_left |
null, plan: {used_pct, limit, age_s} | null}`. `plan` comes from the newest proxy log line
(`$STATE_DIR/proxy.log`, or the OpenRC log if configured there) whose `used_pct=` value is
numeric; `age_s` from that line's timestamp; null when none (e.g. under the systemd unit, which
logs to the journal — documented as unknown there).

### Adversary contract and findings

For `kind=adversary` the read contract gains: *end with a fenced block whose info string is
`claudex-findings`, holding only a JSON array; at most 50 items; each
`{id: "F1"…, severity: "critical"|"high"|"medium"|"low", title (≤200 chars), mechanism,
evidence, fix (each ≤2000 chars), unverified: bool}`; ids unique; an empty array is allowed when
the prose justifies "no findings".* The worker extracts the **last** such block and validates it
with `jq` (array; ≤50; every key present and typed; enums; lengths; unique ids). Valid →
`findings.json`. Invalid → no file and `findings_error` (one line: why) in `jobs --json`; the
free-text report is untouched.

`VERSION` → `0.2.0`.

## C2. The mod (`plugin/`)

```
plugin/hooks/hooks.json        + "modules": ["./register.ts"]   (shell SessionStart hook stays)
plugin/hooks/register.ts       entry: activation, generation, wiring
plugin/hooks/worker.ts         the only place argv is built; typed calls with timeouts
plugin/hooks/jobs.ts           poller, reconciliation, delivery state machine, status line, toasts
plugin/hooks/tools.ts          run / wait (permission gate, F2)
plugin/hooks/commands.ts       /claudex
plugin/hooks/panes.tsx         workers pane
plugin/hooks/adversary.tsx     review / verdict, review aggregate, findings pane, arbitration
plugin/types/index.d.ts        PluginState contract (plugin.json "types")
plugin/tests/                  claude plugin test suites + shared harness
```

`plugin.json`: version `0.2.0`, `"types": "./types/index.d.ts"`. `.gitignore`:
`plugin/.claude-plugin/types/`. `WORKER` = `$.plugin.root + '/bin/claudex-worker'` (S2: root is
the plugin folder).

### Ownership and identity (review F9)

Every job the mod starts carries `CLAUDEX_JOB_OWNER=<$.session.id()>` and
`CLAUDEX_JOB_ORIGIN=mod`. Before any delivery or state mutation the mod re-reads
`$.session.id()`; a job whose `owner` is not the current session id is **orphaned** (the
session was cleared or replaced): toast only, never a prompt. At `session.start` the mod
reconciles from the worker (`jobs --json` filtered by `owner`), so a job started just before a
reload or crash is still found even if the mod's own state was not yet written.

### Delivery state machine (review F6, F8, F13)

Per owned job: `pending` → `waiting` (a `wait`/`run(wait)` call holds a reservation) →
`pending` again if the wait returned "still running"; `pending` → `claimed` (poller) →
`notified` | `dropped`; `waiting` → `delivered` when the wait returned a terminal report.
Transitions use `update()` (versioned, retried on conflict), so poller and wait cannot both
claim. The poller **reconciles every owned job not yet `delivered`/`notified`/`dropped` by id
each tick** (`jobs --json --id …`), so a job that was already terminal at first sight, finished
while the session was closed, or is older than the display list is still delivered. A
`missing` record → notify "result expired (pruned)" once.
On `claimed`: if `kind=adversary`, run **ingestion** first (idempotent: load `findings.json` or
the unstructured report into the review aggregate); then `$.prompt.submit`; result `{drop}` →
`dropped` + toast with the reason; otherwise `notified`. Wait paths also run ingestion before
returning a review's report. Crash guarantee, stated honestly: the API has no transaction
spanning `$.store` and `$.prompt.submit`; a crash between claim and submit loses that one
notification — the job stays visible in the workers pane and via `claudex-worker result`.

Persisted (`$.store`, key `claudex:v1:<session id>`): `{v: 1, jobs: {id: {kind, state}},
reviews: {…minimal…}}` — ids, delivery states, review rounds, verdicts and decisions; never
reports or findings text (re-read from the worker). Entries older than 7 days are evicted at
`session.start`; a store write that rejects (4 MiB plugin limit) is toasted once and the
in-session `$.state` continues.

### Tools

Registered at `session.start` when the effective `CLAUDEX` is `on` (and on a switch to on).
Every handler validates its input itself (enums, lengths, `cwd` an absolute existing path or
absent) — the schema is advisory.

| Tool | Input | Does |
|---|---|---|
| `run` | `tier` (luna\|terra\|sol\|astra), `brief`, `cwd?`, `mode?` (read\|edit), `effort?`, `resume?`, `wait?` (default false), `wait_seconds?` (1–540, default 540) | F2 gate → `start` (sync preflight errors come back as tool errors) → job id + model; with `wait`, reservation + `wait --timeout wait_seconds` with `timeoutMs = (wait_seconds + 30) * 1000`. |
| `wait` | `job`, `timeout_seconds?` (1–540) | Reservation + `wait`; only owned jobs. |
| `review` | `artifact`, `context?`, `cwd?`, `wait?` | F2 gate → `start adversary` (read-only); creates the review aggregate, round 1. |
| `verdict` | `review`, `round`, `verdicts: [{id, stance, note}]` | Records stances for that round; rejects unknown review, stale round, unknown finding ids; returns unanswered ids; if any finding is now `unresolved`, opens the findings pane (F7). |

Result mapping for `wait`-style calls: exit 0 → the report (job `delivered`); exit 5 → "still
running (elapsed …)", not an error (job back to `pending`); other exit → `isError` carrying the
report on stdout **and** stderr (job `delivered`, since the terminal report was returned); a
`$.process.run` rejection (timeout, cannot start) → `isError` "claudex-worker did not answer:
…" (job back to `pending`). Truncated stdout (`isStdoutTruncated`) is said so in the text.

### Completion notification text

Worker job: `claudex job <id> (<tier>, <model>) finished: <state>.` + the report (cut at 20 000
chars with a pointer to `claudex-worker result <id>`). Review job: findings listed
(`F1 [high] title — evidence — fix`, `UNVERIFIED` where set) + *answer every finding with
`mcp__claudex__verdict` (review, round, id, stance: accepted + what changed / rebutted +
evidence / unresolved); unresolved findings are the user's to arbitrate in the findings pane —
do not settle them yourself*. Unstructured review: the report + *no structured findings were
returned; answer it in prose and do not call verdict*.

### Visibility

- **Status line** (effective `CLAUDEX=on`): `2 running · usage 34% · login 5d`; the host
  prefixes the plugin name, so it shows as `claudex: 2 running · …`. `idle` for no running jobs;
  `login 5h!` under 24 h; usage segment `usage ?` when `plan.age_s > 3600`, omitted when `plan` is
  null; login omitted when null; `port taken` when `up && !ours`.
- **Workers pane** (`/claudex workers`): last 20 jobs — tier, model, mode, state, elapsed, cwd
  basename, origin. Buttons: *Cancel* on running jobs (`cancel`), *Report* on finished ones
  (fetched in the press handler into state, shown as `Markdown`, cut to the pane's room),
  *Close* (`$.ui.close`). Sized to `e.props.bodyColumns`; single-width glyphs.
- **Toasts:** owned job done/failed/cancelled/expired/orphaned; login < 24 h (once per
  session); plan crossing 80 and 95 (once each per session).

### `/claudex` (always registered)

- `status` (default): status table + last 5 jobs. `config`: keys, effective values, source
  (default/file/env), one-line meaning.
- `config KEY VALUE`: `set`; then `status --json` again. If the key's effective value changed,
  output the new line and attach `context: ["claudex policy changed: KEY=VALUE. This overrides
  the session-start policy line for the rest of this session."]`; if the environment shadows it,
  say *stored in the config file, but this session's environment sets KEY=… which wins; it takes
  effect in a new session without that variable* and attach no context. Effective `CLAUDEX`
  changes apply F4.
- `workers`, `findings [JOB]` open the panes (asked opens). Unknown → usage.
- The `status` and `config` skills stay as a fallback while Mods is early access (user,
  2026-10-02: the rollout switch flapped off for the account); `/claudex` is the no-model-turn
  path when the mod is loaded. Remove the skills once Mods is stable.

### Review aggregate and findings pane (review F13, F14, F16)

`reviews[reviewId]` where `reviewId` = the round-1 job id: `{cwd, model, rounds: [{round, job,
session, findings | null, findings_error | null, verdicts: {fid: {stance, note}}, decisions:
{fid: 'claude'|'gpt'}, sent: [fid]}], active_round}`. Rounds are immutable once superseded;
`verdict` and decisions name their round and are rejected for a stale one, so a reused id like
`F1` in round 2 is never confused with round 1.

Pane: header `review <id> · <model> · round n · accepted a · rebutted r · unresolved u ·
pending p`; per finding of the active round: severity, id, title, `UNVERIFIED`, evidence (dim),
fix, stance + note or `pending`; on `unresolved` findings, *Claude is right* / *GPT is right*
(toggle a pending decision). Footer: *Send decisions (n)* — one `$.prompt.submit`
(`User arbitration on review <id> round <n>: F3 → GPT is right: apply its fix; F5 → Claude is
right: keep as is.`), marks them sent; *Another round* — enabled when any stance is rebutted or
unresolved and no round is running; launches `start adversary --resume <session> --cwd
<original cwd>` (F2 gate applies; it is a launch) with a brief holding only the director's
notes on rebutted/unresolved findings; the job is owned like a tool-started one (its completion
is notification (a)); the button is disabled while it runs; *Close*. Unstructured round: the
pane says so and shows the report as `Markdown`.

## Spikes

| Spike | Result |
|---|---|
| S1 permission (go/no-go for F2) | **GO** — without the gate a hook-served tool ran with no prompt in default *and plan* mode (bypass confirmed). With `$.tool.check({ tool, input })`: default → `ask`; allow rule → `allow` (rule named); deny rule → tool hidden from the model; plan → model declines, or `ask` ("Cannot call … while in plan mode"); dontAsk / acceptEdits / auto → `ask`; bypassPermissions → `allow`. No side effect on any non-allow decision. A served tool must return `{ result: string }` (an object result is refused) |
| S2 stub `process.run`, drive clock | **pass** — stubs answer `{ value: … }`; `mock.clock(on).advance(ms)` drives `$.clock.every`; state is observed through beneath `state.get/set` hooks (the test's own `$.state` is undefined); every op the plugin calls (`tool.register`, `command.register`, …) needs a beneath answer in tests |
| S3 `$.prompt.submit` from a timer when idle | manual (user) |
| S4 `claude plugin test` inside a GPT `edit` worker | **pass** |
| S5 type-check | **pass** — `deno check` with a `deno.json` mapping `claude-code` to the `.d.ts`; it caught `context` being `readonly string[]` |
| `$.plugin.root` | the plugin folder |

## Testing (gates)

- **Shell** `tests/worker/jobs_test.sh`, wired explicitly into `make check` next to the other
  worker suites: one job per `start` (and its `run`); explicit rc on failing stub, missing
  `claude` binary, invalid config; `start` sync refusals create no job; states incl. `lost` and
  `cancelled`; `--id` incl. `missing`; `cancel` kills the stub's group and an **unrelated
  sentinel process survives** stale/corrupt/reused-pid `child.json` and the TERM→KILL window;
  cancel vs completion race; permissive pre-existing jobs dir fixed to 0700; symlinked job dir
  refused; id collision retried; `status --json` sources and `plan` (numeric, `-`, stale, none);
  findings: valid, last block wins, malformed, missing key, bad enum, over-length, >50,
  duplicate ids, empty array; pruning keeps rc-less jobs; footer unchanged.
- **Mod** `claude plugin test plugin` with a shared harness answering every op: F2 gate
  (`allow`/`deny`/`ask` → run/deny/deny-with-hint, **no `process.run` on deny**); handler
  input validation; never `yolo`; `start` refusal → `isError`; wait mapping (0, 5, ≠0 with
  stdout+stderr, rejection, truncation) with correct `timeoutMs`; delivery machine: fast
  completion seen terminal on first poll is delivered once, wait vs poll race delivers once,
  `drop` → dropped, reload does not re-notify, >20 newer jobs do not hide an owned one,
  missing → expired, orphaned owner → toast only; single-flight and generation fencing (late
  result after off does nothing); F4 cold-off, on→off→on; config effective/shadowed; status
  line strings; panes on `terminal` and `desktop`; review ingestion from both wait and poll;
  verdict stale-round rejection; send decisions; another round argv and disabled state.
- **Footprint** `tests/worker/mod_footprint_test.sh`: `claude plugin validate plugin` hooks and
  calls equal the F1 allow-lists exactly.
- **Types** `deno check` over `plugin/hooks` and `plugin/tests` (config in `plugin/deno.json`).
- `make check` runs all; when `claude` or `deno` is absent it prints
  `UNVERIFIED: plugin checks skipped (…)` — acceptance (Task 6) requires a non-skipped run.
- **Manual (user):** S3; status line and panes in a real terminal; one real `run`, one real
  `review` end to end.

## Out of scope

Intercepting the Agent tool; `yolo` through the tool; a `/config` (userConfig) UI; changing the
proxy (so plan usage under systemd stays unknown); any change to the shell SessionStart hook.

## Review log (v1 → v2)

All 18 findings of the v1 adversarial review were accepted; two with a modified fix.

| # | Sev | Finding | Answer |
|---|---|---|---|
| 1 | high | plugin-served tool skips permissions | accepted — `$.tool.check` gate, S1 go/no-go (F2) |
| 2 | high | pid-only cancel can hit a reused pid | accepted — identity (pgid, starttime, boot id), lock, supervisor publishes rc |
| 3 | high | background failure never writes rc under `set -e` | accepted — confirmed in today's `start`; one supervisor, explicit rc, sync preflight |
| 4 | med | jobs dir perms/collisions/symlinks | accepted — umask, chmod migration, exclusive mkdir, random ids, ownership/symlink checks |
| 5 | high | 30 s default process timeout; exit 5 vs "non-zero = error"; stdout lost | accepted — explicit `timeoutMs`, distinct mapping, stdout+stderr |
| 6 | high | transition-only polling loses completions | accepted — reconcile owned jobs by id each tick |
| 7 | med | overlapping polls, late results | accepted — single-flight + generation (F6) |
| 8 | high | delivered/notified booleans race | accepted — state machine with versioned updates; honest crash guarantee |
| 9 | high | /clear changes session without session.start | accepted — owner session id in job meta, checked before delivery |
| 10 | high | env shadows `config set` | accepted — effective vs stored, context only on effective change |
| 11 | med | F4 contradicted by retained tools | accepted — cold-off vs switched-off rules |
| 12 | med | "zero-token" is false | accepted, modified — renamed "no model turn"; F5 scoped to unsolicited writes; command text kept |
| 13 | med | review(wait) skips ingestion | accepted — idempotent ingestion on both paths |
| 14 | high | another-round ownership/staleness | accepted — review aggregate with immutable rounds, owned round jobs |
| 15 | med | store 4 MiB, truncation, pruning | accepted — bounds, minimal versioned store, eviction, expired outcome |
| 16 | med | auto-open provenance and seating rule wrong | accepted, modified — open only when unresolved findings exist (user must act), engine seating described, `$.ui.close` |
| 17 | med | plan usage under systemd / `used_pct=-` | accepted — numeric + age + stale; systemd unknown |
| 18 | med | gates cannot prove guarantees | accepted — explicit wiring, capability audit, loud skip, type gate, permission/lifecycle tests |

## v3 — changes from the implementation review (job `1790914050-32593`, gpt-6-astra@xhigh)

The review of the built code found 16 defects; all accepted. Design changes (they override the
sections above where they differ):

**Worker (`claudex-worker`)**
- **Adversary contract is actually sent** (review F1): for `kind=adversary` (incl. resumed
  rounds) `--append-system-prompt` carries the read contract **plus** the findings contract of
  C1. Tests assert the argv, not only extraction of fabricated output.
- **Supervisor identity** (F2): `BASHPID` is captured outside command substitution. `start`
  waits (≤5 s) until `meta.json.supervisor` is recorded before printing the id. A job with
  `supervisor: null` younger than 30 s reads as `running`; queued jobs (waiting for proxy or a
  slot) read as `running`, never `lost`.
- **Fail closed** (F3): no security-relevant setup runs inside an `|| rc=$?` context unchecked;
  `edit` mode refuses to launch unless the sandbox settings JSON was built and is non-empty;
  every setup step's status is checked explicitly.
- **Group anchor for cancel** (F4, F5): the job's process group is led by a small **anchor**
  (`setsid bash -c …`) that runs `claude` as its child, traps TERM/INT/HUP with a handler (not
  ignore, so children get default dispositions), and waits until its child is gone. While the
  anchor lives the group id cannot be reused, so `cancel` = verify anchor identity → TERM the
  group → poll `/proc` for members of the group other than the anchor (≤5 s) → verify anchor
  identity again → KILL the group (atomic for every member, anchor included). Residual race,
  documented: the anchor exiting on its own in the microseconds between the final check and the
  KILL (`pid_max` here is 32768).
- **Every path publishes `rc`** (F6): an adopted job (`CLAUDEX_JOB_ID`) installs its publish
  guard (EXIT trap writing `rc` if none) before `load_policy` or any other fallible step; the
  supervisor traps TERM/INT/HUP, cancels its group through the same routine and publishes
  `rc` (130 for a cancel, 143 otherwise).
- **Findings strictness** (F11): exactly one JSON value (`jq -s` + `length == 1`), output
  canonicalised to the 7 fields, `id` ≤16 chars matching `^F[0-9]+$`, serialized
  `findings.json` ≤ 256 KiB; anything else → no file, `findings_error`.
- **Legacy/partial records** (F12): every `jobs --json` item has every key; unknown values are
  `null` and `legacy: true` marks records without `meta.json` (state from `rc` if present).
- **Owner query** (F8): `jobs --json --owner OWNER` lists every retained job with that owner
  (newest first, cap 500), independent of the display limit.

**Mod**
- **Coordination is module-authoritative** (F7, F9, F16): `$.state` reads are a per-dispatch
  snapshot, so correctness never depends on re-reading state. One shared module holds the live
  copy (activation token, poll flag, owned jobs with owner and delivery state, review alerts).
  JavaScript runs one continuation at a time, so a synchronous check-and-set on it is atomic:
  the activation token is bumped synchronously at activation and compared (captured value vs
  live) after every await and before every side effect; the poll flag is taken synchronously
  before the first await; claims and wait reservations are synchronous transitions; a fenced
  abort reverts its own `claimed` to `pending`. `$.state` and `$.store` are **published copies**
  written with plain `set` from the live copy (no `update()` retry loops against a snapshot).
- **Leases reset on activation** (F7): an activation rebuilds the live copy from `$.state`, else
  `$.store`, and turns every `waiting` or `claimed` entry back into `pending` (no wait call or
  claim survives an activation). Delivery is therefore **at least once** across a reload or
  crash; a duplicate notification is possible only if the session dies between a submit and its
  publish. (Replaces v2's "a crash loses that notification".)
- **Startup discovery** (F8): the first poll after activation adopts `jobs --json --owner
  <session id>`, not the display list; the owner is kept in the live copy and its published
  copies (no module-only maps that a reload cannot rebuild).
- **Config** (F10): `/claudex config KEY VALUE` reads effective status fresh *before* the set
  and again after; context only when the effective value changed, built from the effective
  value; activation follows the effective `CLAUDEX` vs the live `on`, whatever any cache says.
- **Arbitration alerts per review round** (F13): an unresolved finding in a round not yet
  alerted opens the pane and toasts once for that round; no global latch.
- **Pane robustness** (F12): legacy/partial job rows render with `?` fields.
- **Portable tests** (F14): tests assert the worker argv by suffix (`…/bin/claudex-worker`) or
  derive it from the harness root; `deno check` takes the API declarations from `MOD_TYPES`
  (default: `plugin/.claude-plugin/types/claude-code/index.d.ts`, else
  `.cache/mods-api/claude-code.d.ts`) and prints `UNVERIFIED: … no API declarations` when
  neither exists.
- **Exact footprint** (F15): the footprint test compares the hook set exactly (the eight
  registrations), calls as a subset of the allow-list.
- Cleanups from the director's read: drop `worker.ts`'s unusable `$`-taking helpers; one pure
  parser per worker command shared by callers; the "Started job" text takes the model and mode
  from `jobs --json --id` instead of a duplicated tier table.

Still UNVERIFIED (manual): whether continuations of an unloaded module environment keep running
after a hot reload (the at-least-once rule above bounds the damage to a duplicate).

## v4 — changes from review round 2 (same session, resumed)

Round 2: 12 of 16 resolved; F5, F6, F7, F14 partial; new N1–N8, all accepted. Design:

**Worker**
- **Cancel handshake** (F5): the anchor polls (≤100 ms) for `hold` in its job dir while it waits.
  On seeing it, it writes `held` (its identity inside) and will not exit until `hold` is gone.
  `cancel`: create `hold` → wait ≤2 s for `held` matching the recorded anchor identity → only then
  TERM the group, poll members ≤5 s, KILL the group (the anchor dies with it) → remove `hold`. No
  `held` and anchor gone → nothing to signal. While `held` stands the anchor is alive, so the
  group id cannot be reused: the check-then-signal race is closed, not just documented.
- **Queued cancel** (N6): a job with a live supervisor but no anchor yet is cancellable: `cancel`
  writes the `cancelled` marker and a `stop` file; `run_worker` checks `stop` while waiting for
  the proxy and for a slot and immediately before launching the anchor, and returns; the
  supervisor publishes `rc`=130. `cancel` waits ≤10 s for `rc`.
- **Signal-safe startup** (N5): the supervisor's TERM/INT/HUP handler first writes `stop`, then
  sets a stopping flag; it never concludes "no worker" from an unset PID. After spawning and
  recording the worker PID, the supervisor checks the flag and, if set, cancels through the
  normal path. `run_worker` checks `stop` before the anchor launch (above), so a worker spawned
  during the signal never launches `claude`. `rc` is published only after the worker subprocess
  is reaped.
- **Findings extraction** (N7): an opening `claudex-findings` fence discards any earlier
  candidate; an unterminated final block → `findings_error`, no file.
- **Failure diagnostics** (N8, F6): an adopted run writes stdout/stderr to the job's `out`/`err`
  from its first line (never `/dev/null`); the EXIT guard publishes, in order, `out` (the failure
  message if `out` is missing), `err`, then `rc`, so `wait`/`result` explain an early failure.
- **Makefile** (F14): `mktemp "${TMPDIR:-/tmp}/…"`. `claude plugin test` refusing because
  *hooks modules are turned off in this process* (the server-side Mods rollout switch) prints
  `UNVERIFIED: plugin tests skipped (Claude Code hooks modules are switched off for this
  account/process)` and continues, like a missing tool; acceptance still needs a real run.

**Mod**
- **Session rollover** (N1): every entry point (each tool handler, each poll tick, `/claudex`)
  first syncs `$.session.id()` with `live.session`. On a change: bump the token (fences old
  work), toast once that earlier jobs belong to the previous conversation, replace `live.owned`
  and `live.reviews` with the new session's store entry (empty if none), set `live.session`;
  discovery and ownership then use the new id.
- **Side effects are recorded whatever the token** (N2, N4): once an external effect has
  happened its bookkeeping is always written — a `start` that returned a job id registers
  ownership (if the session is unchanged); a `prompt.submit` that resolved marks its job
  `notified`. Claims carry an operation id; `live.inflight` holds the ids of submissions in
  flight in this module environment; activation resets only claims whose operation is not in
  flight (after a real reload the set is empty, so every claim resets: at-least-once, as v3).
- **Submission outside the poll** (N2): the poll claims and starts the submission without
  awaiting it, so a busy session never freezes polling or the status line.
- **Reconciliation never overwrites** (N3): adoption re-checks inside its synchronous mutation
  and skips any job already in `live.owned`; the store is restored once at activation, before
  the lease reset, and merges only entries missing from `live.owned`.
- **Another round reservation** (N4): reserved synchronously on the review (`launching: op`),
  keyed by review id, before `process.run`; the returned job id is recorded as the new round
  whatever the token; the reservation is cleared after. *Send decisions* likewise keys on
  review + round, and its acknowledgement is recorded whatever the token.

## v5 — single-owner termination (review round 3)

Round 3: F14, N1, N2, N7, N8 resolved; F5, F6, F7, N3, N4, N5, N6 partial; new M1–M3 (high)
and M4–M9 (medium), all accepted. Rather than patch each signal interleaving, termination gets
one owner.

**Worker: the supervisor is the only process that ever signals the job's group.**
- `cancel JOB` sends no signal. Under the job lock it writes `cancelled` and `stop` and returns
  `cancel requested JOB` (exit 0; exit 2 if the job is not running). It waits up to 10 s for
  `rc` only to report `cancelled`; otherwise it says the job is still stopping.
- Signal handlers (supervisor and `run_worker`) only write `stop` and set a flag; they never
  call the termination routine, wait, or take locks.
- The supervisor's wait is a loop: while the anchor is alive, poll every 100 ms for `stop`;
  on `stop` it runs the v4 hold/held handshake → TERM group → member poll ≤5 s → KILL group →
  release `hold`. One caller, so the handshake cannot be raced (M1); no external process signals
  a numeric group id at all, and the canceller holds nothing that needs cleanup (M9).
- **Go gate** (M2): the anchor waits for a `go` file before it launches `claude`; if `stop`
  appears first it exits without launching. The supervisor writes `go` only after `child.json`
  is published and `stop` is absent. A signal at any startup point therefore leaves no `claude`.
- **Interruptible preflight** (M6): the token refresh runs as `timeout 120 codex exec …` in the
  background, polled with `stop`; proxy start and slot waits already poll `stop`.
- **Guard from allocation** (M8): the publish guard is installed immediately after the job dir
  is allocated, before brief/meta writes. **Lock ownership** (M4): the finalizer reuses a lock
  descriptor it already holds instead of re-acquiring.

**Mod**
- **Claims belong to an operation of a generation** (M3): a claim's lease is `<generation>:<op>`;
  activation resets only claims of an older generation that are not in flight; immediately
  before the irreversible `$.prompt.submit` the continuation checks synchronously that the job is
  still `claimed` with its own lease, else it drops its result.
- **Linkage wins over discovery** (M5): registration from a launch (run, review, Another round)
  overwrites a provisional record discovery created (`review` linkage, kind) while keeping its
  delivery state; ingestion of a job with a launch in flight for its review waits for the launch
  to be recorded.
- **Restore timestamps** (M7): the age filter applies to restored store entries only, with a
  `now` read after the store read; live entries are never filtered.
