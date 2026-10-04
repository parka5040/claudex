import type { EngineInterface, On, ToolCallResult } from 'claude-code'
import { agentFor, lookupAgent } from './agents.ts'
import { resolveRequest, sandboxCommand } from './worker.ts'

function normalized(path: string): string[] {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts
}
export function insideCwd(cwd: string, path: string): boolean {
  const home = normalized(cwd)
  const target = normalized(path.startsWith('/') ? path : `${cwd}/${path}`)
  return home.every((part, index) => target[index] === part)
}
async function refusal($: EngineInterface, agentId: string | undefined, tool: string, path: string | undefined,
  pattern?: string): Promise<{ deny: string } | null> {
  if (!agentId) return null
  let agent = agentFor(agentId)
  if (!agent) {
    const lookup = await lookupAgent({ agent: { list: () => $.agent.list() } } as EngineInterface, agentId)
    if (lookup.kind === 'unknown') return { deny: `claudex: could not classify agent ${agentId}; retry` }
    if (lookup.kind === 'foreign') return null
    agent = lookup.agent
  }
  if (agent.cwd === null) return { deny: `claudex: confinement metadata unavailable for ${agentId}` }
  if (!insideCwd(agent.cwd, path ?? agent.cwd)) return { deny: `claudex: ${tool} outside ${agent.cwd} refused` }
  if (tool === 'Glob' && pattern && (pattern.startsWith('/') || pattern.split('/').includes('..'))) {
    return { deny: 'claudex: Glob pattern must stay inside the agent cwd' }
  }
  try {
    const request = resolveRequest($.plugin.root, agent.cwd, path ?? agent.cwd)
    const result = await $.process.run(request.argv, request.init)
    if (result.exitCode === 0) return null
    if (result.exitCode === 3) return { deny: `claudex: ${tool} target resolves outside ${agent.cwd}` }
  } catch { /* A failed resolver must never approve a host file operation. */ }
  return { deny: `claudex: could not verify ${tool} path` }
}
async function guard<T extends { agentId?: string }, R extends ToolCallResult>($: EngineInterface, e: T,
  next: (e: T) => Promise<R>, tool: string, path: string | undefined, pattern?: string): Promise<ToolCallResult> {
  if (!e.agentId) return next(e)
  let denied: { deny: string } | null
  try { denied = await refusal($, e.agentId, tool, path, pattern) }
  catch { return { deny: `claudex: could not classify agent ${e.agentId}; retry` } }
  return denied ?? next(e)
}

export function registerConfinement(on: On): void {
  on('tool.call', { tool: 'Read' }, ($, e, next) => guard($, e, next, 'Read', e.file_path))
    .catch(($, e, next) => e.agentId ? { deny: 'claudex: confinement check failed' } : next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) => guard($, e, next, 'Write', e.file_path))
    .catch(($, e, next) => e.agentId ? { deny: 'claudex: confinement check failed' } : next(e))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => guard($, e, next, 'Edit', e.file_path))
    .catch(($, e, next) => e.agentId ? { deny: 'claudex: confinement check failed' } : next(e))
  // Grep and Glob exist at runtime but are absent from the 2.1.288 tool type union.
  on('tool.call', { tool: /^Grep$/ }, ($, e, next) => guard($, e, next, 'Grep', (e as { path?: string }).path))
    .catch(($, e, next) => e.agentId ? { deny: 'claudex: confinement check failed' } : next(e))
  on('tool.call', { tool: /^Glob$/ }, ($, e, next) => guard($, e, next, 'Glob',
    (e as { path?: string }).path, (e as { pattern?: string }).pattern))
    .catch(($, e, next) => e.agentId ? { deny: 'claudex: confinement check failed' } : next(e))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.agentId) return next(e)
    let agent = agentFor(e.agentId)
    if (!agent) {
      let lookup
      try { lookup = await lookupAgent({ agent: { list: () => $.agent.list() } } as EngineInterface, e.agentId) }
      catch { return { deny: `claudex: could not classify agent ${e.agentId}; retry` } }
      if (lookup.kind === 'unknown') return { deny: `claudex: could not classify agent ${e.agentId}; retry` }
      if (lookup.kind === 'foreign') return next(e)
      agent = lookup.agent
    }
    if (agent.cwd === null) return { deny: `claudex: confinement metadata unavailable for ${e.agentId}` }
    if (e.run_in_background === true) return { deny: 'claudex: background Bash is not available to GPT agents' }
    if (agent.mode === 'read') return { deny: 'claudex: Bash is not available to read-only GPT agents' }
    const { tool: _tool, tool_use_id: _id, agentId: _agentId, ...input } = e
    const decision = await $.tool.check({ tool: 'Bash', input })
    if (decision.decision === 'deny') return { deny: decision.reason ?? 'denied by permission rules' }
    return next({ ...e, command: sandboxCommand($.plugin.root, agent.cwd, e.command) })
  }).catch(($, e, next) => e.agentId ? { deny: 'claudex: confinement check failed' } : next(e))
}
