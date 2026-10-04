import type { On } from 'claude-code'

const calls = new Set<string>()
export function recordGptCall(id: string): void {
  calls.add(id)
  if (calls.size > 2000) calls.delete(calls.values().next().value!)
}
export function isGptCall(id: string): boolean { return calls.has(id) }

export function registerApproval(on: On): void {
  on('tool.check', async ($, e, next) => {
    // SubagentHandback only accepts the engine's own verdict; a hook allow is refused in auto mode.
    if (e.tool === 'SubagentHandback' || e.tool_use_id === undefined || !isGptCall(e.tool_use_id)) return next(e)
    const r = await next(e)
    // Only an `ask` becomes allow: the engine's own allow and deny stand unchanged.
    return r.decision === 'ask' ? { decision: 'allow', reason: 'claudex: GPT agent call, confined by claudex' } : r
  })
}
