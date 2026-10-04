import type { EngineInterface, On } from 'claude-code'
import { contextCurrent, currentToken, isCurrent, live, onEnable, onPolicyChange, onSessionReady, onTick } from './jobs.ts'
import { READ_PROMPT, WRITE_PROMPT } from './prompts.ts'
import { admitRequest } from './worker.ts'

export type Tier = 'luna' | 'sol' | 'astra'
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
export type ClaudexAgent = {
  tier: Tier; cwd: string; prompt: string | null; mode: 'read' | 'edit'; model: string
  final: string | null
  thinking: Record<string, ThinkingBlock[]>
}
export const AGENT_PREFIX = 'claudex:gpt-'
const tiers: Tier[] = ['luna', 'sol', 'astra']
const descriptions: Record<Tier, string> = {
  luna: 'Bulk mechanical work from an exact spec.',
  sol: 'Complex multi-file implementation and debugging.',
  astra: 'The hardest problems and peer-level second opinions.',
}
const efforts: Record<Tier, string> = { luna: 'low', sol: 'high', astra: 'xhigh' }
const missing = new Set<string>()

export function tierOf(type: string): Tier | null {
  const name = type.startsWith(AGENT_PREFIX) ? type.slice(AGENT_PREFIX.length) : ''
  return tiers.includes(name as Tier) ? name as Tier : null
}
export const agentFor = (agentId: string): ClaudexAgent | undefined => live.agents[agentId]
export function changeAgent(agentId: string, fn: (a: ClaudexAgent) => ClaudexAgent | null): void {
  const current = live.agents[agentId]
  if (!current) return
  const updated = fn(current)
  if (updated === current) return
  const next = { ...live.agents }
  if (updated) next[agentId] = updated
  else delete next[agentId]
  live.agents = next
  void contextCurrent().publishAgents(next)
}
function record(agentId: string, agent: ClaudexAgent): void {
  live.agents = { ...live.agents, [agentId]: agent }
  missing.delete(agentId)
  void contextCurrent().publishAgents(live.agents)
}
function mode(): 'read' | 'edit' { return live.status?.policy.CLAUDEX_WORKER_MODE === 'read' ? 'read' : 'edit' }
function enabled(tier: Tier): boolean {
  const policy = live.status?.policy
  if (policy?.CLAUDEX !== 'on') return false
  const configured = (policy.CLAUDEX_TIERS ?? '').split(',')
  return configured.includes(tier) || tier === 'sol' && configured.includes('terra')
}
function entry(tier: Tier, cwd: string, prompt: string | null): ClaudexAgent {
  return { tier, cwd, prompt, mode: mode(), model: `gpt-${tier}`, final: null, thinking: {} }
}
export async function lookupAgent($: EngineInterface, agentId: string): Promise<ClaudexAgent | null> {
  const found = agentFor(agentId)
  if (found) return found
  if (missing.has(agentId)) return null
  const token = currentToken()
  const info = (await $.agent.list()).find(agent => agent.id === agentId && agent.status === 'running')
  if (!isCurrent(token)) return null
  const tier = info && tierOf(info.type)
  if (!tier) { missing.add(agentId); return null }
  const agent = entry(tier, contextCurrent().cwd, null)
  record(agentId, agent)
  return agent
}
export const systemPrompt = (agent: ClaudexAgent): string => agent.mode === 'read' ? READ_PROMPT : WRITE_PROMPT
export const toolsFor = (access: 'read' | 'edit'): string[] =>
  access === 'read' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']

export function registerAgents(on: On): void {
  let registeredPolicy = ''
  async function registerEnabled(): Promise<void> {
    if (!live.on) return
    const token = currentToken()
    const signature = `${mode()}:${live.status?.policy.CLAUDEX_TIERS ?? ''}`
    if (signature === registeredPolicy) return
    for (const tier of tiers) {
      if (!isCurrent(token)) return
      if (!enabled(tier)) continue
      await contextCurrent().registerAgent({
        name: `gpt-${tier}`,
        description: `${descriptions[tier]} Runs on GPT through claudex; use only when the claudex policy or the user permits GPT.`,
        prompt: mode() === 'read' ? READ_PROMPT : WRITE_PROMPT,
        tools: toolsFor(mode()), model: `gpt-${tier}`, effort: efforts[tier],
      })
    }
    if (isCurrent(token)) registeredPolicy = signature
  }
  onEnable(registerEnabled)
  onPolicyChange(registerEnabled)
  onSessionReady(async () => { missing.clear() })
  onTick(async token => {
    if (!Object.keys(live.agents).length) return
    const running = new Set((await contextCurrent().listAgents()).filter(agent =>
      agent.status === 'running' && tierOf(agent.type)).map(agent => agent.id))
    if (!isCurrent(token)) return
    const next = Object.fromEntries(Object.entries(live.agents).filter(([id]) => running.has(id)))
    if (Object.keys(next).length !== Object.keys(live.agents).length) {
      live.agents = next
      void contextCurrent().publishAgents(next)
    }
  })
  on('agent.offer', { agent: /^claudex:gpt-/ }, ($, e, next) => {
    const tier = tierOf(e.agent)
    return tier && !enabled(tier) ? { isOffered: false } : next(e)
  })
  on('agent.spawn', { subagentType: /^claudex:gpt-/ }, async ($, e, next) => {
    const tier = tierOf(e.subagentType)
    if (!tier) return next(e)
    const token = currentToken()
    const running = (await $.agent.list()).filter(agent => agent.status === 'running' && tierOf(agent.type)).length
    if (!isCurrent(token)) return { deny: 'claudex: activation changed during spawn' }
    const request = admitRequest($.plugin.root, tier, running)
    const result = await $.process.run(request.argv, request.init)
    if (!isCurrent(token)) return { deny: 'claudex: activation changed during spawn' }
    if (result.exitCode !== 0) return { deny: result.stderr || `claudex-worker admit failed (${result.exitCode})` }
    const spawned = await next(e)
    if (spawned.agentId && isCurrent(token)) record(spawned.agentId, entry(tier, e.cwd ?? contextCurrent().cwd, e.prompt))
    return spawned
  })
}
