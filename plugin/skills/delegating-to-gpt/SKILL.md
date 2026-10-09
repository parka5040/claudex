---
name: delegating-to-gpt
description: Use when the user asks for GPT, Astra, Sol, Terra, Luna, "claudex", a GPT worker or subagent, a second opinion from another model, or an adversarial or architectural review of a plan, design or diff - or when the session-start line "claudex (GPT layer) is ON" is present and you are deciding whether another model may be used
---

# Delegating to GPT (claudex)

GPT agents are native Claude Code subagents whose model steps run on GPT through claudex.
Headless `claudex-worker` workers remain available for Workflow scripts and sessions without
Claude Mods. Both are additions to native Claude subagents, never replacements. You stay
responsible for the result.

## In the main session (claudex mod loaded)

Dispatch work with the **Agent tool**, `subagent_type: "claudex:gpt-<tier>"` (luna, sol or
astra). Run in the background by default; the Agent tool's task notification delivers the
result. Give the agent a complete, self-contained brief: goal, exact paths, constraints,
done-criteria and verification command. The agent has the spawn prompt and its session's files,
not this conversation. For adversarial and architectural reviews, use `mcp__claudex__review`.

Answer every adversarial finding with `mcp__claudex__verdict`, naming its review and round.
Unresolved findings go to the user through the findings pane. Do not settle them yourself.
If an Agent or review tool is denied for permission or policy, tell the user why. Do not
route around a denial unless the user explicitly authorizes another route.

Use `/claudex status`, `/claudex config`, `/claudex workers`, and `/claudex findings` for mod
views and settings. Without the mod, `/claudex:status` and `/claudex:config` remain available.

## Policy: what each value permits

The session-start line gives the settings. **What the user says in this conversation overrides them
for the rest of the session** ("no GPT today", "use sol for all implementation").

| `delegation=` | You may |
|---|---|
| `on-request` | use GPT only when the user's message asks for it. Do not offer it, even when it would be faster or cheaper. |
| `suggest` | offer it in one line with the numbers (which tier, how many agents), then wait for a yes. |
| `auto` | dispatch on your own judgement, within `tiers` and `max_parallel`. |
| `off` | not use GPT workers or agents. |

`adversary=`: `on-request` = only when asked; `plans` = run it on every plan before presenting it;
`plans+diffs` = also on every diff before you call work done; `off` = never.
`claudex-worker` enforces `CLAUDEX`, `tiers` and `max_parallel` at agent admission and for headless
workers. If blocked, report it to the user; do not work around it.

| TIER | Use for |
|---|---|
| `luna` | extraction, classification and summaries; not for writing code |
| `sol` | all code writing: implementation, tests, refactors, mechanical edits, debugging; default worker |
| `astra` | architectural review and peer-level second opinions; not for writing code |

`terra` is deprecated and served by sol. Send every code-writing task to `sol`, even a mechanical one; brief `astra` to review, not to edit files. The adversary is a
separate read-only review using `CLAUDEX_ADVERSARY_MODEL` (default `gpt-astra@xhigh`), not a
`claudex:gpt-adversary` agent.

## Facts about agents you cannot infer

- Native GPT agents run without permission prompts, confined by claudex; explicit deny rules
  and plan-mode denials still apply. Auto mode cannot judge GPT calls because GPT steps have no
  Anthropic response carrying its classifier verdict. Read, Write, Edit, Grep and Glob are
  confined lexically to the agent's working directory; this best-effort rule is **not** a
  symlink boundary. Bash runs under bubblewrap with writes confined to that directory and
  private temporary storage, **no network**, and home hidden except for that directory and
  read-only toolchain/cache directories. Bash rows show the `claudex-worker sandbox` wrapper;
  unavailable sandboxing refuses the command. Agent modes are `read` (no Bash) or `edit`;
  there is no per-agent `yolo`.
- GPT usage counts against the user's ChatGPT plan. A 401 means the Codex login lapsed: tell
  the user to run `codex exec 'ok'`. Do not retry in a loop.
- **An agent's report is a claim.** Agents can report blocked or sandboxed operations as
  "succeeded". Ground truth is `git diff`, the files on disk, and tests you run yourself.

## Workflow scripts and sessions with Claude Mods off

Workflows use courier agents `claudex:relay-luna`, `claudex:relay-sol`,
`claudex:relay-astra`, or `claudex:relay-adversary` (Workflow agent ids are not names the mod
registers). In a Mods-off session, those relays or Bash can dispatch a headless worker:

```bash
claudex-worker run TIER [--cwd DIR] [--effort low|medium|high|xhigh|max|ultra] [--mode read|edit] < brief.md
claudex-worker resume SESSION_ID TIER < followup.md     # same conversation; id is in the footer
claudex-worker start TIER [options] < brief.md          # prints JOB
claudex-worker wait JOB [--timeout 540]                 # exit 5 = still running, call again
claudex-worker status | config | set KEY VALUE
```

The brief is read from stdin. Use Bash `run_in_background: true` for non-trivial work; use
`start`/`wait` when a Bash call may exceed 10 minutes. Headless `edit` workers use Claude
Code's child sandbox (writes limited to their working directory, Bash network blocked); `read`
workers cannot edit. A headless worker's explicit `--mode yolo` has no confinement and requires
the user's explicit request. Native GPT agents use the claudex confinement described above,
not these child permission settings.

## Adversarial and architectural review

Send the artifact (plan text, `git diff`, design doc) and neutral context. Leave out your reasoning
for it and how confident you are. Ask for: severity, mechanism, evidence as `path:line` or a command,
and `UNVERIFIED` on anything it could not confirm. Then answer every finding to the user: accepted
(and what changed), rebutted (with evidence), or **unresolved**. Unresolved disagreements between you
and a peer-level model go to the user to decide; do not settle them yourself.

An architectural review uses the same review tool. Put the design, plan or relevant code paths in the
artifact and say in the context that the review is architectural: module boundaries, interfaces,
coupling, data flow, failure modes and migration risk. For a free-form second opinion instead of
findings, dispatch `claudex:gpt-astra` with a brief that says not to edit files.
