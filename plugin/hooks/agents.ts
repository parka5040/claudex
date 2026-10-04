import type { EngineInterface, On } from 'claude-code'
import { contextCurrent, currentToken, isCurrent, live, onEnable, onPolicyChange, onSessionReady, onTick } from './jobs.ts'
import { READ_PROMPT, WRITE_PROMPT } from './prompts.ts'
import { admitRequest } from './worker.ts'

export type Tier = 'luna' | 'sol' | 'astra'
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
export type ClaudexAgent = {
  tier: Tier; cwd: string | null; prompt: string | null; mode: 'read' | 'edit'; model: string
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
let admission: Promise<void> = Promise.resolve()
let pending: Pick<ClaudexAgent, 'tier' | 'cwd' | 'prompt' | 'mode'> | null = null

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
  try { void contextCurrent().publishAgents(live.agents) }
  catch { /* Ownership is already known locally even if publishing fails. */ }
}
function mode(): 'read' | 'edit' { return live.status?.policy.CLAUDEX_WORKER_MODE === 'read' ? 'read' : 'edit' }
function enabled(tier: Tier): boolean {
  const policy = live.status?.policy
  if (policy?.CLAUDEX !== 'on') return false
  const configured = (policy.CLAUDEX_TIERS ?? '').split(',')
  return configured.includes(tier) || tier === 'sol' && configured.includes('terra')
}
function entry(tier: Tier, cwd: string | null, prompt: string | null, access = mode()): ClaudexAgent {
  return { tier, cwd, prompt, mode: access, model: `gpt-${tier}`, final: null, thinking: {} }
}
function discovered(tier: Tier): ClaudexAgent {
  return pending?.tier === tier ? entry(tier, pending.cwd, pending.prompt, pending.mode) : entry(tier, null, null)
}
export type AgentLookup = { kind: 'claudex'; agent: ClaudexAgent } | { kind: 'foreign' } | { kind: 'unknown' }
export async function lookupAgent($: EngineInterface, agentId: string): Promise<AgentLookup> {
  const found = agentFor(agentId)
  if (found) return { kind: 'claudex', agent: found }
  if (missing.has(agentId)) return { kind: 'foreign' }
  let knownTier: Tier | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = currentToken()
    try {
      const info = (await $.agent.list()).find(agent => agent.id === agentId && agent.status === 'running')
      knownTier = (info && tierOf(info.type)) || knownTier
      const current = agentFor(agentId)
      if (current) return { kind: 'claudex', agent: current }
      if (!isCurrent(token)) continue
      if (!knownTier) { missing.add(agentId); return { kind: 'foreign' } }
      const agent = discovered(knownTier)
      record(agentId, agent)
      return { kind: 'claudex', agent }
    } catch {
      if (!isCurrent(token)) continue
      if (!knownTier) return { kind: 'unknown' }
      const agent = discovered(knownTier)
      record(agentId, agent)
      return { kind: 'claudex', agent }
    }
  }
  return { kind: 'unknown' }
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
        tools: toolsFor(mode()), model: `gpt-${tier}`, effort: efforts[tier], maxTurns: 200,
      })
    }
    if (isCurrent(token)) registeredPolicy = signature
  }
  onEnable(registerEnabled)
  onPolicyChange(registerEnabled)
  onSessionReady(async () => { missing.clear() })
  onTick(async token => {
    const candidates = Object.entries(live.agents)
    if (!candidates.length) return
    const running = new Set((await contextCurrent().listAgents()).filter(agent =>
      agent.status === 'running' && tierOf(agent.type)).map(agent => agent.id))
    if (!isCurrent(token)) return
    const next = { ...live.agents }
    for (const [id, agent] of candidates) {
      if (!running.has(id) && next[id] === agent) delete next[id]
    }
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
    const previous = admission
    let unlock: () => void = () => {}
    const held = new Promise<void>(resolve => { unlock = resolve })
    // A timed-out waiter releases its own slot, never the earlier spawn's lock.
    admission = previous.then(() => held)
    try {
      let timedOut: () => void = () => {}
      const timeout = new Promise<boolean>(resolve => { timedOut = () => resolve(false) })
      const timer = $.clock.after(5000, timedOut)
      let acquired: boolean
      try { acquired = await Promise.race([previous.then(() => true), timeout]) }
      finally { timer.cancel() }
      if (!acquired) return { deny: 'claudex: another GPT agent spawn is in progress; retry' }
      if (next.signal.aborted) throw new Error('spawn cancelled')
      const token = currentToken()
      const running = (await $.agent.list()).filter(agent => agent.status === 'running' && tierOf(agent.type)).length
      if (!isCurrent(token)) throw new Error('activation changed during spawn')
      if (next.signal.aborted) throw new Error('spawn cancelled')
      const request = admitRequest($.plugin.root, tier, running)
      const result = await $.process.run(request.argv, request.init)
      if (!isCurrent(token)) throw new Error('activation changed during spawn')
      if (next.signal.aborted) throw new Error('spawn cancelled')
      if (result.exitCode !== 0) return { deny: result.stderr || `claudex-worker admit failed (${result.exitCode})` }
      pending = { tier, cwd: e.cwd ?? contextCurrent().cwd, prompt: e.prompt, mode: mode() }
      try {
        const agent = entry(tier, pending.cwd, pending.prompt, pending.mode)
        const spawned = await next({ ...e, model: `gpt-${tier}` })
        if (spawned.agentId && isCurrent(token)) {
          const prior = agentFor(spawned.agentId)
          record(spawned.agentId, { ...agent, final: prior?.final ?? agent.final,
            thinking: prior?.thinking ?? agent.thinking })
        }
        return spawned
      } finally { pending = null }
    } catch (error) {
      return { deny: `claudex: admission failed: ${error instanceof Error ? error.message : String(error)}` }
    } finally { unlock() }
  }).catch(() => ({ deny: 'claudex: admission failed' }))
}
