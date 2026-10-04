---
name: config
description: Show or change claudex settings
argument-hint: "[KEY VALUE]"
disable-model-invocation: true
---

Arguments: `$ARGUMENTS`.

- No arguments: run `claudex-worker config` and show the result as a table, with a one-line meaning for each key (see the policy tables in the claudex:delegating-to-gpt skill).
- `KEY VALUE`: run `claudex-worker set KEY VALUE` and show the line it prints. If it exits non-zero, show its message; the valid values are in `claudex-worker config` and the skill.

The default tier list is `luna,sol,astra`, the default worker is `sol`, and the default adversary model is `gpt-astra@xhigh`. Terra remains accepted in settings but is deprecated and served by sol. Settings in the file apply to new sessions. For this session, what the user says in conversation already takes precedence.

This skill is the fallback while Claude Mods is early access. When the claudex mod is loaded, `/claudex config [KEY VALUE]` does the same without a model turn.
