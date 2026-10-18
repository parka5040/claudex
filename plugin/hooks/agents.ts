import type { EngineInterface, On } from 'claude-code'
import { contextCurrent, currentToken, isCurrent, live, onEnable, onPolicyChange, onSessionReady, onTick, syncSessionCurrent } from './jobs.ts'
import { READ_PROMPT, WRITE_PROMPT } from './prompts.ts'
import { admitRequest, modelRequest } from './worker.ts'

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
  luna: 'Extraction, classification and summaries from an exact spec; not for writing code.',
  sol: 'All code writing: implementation, tests, refactors, mechanical edits and debugging.',
  astra: 'Architectural review and peer-level second opinions; not for writing code.',
}
const efforts: Record<Tier, string> = { luna: 'low', sol: 'high', astra: 'xhigh' }
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const ACTIVE = new Set(['pending', 'running', 'waiting'])
export const isLive = (status: string): boolean => LIVE.has(status)
export const isActive = (status: string): boolean => ACTIVE.has(status)
const SLUG = /^gpt-[a-z0-9][a-z0-9.-]{0,63}$/
export function modelLabel(tier: Tier, probeStdout: string): string {
  try {
    const parsed: unknown = JSON.parse(probeStdout.trim().split('\n').at(-1) ?? '')
    const model = parsed && typeof parsed === 'object' ? (parsed as { model?: unknown }).model : undefined
    if (typeof model === 'string' && SLUG.test(model)) return model
  } catch { /* no probed model */ }
  const known: unknown = live.status?.models?.[tier]
  return typeof known === 'string' && SLUG.test(known) ? known : `gpt-${tier}`
}
const RETAINED_MAX = 256
const resuming = new Set<string>()
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
  contextCurrent().agentsChanged()
}
async function record(agentId: string, agent: ClaudexAgent): Promise<void> {
  live.agents = { ...live.agents, [agentId]: agent }
  missing.delete(agentId)
  if (agent.cwd !== null) {
    live.retained = { ...live.retained, [agentId]: { tier: agent.tier, cwd: agent.cwd, mode: agent.mode, prompt: agent.prompt } }
    const keys = Object.keys(live.retained)
    for (const id of keys.slice(0, Math.max(0, keys.length - RETAINED_MAX))) delete live.retained[id]
  }
  try {
    const published = Promise.all([contextCurrent().publishAgents(live.agents), contextCurrent().publishRetained(live.retained)])
    contextCurrent().agentsChanged()
    await published
  } catch { /* Ownership is already known locally even if publishing fails. */ }
}
function restore(agentId: string, prior: ClaudexAgent | undefined): void {
  const next = { ...live.agents }
  if (prior) next[agentId] = prior
  else delete next[agentId]
  live.agents = next
  void contextCurrent().publishAgents(next)
  contextCurrent().agentsChanged()
}
function mode(): 'read' | 'edit' { return live.status?.policy.CLAUDEX_WORKER_MODE === 'read' ? 'read' : 'edit' }
function enabled(tier: Tier): boolean {
  const policy = live.status?.policy
  if (policy?.CLAUDEX !== 'on') return false
  const configured = (policy.CLAUDEX_TIERS ?? '').split(',')
  return configured.includes(tier) || tier === 'sol' && configured.includes('terra')
}
function entry(tier: Tier, cwd: string | null, prompt: string | null, access = mode(), model = `gpt-${tier}`): ClaudexAgent {
  return { tier, cwd, prompt, mode: access, model, final: null, thinking: {} }
}
function discovered(agentId: string, tier: Tier): ClaudexAgent {
  const kept = live.retained[agentId]
  if (kept) return entry(tier, kept.cwd, kept.prompt, kept.mode)
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
      const info = (await $.agent.list()).find(agent => agent.id === agentId && isLive(agent.status))
      knownTier = (info && tierOf(info.type)) || knownTier
      const current = agentFor(agentId)
      if (current) return { kind: 'claudex', agent: current }
      if (!isCurrent(token)) continue
      if (!knownTier) { missing.add(agentId); return { kind: 'foreign' } }
      const agent = discovered(agentId, knownTier)
      record(agentId, agent)
      return { kind: 'claudex', agent }
    } catch {
      if (!isCurrent(token)) continue
      if (!knownTier) return { kind: 'unknown' }
      const agent = discovered(agentId, knownTier)
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
    const candidates = Object.entries(live.agents).filter(([id]) => !resuming.has(id))
    if (!candidates.length) return
    const running = new Set((await contextCurrent().listAgents()).filter(agent =>
      isLive(agent.status) && tierOf(agent.type)).map(agent => agent.id))
    if (!isCurrent(token)) return
    const next = { ...live.agents }
    for (const [id, agent] of candidates) {
      if (!running.has(id) && !resuming.has(id) && next[id] === agent) delete next[id]
    }
    if (Object.keys(next).length !== Object.keys(live.agents).length) {
      live.agents = next
      void contextCurrent().publishAgents(next)
      contextCurrent().agentsChanged()
    }
  })
  on('agent.offer', { agent: /^claudex:gpt-/ }, ($, e, next) => {
    const tier = tierOf(e.agent)
    return tier && !enabled(tier) ? { isOffered: false } : next(e)
  })
  on('agent.spawn', { subagentType: /^claudex:gpt-/ }, async ($, e, next) => {
    const tier = tierOf(e.subagentType)
    if (!tier) return next(e)
    if (e.workflow) return { deny: `claudex: GPT agent types cannot run as Workflow agents; use claudex:relay-${tier} in Workflow scripts` }
    if (e.isTeammate) return { deny: 'claudex: GPT agent types cannot join a team yet; spawn them as subagents' }
    const token = await syncSessionCurrent()
    if (!isCurrent(token)) throw new Error('activation changed during spawn')
    if (next.signal.aborted) throw new Error('spawn cancelled')
    const id = e.resume?.agentId
    const resumeDeny = () => ({ deny: `claudex: cannot resume GPT agent ${id}: its confinement metadata is gone; spawn a new agent` })
    if (id !== undefined && !agentFor(id)?.cwd && !live.retained[id]) return resumeDeny()
    let label = `gpt-${tier}`
    if (!e.resume) {
      const request = modelRequest($.plugin.root, tier)
      const probe = await $.process.run(request.argv, request.init).catch(() => null)
      if (!isCurrent(token)) throw new Error('activation changed during spawn')
      if (next.signal.aborted) throw new Error('spawn cancelled')
      label = modelLabel(tier, probe?.exitCode === 0 ? probe.stdout : '')
    }
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
      if (!isCurrent(token)) throw new Error('activation changed during spawn')
      if (next.signal.aborted) throw new Error('spawn cancelled')
      const running = (await $.agent.list()).filter(agent => isActive(agent.status) && tierOf(agent.type)).length
      if (!isCurrent(token)) throw new Error('activation changed during spawn')
      if (next.signal.aborted) throw new Error('spawn cancelled')
      const request = admitRequest($.plugin.root, tier, running)
      const result = await $.process.run(request.argv, request.init)
      if (!isCurrent(token)) throw new Error('activation changed during spawn')
      if (next.signal.aborted) throw new Error('spawn cancelled')
      if (result.exitCode !== 0) return { deny: result.stderr || `claudex-worker admit failed (${result.exitCode})` }
      if (id !== undefined) {
        const prior = agentFor(id), kept = live.retained[id]
        const cwd = prior?.cwd ?? kept?.cwd
        if (!cwd) return resumeDeny()
        const access = mode() === 'read' || kept?.mode === 'read' || prior?.mode === 'read' ? 'read' : 'edit'
        const session = live.session
        resuming.add(id)
        try {
          await record(id, { ...entry(tier, cwd, prior ? prior.prompt : kept?.prompt ?? null, access, prior?.model ?? `gpt-${tier}`),
            thinking: prior?.thinking ?? {} })
          if (!isCurrent(token)) throw new Error('activation changed during spawn')
          if (next.signal.aborted) throw new Error('spawn cancelled')
          const resumed = await next(e)
          if (resumed.deny && live.session === session) restore(id, prior)
          return resumed
        } catch (error) { if (live.session === session) restore(id, prior); throw error }
        finally { resuming.delete(id) }
      }
      pending = { tier, cwd: e.cwd ?? contextCurrent().cwd, prompt: e.prompt, mode: mode() }
      try {
        const agent = entry(tier, pending.cwd, pending.prompt, pending.mode, label)
        const spawned = await next({ ...e, model: label })
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
