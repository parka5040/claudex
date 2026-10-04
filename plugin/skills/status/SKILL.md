---
name: status
description: Show claudex proxy health, Codex login time left, and policy
disable-model-invocation: true
---

Run `claudex-worker status` and show the result, including any model resolutions and terra deprecation warning. Default tiers are luna, sol and astra; terra remains accepted but runs as sol. If `codex_token_hours_left` is below 24 or unreadable, tell the user that running `codex exec 'ok'` refreshes the login. If `ours=NO`, tell the user another process holds the claudex port and workers will refuse to run until it is gone.

This skill is the fallback while Claude Mods is early access. When the claudex mod is loaded, `/claudex status` shows the same without a model turn.
