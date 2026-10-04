import { expect, test } from 'claude-code/testing'
import type { AgentSpawnInput, EngineInterface, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import type { ClaudexStatus } from '../types/index.d.ts'
import { lookupAgent, tierOf, toolsFor } from '../hooks/agents.ts'
import { live } from '../hooks/jobs.ts'
import { admitRequest, stepArgv } from '../hooks/worker.ts'
import { READ_PROMPT, WRITE_PROMPT } from '../hooks/prompts.ts'
import { harness, stub } from './harness.ts'

const status = (switchOn = true, tiers = 'luna,sol,astra', mode = 'edit'): ClaudexStatus => ({
  policy: { CLAUDEX: switchOn ? 'on' : 'off', CLAUDEX_TIERS: tiers, CLAUDEX_WORKER_MODE: mode },
  policy_sources: { CLAUDEX: 'file', CLAUDEX_TIERS: 'file', CLAUDEX_WORKER_MODE: 'file' },
  proxy: { up: false, ours: false, port: 18765 }, token_hours_left: null, plan: null,
})
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const command = ($: Engine, key: string, value: string) => $.command.run({
  command: 'claudex', args: `config ${key} ${value}`, origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 100 },
})
const spawn = ($: Engine, type: string, cwd?: string) => $.agent.spawn({
  subagentType: type, prompt: 'Build the module', description: 'build', cwd,
  tool_use_id: 'toolu_test', provider: { plugin: 'claudex', tier: 'user' },
  parentModel: 'claude-sonnet-4', background: false, fork: false,
})

test('agent type registration uses enabled tiers, GPT model aliases and mode-specific contracts', async ($, on) => {
  const s = status(true, 'luna,terra,astra', 'read')
  const h = harness(on, { status: s, jobs: [] })
  await start($)
  expect(h.agents.map(a => a.name)).toEqual(['gpt-luna', 'gpt-sol', 'gpt-astra'])
  for (const a of h.agents) {
    expect(a.model).toBe(`gpt-${a.name.slice(4)}`)
    expect(a.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(a.prompt).toBe(READ_PROMPT)
    expect(a.description).toContain('Runs on GPT through claudex; use only when the claudex policy or the user permits GPT.')
  }
  expect(h.agents.map(a => a.effort)).toEqual(['low', 'high', 'xhigh'])
  expect(tierOf('claudex:gpt-sol')).toBe('sol')
  expect(tierOf('claudex:gpt-terra')).toBeNull()
  expect(tierOf('not-claudex:gpt-sol')).toBeNull()
  expect(toolsFor('edit')).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'])
  s.policy.CLAUDEX_WORKER_MODE = 'edit'
  await command($, 'CLAUDEX_WORKER_MODE', 'edit')
  expect(h.agents.at(-1)?.tools).toEqual(toolsFor('edit'))
  expect(h.agents.at(-1)?.prompt).toBe(WRITE_PROMPT)
  s.policy.CLAUDEX_TIERS = 'sol'
  await command($, 'CLAUDEX_TIERS', 'sol')
  expect(h.agents.at(-1)?.name).toBe('gpt-sol')
  expect(h.tools).toEqual(['review', 'verdict'])
})

test('offer hides disabled and switched-off tiers; foreign offers pass through unmodified', async ($, on) => {
  const s = status(true, 'luna')
  const h = harness(on, { status: s, jobs: [] })
  const seen: string[] = []
  on('agent.offer', ($, e) => { seen.push(e.agent); return { isOffered: true } })
  await start($)
  const offer = (agent: string) => $.agent.offer({ agent, description: 'task', source: 'plugin', provider: { plugin: 'claudex', tier: 'user' } })
  expect(await offer('claudex:gpt-luna')).toEqual({ isOffered: true })
  expect(await offer('claudex:gpt-sol')).toEqual({ isOffered: false })
  expect(await offer('general-purpose')).toEqual({ isOffered: true })
  s.policy.CLAUDEX = 'off'
  await command($, 'CLAUDEX', 'off')
  expect(await offer('claudex:gpt-luna')).toEqual({ isOffered: false })
  expect(seen).toEqual(['claudex:gpt-luna', 'general-purpose'])
  expect(h.calls.every(c => c.argv[1] !== 'admit')).toBe(true)
})

test('admission forwards parallel count, denial stderr, and records a successful spawn with cwd fallback', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [], listed: [
    { id: 'live-1', type: 'claudex:gpt-luna', status: 'running', description: 'first' },
    { id: 'old', type: 'claudex:gpt-astra', status: 'completed', description: 'finished' },
    { id: 'other', type: 'general-purpose', status: 'running', description: 'other' },
  ] })
  const forwarded: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { forwarded.push(e); return { model: e.model ?? 'gpt-sol', agentId: `spawn-${forwarded.length}` } })
  await start($)
  h.opts.route = c => c.argv[1] === 'admit' ? stub('', 4, 'claudex: 4 GPT agents/workers already running (CLAUDEX_MAX_PARALLEL=4)') :
    c.argv[1] === 'status' ? stub(JSON.stringify(h.opts.status)) : stub('[]')
  const denied = await spawn($, 'claudex:gpt-sol')
  expect(denied).toEqual({ deny: 'claudex: 4 GPT agents/workers already running (CLAUDEX_MAX_PARALLEL=4)' })
  expect(forwarded).toHaveLength(0)
  expect(h.calls.at(-1)?.argv.slice(1)).toEqual(['admit', 'sol', '--running', '1'])
  expect(h.calls.at(-1)?.init?.timeoutMs).toBe(15000)
  h.opts.route = c => c.argv[1] === 'status' ? stub(JSON.stringify(h.opts.status)) : stub('')
  expect(await spawn($, 'claudex:gpt-sol')).toEqual({ model: 'gpt-sol', agentId: 'spawn-1' })
  expect(forwarded).toHaveLength(1)
  expect((h.state.get('claudex:agents')?.value as Record<string, { cwd: string }>)['spawn-1']).toMatchObject({ tier: 'sol', cwd: '/repo', prompt: 'Build the module', mode: 'edit', model: 'gpt-sol', final: null, thinking: {} })
  expect(await spawn($, 'claudex:gpt-sol', '/repo/tree')).toEqual({ model: 'gpt-sol', agentId: 'spawn-2' })
  expect((h.state.get('claudex:agents')?.value as Record<string, { cwd: string }>)['spawn-2']?.cwd).toBe('/repo/tree')
  expect(admitRequest('/plugin', 'sol', 3)).toEqual({ argv: ['/plugin/bin/claudex-worker', 'admit', 'sol', '--running', '3'], init: { timeoutMs: 15000 } })
  expect(stepArgv('/plugin', 'astra')).toEqual(['/plugin/bin/claudex-worker', 'step', 'astra'])
})

test('foreign spawn passes unchanged to next without listing agents or running worker', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [] })
  const forwarded: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { forwarded.push(e); return { model: 'native', agentId: 'native-1' } })
  await start($)
  const baseline = h.calls.length
  const result = await spawn($, 'general-purpose')
  expect(result).toEqual({ model: 'native', agentId: 'native-1' })
  expect(forwarded).toHaveLength(1)
  expect(forwarded[0]?.subagentType).toBe('general-purpose')
  expect(h.calls).toHaveLength(baseline)
  expect((h.state.get('claudex:agents')?.value as Record<string, unknown> | undefined)?.['native-1']).toBeUndefined()
})

test('published registry survives session startup and poll removes finished agents', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [], listed: [
    { id: 'keep', type: 'claudex:gpt-sol', status: 'running', description: 'running' },
    { id: 'finish', type: 'claudex:gpt-luna', status: 'running', description: 'running' },
  ] })
  const saved = (tier: 'luna' | 'sol') => ({ tier, cwd: '/repo', prompt: 'job', mode: 'read' as const,
    model: `gpt-${tier}`, final: null, thinking: {} })
  h.state.set('claudex:agents', { version: 1, value: { keep: saved('sol'), finish: saved('luna') } })
  await start($)
  expect((h.state.get('claudex:agents')?.value as Record<string, unknown>).keep).toEqual(saved('sol'))
  expect((h.state.get('claudex:agents')?.value as Record<string, unknown>).finish).toEqual(saved('luna'))
  expect(h.statuses.at(-1)).toContain('2 running')
  h.listed[1]!.status = 'completed'
  await h.clock.advance(2000)
  expect((h.state.get('claudex:agents')?.value as Record<string, unknown>).finish).toBeUndefined()
  expect((h.state.get('claudex:agents')?.value as Record<string, unknown>).keep).toBeDefined()
  expect(h.statuses.at(-1)).toContain('1 running')
  expect((h.state.get('claudex:agents')?.value as Record<string, unknown>).finish).toBeUndefined()
})

test('lookup returns a live entry synchronously and caches a foreign miss', async () => {
  const saved = { tier: 'astra' as const, cwd: '/repo', prompt: null, mode: 'edit' as const,
    model: 'gpt-astra', final: null, thinking: {} }
  live.agents = { orphan: saved }
  let lookups = 0
  const engine = { agent: { list: async () => { lookups++; return [{ id: 'missing', type: 'general-purpose', status: 'running' }] } } } as unknown as EngineInterface
  expect(await lookupAgent(engine, 'orphan')).toEqual(saved)
  expect(lookups).toBe(0)
  expect(await lookupAgent(engine, 'missing')).toBeNull()
  expect(await lookupAgent(engine, 'missing')).toBeNull()
  expect(lookups).toBe(1)
  live.agents = {}
})
