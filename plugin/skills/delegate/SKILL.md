---
name: delegate
description: Delegate a task to a GPT worker tier
argument-hint: "<luna|sol|astra> <task>"
disable-model-invocation: true
---

The user is asking you to delegate to a GPT worker. This request counts as the user asking for GPT, whatever `delegation=` says.

Arguments: `$ARGUMENTS` (first word = tier, rest = task). Terra is deprecated; use sol instead.

**REQUIRED:** use the claudex:delegating-to-gpt skill for the command forms, what a brief must contain, and how to verify the result. Write a self-contained brief for the task, dispatch it to the named tier, verify the outcome yourself, then report to the user.
