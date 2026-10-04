import { expect, test } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, EngineInterface, On, ToolCallInput, ToolCallResult } from 'claude-code'
import { registerConfinement } from '../hooks/confine.ts'
import type { Engine } from 'claude-code/testing'
import type { ClaudexStatus } from '../types/index.d.ts'
import { lookupAgent, registerAgents, tierOf, toolsFor } from '../hooks/agents.ts'
import type { ClaudexAgent } from '../hooks/agents.ts'
import { live } from '../hooks/jobs.ts'
import { admitRequest, sandboxCommand, shellQuote, stepArgv } from '../hooks/worker.ts'
import { READ_PROMPT, WRITE_PROMPT } from '../hooks/prompts.ts'
import { harness, stub } from './harness.ts'

const status = (switchOn = true, tiers = 'luna,sol,astra', mode = 'edit'): ClaudexStatus => ({
  policy: { CLAUDEX: switchOn ? 'on' : 'off', CLAUDEX_TIERS: tiers, CLAUDEX_WORKER_MODE: mode },
  policy_sources: { CLAUDEX: 'file', CLAUDEX_TIERS: 'file', CLAUDEX_WORKER_MODE: 'file' },
  proxy: { up: false, ours: false, port: 18765 }, token_hours_left: null, plan: null,
  models: null, deprecations: [],
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

test('shell quoting and sandbox command preserve literal arguments including empty and multiline strings', () => {
  for (const [input, quoted] of [
    ['a b', "'a b'"], ["it's", "'it'\\''s'"], ['$(x)', "'$(x)'"], [';rm -rf /', "';rm -rf /'"],
    ['a\nb', "'a\nb'"], ['', "''"],
  ] as const) {
    expect(shellQuote(input)).toBe(quoted)
    expect(quoted.slice(1, -1).replaceAll("'\\''", "'")).toBe(input)
    expect(sandboxCommand(input, input, input)).toBe(
      `/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash ${quoted.slice(0, -1)}/bin/claudex-worker' sandbox --cwd ${quoted} --path "$PATH" -c ${quoted}`)
  }
  expect(sandboxCommand('/plugin', '/repo', 'pwd')).toBe(`/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash '/plugin/bin/claudex-worker' sandbox --cwd '/repo' --path "$PATH" -c 'pwd'`)
})

test('agent type registration uses enabled tiers, GPT model aliases and mode-specific contracts', async ($, on) => {
  const s = status(true, 'luna,terra,astra', 'read')
  const h = harness(on, { status: s, jobs: [] })
  await start($)
  expect(h.agents.map(a => a.name)).toEqual(['gpt-luna', 'gpt-sol', 'gpt-astra'])
  for (const a of h.agents) {
    expect(a.model).toBe(`gpt-${a.name.slice(4)}`)
    expect(a).toMatchObject({ maxTurns: 200 })
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
  expect(h.agents.at(-1)).toMatchObject({ maxTurns: 200 })
  s.policy.CLAUDEX_TIERS = 'sol'
  await command($, 'CLAUDEX_TIERS', 'sol')
  expect(h.agents.at(-1)?.name).toBe('gpt-sol')
  expect(h.tools).toEqual(['review', 'verdict'])
})

test('both worker prompts end with the explicit handback instruction', () => {
  const sentence = ' When the task is finished (or cannot be finished), call the SubagentHandback tool once with your complete report as its message; that ends your work.'
  expect(READ_PROMPT.endsWith(sentence)).toBe(true)
  expect(WRITE_PROMPT.endsWith(sentence)).toBe(true)
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

test('explicit Claude model on a claudex spawn is replaced by the GPT fallback alias', async ($, on) => {
  harness(on, { status: status(), jobs: [] })
  const forwarded: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { forwarded.push(e); return { model: e.model ?? 'missing', agentId: 'spawn-override' } })
  await start($)
  const result = await $.agent.spawn({ subagentType: 'claudex:gpt-sol', model: 'sonnet', prompt: 'Build',
    description: 'build', tool_use_id: 'toolu_override', provider: { plugin: 'claudex', tier: 'user' },
    parentModel: 'claude-sonnet-4', background: false, fork: false })
  expect(result.model).toBe('gpt-sol')
  expect(forwarded[0]?.model).toBe('gpt-sol')
})

test('failed admission rejects launches and timeouts without forwarding the spawn', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [] })
  let forwards = 0
  on('agent.spawn', () => { forwards++; return { model: 'gpt-sol', agentId: 'unexpected' } })
  await start($)
  for (const reason of ['launch failed', 'timed out']) {
    h.opts.route = c => c.argv[1] === 'admit' ? Promise.reject(new Error(reason)) :
      c.argv[1] === 'status' ? stub(JSON.stringify(h.opts.status)) : stub('[]')
    expect((await spawn($, 'claudex:gpt-sol')).deny).toContain('claudex: admission failed:')
  }
  expect(forwards).toBe(0)
})

test('agent list failure denies admission instead of spawning', async ($, on) => {
  harness(on, { status: status(), jobs: [], listAgents: async () => { throw new Error('listing failed') } })
  let forwards = 0
  on('agent.spawn', () => { forwards++; return { model: 'gpt-sol', agentId: 'unexpected' } })
  await start($)
  expect((await spawn($, 'claudex:gpt-sol')).deny).toContain('claudex: admission failed:')
  expect(forwards).toBe(0)
})

test('concurrent native spawns serialize count, admit and next', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [], listed: [] })
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const forwarded: AgentSpawnInput[] = []
  h.opts.route = c => c.argv[1] === 'admit' ?
    Number(c.argv.at(-1)) === 0 ? stub('') : stub('', 4, 'parallel limit reached') :
    c.argv[1] === 'status' ? stub(JSON.stringify(h.opts.status)) : stub('[]')
  on('agent.spawn', async ($, e) => {
    forwarded.push(e)
    entered?.()
    await new Promise<void>(resolve => { release = resolve })
    h.listed.push({ id: 'admitted', type: 'claudex:gpt-sol', status: 'running', description: 'build' })
    return { model: e.model ?? 'missing', agentId: 'admitted' }
  })
  await start($)
  const first = spawn($, 'claudex:gpt-sol')
  await started
  const second = spawn($, 'claudex:gpt-sol')
  await h.clock.settle()
  expect(h.calls.filter(c => c.argv[1] === 'admit')).toHaveLength(1)
  release?.()
  const results = await Promise.all([first, second])
  expect(results).toEqual([{ model: 'gpt-sol', agentId: 'admitted' }, { deny: 'parallel limit reached' }])
  expect(forwarded).toHaveLength(1)
  expect(h.calls.filter(c => c.argv[1] === 'admit').map(c => c.argv.at(-1))).toEqual(['0', '1'])
})

test('spawn metadata preserves a step result recorded while next is still pending', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [], listed: [] })
  let release: (() => void) | undefined
  let ready: (() => void) | undefined
  const started = new Promise<void>(resolve => { ready = resolve })
  on('agent.spawn', async ($, e) => {
    h.listed.push({ id: 'early', type: 'claudex:gpt-sol', status: 'running', description: 'build' })
    ready?.()
    await new Promise<void>(resolve => { release = resolve })
    return { model: e.model ?? 'missing', agentId: 'early' }
  })
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'Build the module' }] }] }))
  on('tool.list', () => ({ value: [] }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: [
      { type: 'message_start', message: { model: 'gpt-6-sol' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'early result' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ].map(item => JSON.stringify(item)).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  await start($)
  const pending = spawn($, 'claudex:gpt-sol', '/repo/custom')
  await started
  try {
    const stream = $.turn.step({ turnId: 't-early', index: 0, model: 'gpt-sol', messageCount: 1, agentId: 'early' })
    for await (const _ of stream) { /* Consume the host chunks before the spawn returns. */ }
    expect((h.state.get('claudex:agents')?.value as Record<string, { final: string; cwd: string; prompt: string }>)['early'])
      .toMatchObject({ final: 'early result', cwd: '/repo/custom', prompt: 'Build the module', mode: 'edit' })
    // Direct-hook imports have their own live registry; use the authoritative early publication.
    live.agents = h.state.get('claudex:agents')?.value as Record<string, ClaudexAgent>
    let fileForwards = 0
    type Handler = ($: EngineInterface, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>) => Promise<ToolCallResult>
    const handlers = new Map<string, Handler>()
    registerConfinement(((event: string, matcher: { tool: string | RegExp }, handler: Handler) => {
      if (typeof matcher.tool === 'string') handlers.set(matcher.tool, handler)
      return { catch: () => {} }
    }) as unknown as On)
    const engine = { plugin: { root: h.root }, tool: { check: (...args: Parameters<Engine['tool']['check']>) => $.tool.check(...args) } } as unknown as EngineInterface
    const forward = async (e: ToolCallInput) => { fileForwards++; return { result: e.tool === 'Bash' ? e.command : 'unexpected' } }
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect((await handlers.get(tool)!(engine, { tool, agentId: 'early', file_path: '/repo/sibling/file' } as never, forward)).deny)
        .toBe(`claudex: ${tool} outside /repo/custom refused`)
    }
    expect((await handlers.get('Bash')!(engine, { tool: 'Bash', agentId: 'early', command: 'pwd' } as never, forward)).result)
      .toContain("sandbox --cwd '/repo/custom' --path")
    expect(fileForwards).toBe(1)
  } finally {
    release?.()
    await pending
  }
  expect((h.state.get('claudex:agents')?.value as Record<string, { final: string; cwd: string }>)['early'])
    .toMatchObject({ final: 'early result', cwd: '/repo/custom' })
})

test('a poll never prunes an agent recorded while its list request is pending', async ($, on) => {
  let release: ((value: AgentInfo[]) => void) | undefined
  let calls = 0
  const h = harness(on, { status: status(), jobs: [], listed: [], listAgents: () => {
    if (calls++ > 0) return Promise.resolve(h.listed)
    return new Promise(resolve => { release = resolve })
  } })
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'missing', agentId: 'new-agent' }))
  h.state.set('claudex:agents', { version: 1, value: { old: { tier: 'sol', cwd: '/repo/old', prompt: null,
    mode: 'edit', model: 'gpt-sol', final: null, thinking: {} } } })
  await start($)
  await h.clock.advance(2000)
  expect(calls).toBe(1)
  await spawn($, 'claudex:gpt-sol', '/repo/new')
  release?.([])
  await h.clock.settle()
  expect((h.state.get('claudex:agents')?.value as Record<string, { cwd: string }>)['new-agent']?.cwd).toBe('/repo/new')
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
  expect(await lookupAgent(engine, 'orphan')).toEqual({ kind: 'claudex', agent: saved })
  expect(lookups).toBe(0)
  expect(await lookupAgent(engine, 'missing')).toEqual({ kind: 'foreign' })
  expect(await lookupAgent(engine, 'missing')).toEqual({ kind: 'foreign' })
  expect(lookups).toBe(1)
  live.agents = {}
})

test('queued spawn waits at most five seconds and cannot release the earlier admission lock', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [] })
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  let forwards = 0
  on('agent.spawn', async ($, e) => {
    forwards++
    if (forwards === 1) {
      entered?.()
      await new Promise<void>(resolve => { release = resolve })
    }
    return { model: e.model ?? 'missing', agentId: 'slow-spawn' }
  })
  await start($)
  const first = spawn($, 'claudex:gpt-sol')
  await started
  try {
    let secondResult: unknown
    void spawn($, 'claudex:gpt-sol').then(result => { secondResult = result })
    await h.clock.settle()
    await h.clock.advance(5001)
    expect(secondResult).toEqual({ deny: 'claudex: another GPT agent spawn is in progress; retry' })
    const third = spawn($, 'claudex:gpt-sol')
    await h.clock.settle()
    await h.clock.advance(5001)
    expect(await third).toEqual({ deny: 'claudex: another GPT agent spawn is in progress; retry' })
    expect(forwards).toBe(1)
    expect(h.calls.filter(c => c.argv[1] === 'admit')).toHaveLength(1)
  } finally {
    release?.()
    await first
  }
})

test('spawn catch fails closed on hook failure', () => {
  type Handler = ($: EngineInterface, e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<unknown>) => unknown
  let caught: Handler | undefined
  registerAgents(((event: string) => ({ catch: (handler: Handler) => {
    if (event === 'agent.spawn') caught = handler
  } })) as unknown as On)
  expect(caught).toBeDefined()
  const forbidden = new Proxy({}, { get() { throw new Error('catch used a capability') } }) as EngineInterface
  expect(caught!(forbidden, {} as AgentSpawnInput, async () => { throw new Error('catch forwarded spawn') }))
    .toEqual({ deny: 'claudex: admission failed' })
})
