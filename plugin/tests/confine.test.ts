import { expect, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import type { ClaudexStatus } from '../types/index.d.ts'
import { live } from '../hooks/jobs.ts'
import { insideCwd, registerConfinement } from '../hooks/confine.ts'
import { harness } from './harness.ts'

const status: ClaudexStatus = {
  policy: { CLAUDEX: 'on', CLAUDEX_WORKER_MODE: 'edit', CLAUDEX_TIERS: 'sol' },
  policy_sources: { CLAUDEX: 'file' }, proxy: { up: false, ours: false, port: 18765 },
  token_hours_left: null, plan: null,
}
const start = ($: Engine) => $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })

test('lexical path containment handles absolute, relative, dot segments and directory siblings', () => {
  for (const [path, allowed] of [
    ['/r/a', true], ['/r/../x', false], ['/r2', false], ['a/b', true], ['../x', false], ['/r', true],
    ['./sub/../a', true], ['/r/a/../../x', false], ['/r//a', true], ['/r/.', true],
  ] as const) expect(insideCwd('/r', path)).toBe(allowed)
})

test('path rule denies each out-of-tree tool and passes in-tree and default paths unchanged', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  await start($)
  live.agents = { sandboxed: { tier: 'sol', cwd: '/r', prompt: null, mode: 'edit', model: 'gpt-sol', final: null, thinking: {} } }
  type Event = { tool: string; agentId?: string; file_path?: string; path?: string }
  type Callback = ($: EngineInterface, e: Event, next: (e: Event) => Promise<{ result: string }>) => Promise<unknown>
  const handlers = new Map<string, Callback>()
  const capture = ((event: string, matcher: { tool: string | RegExp }, handler: Callback) => {
    expect(event).toBe('tool.call')
    handlers.set(typeof matcher.tool === 'string' ? matcher.tool : matcher.tool.source.slice(1, -1), handler)
  }) as unknown as On
  registerConfinement(capture)
  expect([...handlers.keys()]).toEqual(['Read', 'Write', 'Edit', 'Grep', 'Glob'])
  let forwards = 0
  const next = async (e: Event) => { forwards++; return { result: JSON.stringify(e) } }
  const noOps = {} as EngineInterface
  for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob']) {
    const key = tool === 'Grep' || tool === 'Glob' ? 'path' : 'file_path'
    const outside = { tool, agentId: 'sandboxed', [key]: '../secret' }
    expect(await handlers.get(tool)!(noOps, outside, next)).toEqual({ deny: `claudex: ${tool} outside /r refused` })
    expect(forwards).toBe(['Read', 'Write', 'Edit', 'Grep', 'Glob'].indexOf(tool))
    const inside = { tool, agentId: 'sandboxed', [key]: './a' }
    expect(await handlers.get(tool)!(noOps, inside, next)).toEqual({ result: JSON.stringify(inside) })
  }
  for (const tool of ['Grep', 'Glob']) {
    const noPath = { tool, agentId: 'sandboxed' }
    expect(await handlers.get(tool)!(noOps, noPath, next)).toEqual({ result: JSON.stringify(noPath) })
  }
  expect(forwards).toBe(7)
  expect(h.calls.filter(c => c.argv[1] === 'admit')).toHaveLength(0)
  live.agents = {}
})

test('foreign agent and main-loop tool calls pass unchanged and do not call engine capabilities', async ($, on) => {
  harness(on, { status, jobs: [] })
  await start($)
  type Event = { tool: string; agentId?: string; file_path?: string; path?: string }
  type Callback = ($: EngineInterface, e: Event, next: (e: Event) => Promise<{ result: string }>) => Promise<unknown>
  const handlers = new Map<string, Callback>()
  registerConfinement(((event: string, matcher: { tool: string | RegExp }, handler: Callback) => {
    handlers.set(typeof matcher.tool === 'string' ? matcher.tool : matcher.tool.source.slice(1, -1), handler)
  }) as unknown as On)
  const next = async (e: Event) => ({ result: JSON.stringify(e) })
  const noOps = new Proxy({}, { get: () => { throw Error('unexpected capability call') } }) as EngineInterface
  for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob']) {
    const key = tool === 'Grep' || tool === 'Glob' ? 'path' : 'file_path'
    for (const agentId of [undefined, 'native-agent']) {
      const input = { tool, agentId, [key]: '/outside' }
      expect(await handlers.get(tool)!(noOps, input, next)).toEqual({ result: JSON.stringify(input) })
    }
  }
})
