import type { On } from 'claude-code'
import { agentFor } from './agents.ts'

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
function refusal(agentId: string | undefined, tool: string, path: string | undefined): { deny: string } | null {
  if (!agentId) return null
  const agent = agentFor(agentId)
  if (!agent || insideCwd(agent.cwd, path ?? agent.cwd)) return null
  return { deny: `claudex: ${tool} outside ${agent.cwd} refused` }
}

export function registerConfinement(on: On): void {
  on('tool.call', { tool: 'Read' }, ($, e, next) =>
    refusal(e.agentId, 'Read', e.file_path) ?? next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) =>
    refusal(e.agentId, 'Write', e.file_path) ?? next(e))
  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    refusal(e.agentId, 'Edit', e.file_path) ?? next(e))
  // Grep and Glob exist at runtime but are absent from the 2.1.288 tool type union.
  on('tool.call', { tool: /^Grep$/ }, ($, e, next) =>
    refusal(e.agentId, 'Grep', (e as { path?: string }).path) ?? next(e))
  on('tool.call', { tool: /^Glob$/ }, ($, e, next) =>
    refusal(e.agentId, 'Glob', (e as { path?: string }).path) ?? next(e))
}
