---
name: adversary
description: Have the GPT adversary (Astra by default) attack a plan, diff or design
argument-hint: "[plan|diff|<path>|<question>]"
disable-model-invocation: true
---

The user is asking for an adversarial review. This request counts as the user asking for it, whatever `adversary=` says.

Target: `$ARGUMENTS` (`plan` = the current plan, `diff` = `git diff` of the working tree, a path = that file, anything else = the question itself; if empty, use the most recent plan or diff in this conversation).

**REQUIRED:** when `mcp__claudex__review` is present, dispatch with it. Otherwise follow the
"Adversarial review" section of the claudex:delegating-to-gpt skill and dispatch with
`claudex:relay-adversary` (Workflow or Mods-off Agent sessions) or
`claudex-worker run adversary` (Bash). Then give the user every finding marked accepted, rebutted or
unresolved.
