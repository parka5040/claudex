import { expect, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import type { ClaudexStatus } from '../types/index.d.ts'
import { live } from '../hooks/jobs.ts'
import { insideCwd, registerConfinement } from '../hooks/confine.ts'
import { resolveRequest, sandboxCommand } from '../hooks/worker.ts'
import { harness, stub } from './harness.ts'
import type { Harness } from './harness.ts'

const status: ClaudexStatus = {
  policy: { CLAUDEX: 'on', CLAUDEX_WORKER_MODE: 'edit', CLAUDEX_TIERS: 'sol' },
  policy_sources: { CLAUDEX: 'file' }, proxy: { up: false, ours: false, port: 18765 },
  token_hours_left: null, plan: null, models: null, deprecations: [],
}
const start = ($: Engine) => $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
const agent = (cwd: string | null = '/r', mode: 'read' | 'edit' = 'edit') => ({
  tier: 'sol' as const, cwd, prompt: null, mode, model: 'gpt-sol', final: null, thinking: {},
})
type Event = { tool: string; tool_use_id?: string; agentId?: string; file_path?: string; path?: string; pattern?: string;
  command?: string; timeout?: number; description?: string; run_in_background?: boolean; dangerouslyDisableSandbox?: boolean }
type Callback = ($: EngineInterface, e: Event, next: (e: Event) => Promise<{ result: string }>) =>
  { result?: string; deny?: string } | Promise<{ result?: string; deny?: string }>
function hooks() {
  const handlers = new Map<string, Callback>()
  const catches = new Map<string, Callback>()
  registerConfinement(((event: string, matcher: { tool: string | RegExp }, handler: Callback) => {
    expect(event).toBe('tool.call')
    const tool = typeof matcher.tool === 'string' ? matcher.tool : matcher.tool.source.slice(1, -1)
    handlers.set(tool, handler)
    return { catch: (handler: Callback) => { catches.set(tool, handler) } }
  }) as unknown as On)
  return { handlers, catches }
}
const next = async (e: Event) => ({ result: JSON.stringify(e) })
const engineFor = ($: Engine, h: Harness) => ({
  plugin: { root: h.root }, agent: { list: async () => h.opts.listAgents ? await h.opts.listAgents() : h.listed },
  tool: { check: (...args: Parameters<Engine['tool']['check']>) => $.tool.check(...args) },
  process: { run: async (...[argv, init]: Parameters<EngineInterface['process']['run']>) => {
    const call = { argv, init }
    h.calls.push(call)
    return h.opts.route ? await h.opts.route(call, h.clock) : stub('')
  } },
}) as unknown as EngineInterface

test('Bash preserves fields, checks original input without call metadata, then uses the trusted wrapper', async ($, on) => {
  harness(on, { status, jobs: [] })
  await start($)
  live.agents = { bashGpt: agent('/r/a b') }
  const input: Event = { tool: 'Bash', tool_use_id: 'toolu_original', agentId: 'bashGpt', command: "printf '%s' \"it's $HOME\"", timeout: 4000,
    description: 'Print a string', run_in_background: false, dangerouslyDisableSandbox: true }
  const checks: unknown[] = []
  const engine = { plugin: { root: '/plugin' }, tool: { check: async (e: unknown) => {
    checks.push(e); return { decision: 'allow' }
  } } } as unknown as EngineInterface
  expect(await hooks().handlers.get('Bash')!(engine, input, next)).toEqual({ result: JSON.stringify({ ...input,
    command: sandboxCommand('/plugin', '/r/a b', input.command!) }) })
  expect(checks).toEqual([{ tool: 'Bash', input: { command: input.command, timeout: 4000,
    description: input.description, run_in_background: false, dangerouslyDisableSandbox: true } }])
  expect(input.command).toBe("printf '%s' \"it's $HOME\"")
})

test('Bash original-command deny precheck stops before rewrite or forwarding', async ($, on) => {
  const h = harness(on, { status, jobs: [], check: { decision: 'deny', reason: 'prefix rule: touch' } })
  let forwards = 0
  const forward = async () => { forwards++; return { result: 'unexpected' } }
  await start($)
  live.agents = { deniedBash: agent() }
  const hook = hooks().handlers.get('Bash')!
  const engine = engineFor($, h)
  expect(await hook(engine, { tool: 'Bash', agentId: 'deniedBash', command: 'touch denied-marker', description: 'Original command' }, forward))
    .toEqual({ deny: 'prefix rule: touch' })
  expect(h.checks).toEqual([{ tool: 'Bash', input: { command: 'touch denied-marker', description: 'Original command' } }])
  h.opts.check = { decision: 'deny' }
  expect(await hook(engine, { tool: 'Bash', agentId: 'deniedBash', command: 'touch denied-marker' }, forward))
    .toEqual({ deny: 'denied by permission rules' })
  expect(forwards).toBe(0)
})

test('background, read-only, unknown and null-metadata GPT Bash fail closed', async ($, on) => {
  harness(on, { status, jobs: [] })
  await start($)
  live.agents = { editBash: agent(), readBash: agent('/r', 'read'), nullBash: agent(null) }
  const hook = hooks().handlers.get('Bash')!
  const forbidden = new Proxy({}, { get() { throw new Error('denied Bash used a capability') } }) as EngineInterface
  expect(await hook(forbidden, { tool: 'Bash', agentId: 'editBash', command: 'pwd', run_in_background: true }, next))
    .toEqual({ deny: 'claudex: background Bash is not available to GPT agents' })
  expect(await hook(forbidden, { tool: 'Bash', agentId: 'readBash', command: 'pwd' }, next))
    .toEqual({ deny: 'claudex: Bash is not available to read-only GPT agents' })
  expect(await hook(forbidden, { tool: 'Bash', agentId: 'nullBash', command: 'pwd' }, next))
    .toEqual({ deny: 'claudex: confinement metadata unavailable for nullBash' })
  const unknown = { agent: { list: async () => { throw new Error('unavailable') } } } as unknown as EngineInterface
  expect(await hook(unknown, { tool: 'Bash', agentId: 'unknown-bash', command: 'pwd' }, next))
    .toEqual({ deny: 'claudex: could not classify agent unknown-bash; retry' })
})

test('lexical path containment handles absolute, relative, dot segments and directory siblings', () => {
  for (const [path, allowed] of [
    ['/r/a', true], ['/r/../x', false], ['/r2', false], ['a/b', true], ['../x', false], ['/r', true],
    ['./sub/../a', true], ['/r/a/../../x', false], ['/r//a', true], ['/r/.', true],
  ] as const) expect(insideCwd('/r', path)).toBe(allowed)
})

test('file hooks apply lexical containment before resolve; defaults resolve the agent cwd', async ($, on) => {
  harness(on, { status, jobs: [] })
  await start($)
  live.agents = { sandboxed: agent() }
  const { handlers } = hooks()
  expect([...handlers.keys()]).toEqual(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'])
  const calls: unknown[] = []
  const engine = { plugin: { root: '/plugin' }, process: { run: async (argv: string[], init: unknown) => {
    calls.push({ argv, init }); return stub('')
  } } } as unknown as EngineInterface
  for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob']) {
    const key = tool === 'Grep' || tool === 'Glob' ? 'path' : 'file_path'
    const before = calls.length
    expect(await handlers.get(tool)!(engine, { tool, agentId: 'sandboxed', [key]: '../secret' }, next))
      .toEqual({ deny: `claudex: ${tool} outside /r refused` })
    expect(calls).toHaveLength(before)
    const inside = { tool, agentId: 'sandboxed', [key]: './a' }
    expect(await handlers.get(tool)!(engine, inside, next)).toEqual(await next(inside))
    expect(calls.at(-1)).toEqual(resolveRequest('/plugin', '/r', './a'))
  }
  for (const tool of ['Grep', 'Glob']) {
    const input = { tool, agentId: 'sandboxed' }
    expect(await handlers.get(tool)!(engine, input, next)).toEqual(await next(input))
    expect(calls.at(-1)).toEqual(resolveRequest('/plugin', '/r', '/r'))
  }
  expect(resolveRequest('/plugin', '/r', 'a')).toEqual({
    argv: ['/plugin/bin/claudex-worker', 'resolve', '--cwd', '/r', 'a'], init: { timeoutMs: 5000 },
  })
})

test('resolve allows inside, denies symlink bridges, bad input and worker rejection for every file tool', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  let forwards = 0
  const forward = async (e: Event) => { forwards++; return { result: e.tool } }
  await start($)
  live.agents = { resolved: agent() }
  const { handlers } = hooks()
  const engine = engineFor($, h)
  for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob']) {
    const key = tool === 'Grep' || tool === 'Glob' ? 'path' : 'file_path'
    const call = async () => await handlers.get(tool)!(engine, { tool, agentId: 'resolved', [key]: '/r/bridge/sentinel' }, forward)
    for (const code of [0, 3, 2, 126]) {
      h.opts.route = c => c.argv[1] === 'resolve' ? stub('', code) : stub('')
      const before = forwards
      const result = await call()
      if (code === 0) { expect(result.result).toBe(tool); expect(forwards).toBe(before + 1) }
      else {
        expect(result.deny).toBe(code === 3 ? `claudex: ${tool} target resolves outside /r` : `claudex: could not verify ${tool} path`)
        expect(forwards).toBe(before)
      }
      expect(h.calls.at(-1)?.argv.slice(1)).toEqual(['resolve', '--cwd', '/r', '/r/bridge/sentinel'])
    }
    h.opts.route = () => Promise.reject(new Error('resolve unavailable'))
    const before = forwards
    expect((await call()).deny).toBe(`claudex: could not verify ${tool} path`)
    expect(forwards).toBe(before)
  }
})

test('Glob rejects absolute patterns and parent path segments before running resolve', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  let forwards = 0
  const forward = async () => { forwards++; return { result: 'glob' } }
  await start($)
  live.agents = { globGpt: agent() }
  const hook = hooks().handlers.get('Glob')!
  const engine = engineFor($, h)
  const before = h.calls.length
  for (const pattern of ['/r/*.ts', '../*', '**/../*.ts', 'a/..']) {
    expect((await hook(engine, { tool: 'Glob', agentId: 'globGpt', pattern }, forward)).deny).toBeDefined()
  }
  expect(h.calls).toHaveLength(before)
  expect(forwards).toBe(0)
  expect((await hook(engine, { tool: 'Glob', agentId: 'globGpt', pattern: '**/file..ts' }, forward)).result).toBe('glob')
})

test('null-cwd and unregistered GPT file calls deny without guessing the session cwd', async ($, on) => {
  const h = harness(on, { status, jobs: [], listed: [
    { id: 'unregistered', type: 'claudex:gpt-sol', status: 'running', description: 'GPT' },
  ] })
  let forwards = 0
  const forward = async () => { forwards++; return { result: 'unexpected' } }
  await start($)
  live.agents = { nullFiles: agent(null) }
  const { handlers } = hooks()
  const engine = engineFor($, h)
  const before = h.calls.length
  for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob']) {
    expect((await handlers.get(tool)!(engine, { tool, agentId: 'nullFiles', file_path: '/r/file', path: '/r', pattern: '*' }, forward)).deny)
      .toBe('claudex: confinement metadata unavailable for nullFiles')
  }
  expect((await handlers.get('Read')!(engine, { tool: 'Read', agentId: 'unregistered', file_path: '/r/file' }, forward)).deny)
    .toBe('claudex: confinement metadata unavailable for unregistered')
  expect(h.calls).toHaveLength(before)
  h.opts.listAgents = async () => { throw new Error('unavailable') }
  expect((await handlers.get('Read')!(engine, { tool: 'Read', agentId: 'not-classified', file_path: '/r/file' }, forward)).deny)
    .toBe('claudex: could not classify agent not-classified; retry')
  expect(forwards).toBe(0)
})

test('all six confinement catches deny agent calls and replay main-loop calls unchanged', async () => {
  const { catches } = hooks()
  expect([...catches.keys()]).toEqual(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'])
  const forbidden = new Proxy({}, { get() { throw new Error('catch used a capability') } }) as EngineInterface
  for (const [tool, handler] of catches) {
    expect(await handler(forbidden, { tool, agentId: 'any-agent' }, next)).toEqual({ deny: 'claudex: confinement check failed' })
    const input = { tool }
    expect(await handler(forbidden, input, next)).toEqual(await next(input))
  }
})

test('main-loop and foreign calls pass through unchanged without confinement capabilities', async ($, on) => {
  harness(on, { status, jobs: [] })
  await start($)
  const { handlers } = hooks()
  const forbidden = new Proxy({}, { get() { throw new Error('unexpected capability call') } }) as EngineInterface
  let lookups = 0
  const foreign = { agent: { list: async () => { lookups++; return [
    { id: 'native-agent', type: 'general-purpose', status: 'running', description: 'native' },
  ] } } } as unknown as EngineInterface
  for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']) {
    const input = { tool, file_path: '/outside', path: '/outside', pattern: '../*', command: 'pwd', run_in_background: true }
    expect(await handlers.get(tool)!(forbidden, input, next)).toEqual(await next(input))
    const other = { ...input, agentId: 'native-agent' }
    expect(await handlers.get(tool)!(foreign, other, next)).toEqual(await next(other))
    expect(await handlers.get(tool)!(forbidden, other, next)).toEqual(await next(other))
  }
  expect(lookups).toBe(1)
})
