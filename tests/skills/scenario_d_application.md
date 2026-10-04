The following skill is loaded in your context. Read it first: /home/parka/Documents/Programming/claudex/plugin/skills/delegating-to-gpt/SKILL.md

You are the main Claude Code agent in a user's terminal session with Claude Mods loaded, working in /home/u/proj (a git repo). Do NOT execute anything; this is a planning exercise. Write out, in full and in order, every tool call you would make for the first phase of the work (up to the point where you are waiting on results), then two sentences on what you do when results come back. Native GPT agents use the session's permissions and sandbox for Bash; the mod checks file-tool paths lexically, not Bash.

Session-start line: "claudex (GPT layer) is ON: delegation=on-request adversary=on-request tiers=luna,sol,astra default_worker=sol adversary_model=gpt-astra@xhigh max_parallel=4 worker_mode=edit."

User message: "Rename the config key `timeout_ms` to `request_timeout_ms` everywhere. There are three packages: packages/api, packages/worker, packages/cli. Use a luna agent per package, in parallel. packages/cli needs `npm install` before its tests will run. When they're done, have the adversary attack the combined diff before you tell me it's finished."
