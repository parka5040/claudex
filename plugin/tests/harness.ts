import { mock } from 'claude-code/testing'
import type { AgentInfo, On, ProcessRunInit } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import type { ClaudexJob, ClaudexStatus } from '../types/index.d.ts'

export type Call = { argv: readonly string[]; init: ProcessRunInit | undefined }
export type StubRun = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
export type Harness = {
  clock: MockClock
  state: Map<string, { value: unknown; version: number }>
  gets: string[]
  calls: Call[]
  checks: { tool: string; input: unknown }[]
  stored: Map<string, unknown>
  root: string
  statuses: (string | undefined)[]
  toasts: string[]
  opened: string[]
  closed: string[]
  commands: string[]
  tools: string[]
  agents: { name: string; description: string; prompt: string; tools?: readonly string[]; model?: string; effort?: string | number }[]
  listed: AgentInfo[]
  submitted: string[]
  opts: Options
}
export type Options = {
  status: ClaudexStatus
  jobs: ClaudexJob[]
  listed?: AgentInfo[]
  sessionId?: string
  route?: (call: Call, clock: MockClock) => StubRun | Promise<StubRun>
  drop?: string
  check?: { decision: 'allow' | 'ask' | 'deny'; reason?: string }
  storeError?: boolean
  readState?: (key: string) => Promise<void>
  readStore?: (key: string) => Promise<void>
  readSession?: () => Promise<void>
  submit?: (text: string) => Promise<{ text: string } | { drop: string }>
}

export const stub = (stdout: string, exitCode = 0, stderr = ''): StubRun => ({
  stdout, exitCode, stderr, isStdoutTruncated: false, isStderrTruncated: false,
})

export function harness(on: On, opts: Options): Harness {
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const state = new Map<string, { value: unknown; version: number }>()
  const gets: string[] = []
  const calls: Call[] = []
  const checks: { tool: string; input: unknown }[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  const commands: string[] = []
  const tools: string[] = []
  const agents: Harness['agents'] = []
  const listed = opts.listed ?? []
  const submitted: string[] = []
  const stored = new Map<string, unknown>()
  let root = ''

  on('session.start', ($, e) => { root = $.plugin.root; return { cwd: e.cwd } })
  on('session.id', async () => { if (opts.readSession) await opts.readSession(); return { value: opts.sessionId ?? 'session-a' } })
  // The kit exposes no dispatch identity on state.get, so this stub cannot
  // freeze a per-dispatch snapshot. Correctness tests never rely on rereads.
  on('state.get', async ($, e) => {
    const key = `${e.plugin}:${e.key}`
    gets.push(key)
    if (opts.readState) await opts.readState(key)
    return { value: state.get(key) ?? { value: undefined, version: 0 } }
  })
  on('state.set', ($, e) => {
    const key = `${e.plugin}:${e.key}`
    const prev = state.get(key)
    const version = prev?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) {
      return { value: { isSet: false as const, version } }
    }
    state.set(key, { value: e.value, version: version + 1 })
    return { value: { isSet: true as const, version: version + 1 } }
  })
  on('store.get', async ($, e) => { if (opts.readStore) await opts.readStore(e.key); return { value: stored.get(e.key) } })
  on('store.set', ($, e) => { if (opts.storeError) throw new Error('store full'); stored.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($, e) => { stored.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  on('tool.register', ($, e) => { tools.push(e.name); return { value: { tool: `mcp__claudex__${e.name}` } } })
  on('agent.register', ($, e) => { agents.push(e); return { value: { agent: `claudex:${e.name}` } } })
  on('agent.list', () => ({ value: listed }))
  on('tool.check', ($, e) => { checks.push({ tool: e.tool, input: e.input }); return opts.check ?? { decision: 'allow' } })
  on('command.register', ($, e) => { commands.push(e.name); return { value: { command: e.name } } })
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.open', ($, e) => { opened.push(e.id); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { closed.push(e.id); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', async ($, e) => {
    submitted.push(e.text)
    return opts.submit ? await opts.submit(e.text) : opts.drop ? { drop: opts.drop } : { text: e.text }
  })
  on('process.run', async ($, e) => {
    const call: Call = { argv: [...e.argv], init: e.init }
    calls.push(call)
    if (opts.route) return { value: await opts.route(call, clock) }
    if (e.argv[1] === 'status') return { value: stub(JSON.stringify(opts.status)) }
    if (e.argv[1] === 'jobs') {
      const ids = e.argv.flatMap((x, i) => x === '--id' ? [e.argv[i + 1]] : []).filter((x): x is string => !!x)
      const owner = e.argv.includes('--owner') ? e.argv[e.argv.indexOf('--owner') + 1] : undefined
      const limit = Number(e.argv[e.argv.indexOf('--limit') + 1] ?? 20)
      return { value: stub(JSON.stringify(ids.length ? ids.map(id => opts.jobs.find(j => j.id === id) ?? { id, state: 'missing' }) :
        owner !== undefined ? opts.jobs.filter(j => j.owner === owner).slice(0, 500) : opts.jobs.slice(0, limit))) }
    }
    if (e.argv[1] === 'result') return { value: stub('Worker report from stub.') }
    if (e.argv[1] === 'cancel') return { value: stub(`cancelled ${e.argv[2]}`) }
    if (e.argv[1] === 'set') return { value: stub('') }
    return { value: stub('') }
  })
  return { clock, state, gets, calls, checks, stored, get root() { return root }, statuses, toasts, opened, closed, commands, tools, agents, listed, submitted, opts }
}
