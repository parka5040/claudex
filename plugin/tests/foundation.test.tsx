import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ClaudexJob, ClaudexStatus } from '../types/index.d.ts'
import { statusLine } from '../hooks/jobs.ts'
import { harness, stub } from './harness.ts'

const status = (): ClaudexStatus => ({
  policy: {
    CLAUDEX: 'on', CLAUDEX_DELEGATION: 'on-request', CLAUDEX_ADVERSARY: 'on-request',
    CLAUDEX_TIERS: 'luna,terra,sol,astra', CLAUDEX_DEFAULT_WORKER: 'terra',
    CLAUDEX_ADVERSARY_MODEL: 'gpt-6-astra@xhigh', CLAUDEX_MAX_PARALLEL: '4',
    CLAUDEX_WORKER_MODE: 'edit',
  },
  policy_sources: {
    CLAUDEX: 'default', CLAUDEX_DELEGATION: 'default', CLAUDEX_ADVERSARY: 'default',
    CLAUDEX_TIERS: 'default', CLAUDEX_DEFAULT_WORKER: 'default',
    CLAUDEX_ADVERSARY_MODEL: 'default', CLAUDEX_MAX_PARALLEL: 'default',
    CLAUDEX_WORKER_MODE: 'default',
  },
  proxy: { up: false, ours: false, port: 18765 },
  token_hours_left: 120, plan: { used_pct: 34, limit: 'weekly', age_s: 8 },
  models: null, deprecations: [],
})
const job = (id: string, state: ClaudexJob['state'] = 'running'): ClaudexJob => ({
  id, tier: 'sol', kind: 'worker', model: 'gpt-6-sol@high', mode: 'edit',
  cwd: '/repo/tree', origin: 'bash', owner: null, state, started: 1_790_000_000,
  elapsed_s: 63, rc: state === 'running' ? null : 0, session: null,
  has_findings: false, findings_error: null, legacy: false,
})
const start = async ($: Engine) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}
const command = ($: Engine, args = '') => $.command.run({
  command: 'claudex', args, origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
})

test('status line formats idle, running, stale, low login, missing, and occupied port', () => {
  const s = status()
  expect(statusLine(s, [])).toBe('idle · usage 34% · login 5d')
  expect(statusLine(s, [job('a'), job('b'), job('c', 'done')])).toBe('2 running · usage 34% · login 5d')
  s.token_hours_left = 5
  expect(statusLine(s, [])).toBe('idle · usage 34% · login 5h!')
  s.plan = { used_pct: 34, limit: 'weekly', age_s: 3601 }
  expect(statusLine(s, [])).toBe('idle · usage ? · login 5h!')
  s.plan = null
  s.token_hours_left = null
  expect(statusLine(s, [])).toBe('idle')
  s.proxy = { up: true, ours: false, port: 18765 }
  expect(statusLine(s, [])).toBe('port taken')
  expect(statusLine(null, [])).toBeUndefined()
  s.policy.CLAUDEX = 'off'
  expect(statusLine(s, [])).toBeUndefined()
})

test('polls every two seconds while running and every 60 seconds when idle; warns once', async ($, on) => {
  const opts = { status: status(), jobs: [job('123-abcdef12')] }
  opts.status.token_hours_left = 5
  opts.status.plan = { used_pct: 96, limit: 'weekly', age_s: 0 }
  const h = harness(on, opts)
  await start($)
  expect(h.commands).toEqual(['claudex'])
  expect(h.statuses.at(-1)).toBe('idle · usage 96% · login 5h!')
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(1)
  expect(h.statuses.at(-1)).toContain('1 running')
  expect(h.toasts.filter(t => t.includes('login'))).toHaveLength(1)
  expect(h.toasts.filter(t => t.includes('80'))).toHaveLength(1)
  expect(h.toasts.filter(t => t.includes('95'))).toHaveLength(1)
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(2)
  h.opts.jobs = []
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(3)
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(3)
  await h.clock.advance(58_000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(4)
  expect(h.toasts.filter(t => t.includes('login'))).toHaveLength(1)
})

test('a slow poll stays single-flight and a late result cannot undo off', async ($, on) => {
  let release: ((result: ReturnType<typeof stub>) => void) | undefined
  const opts = { status: status(), jobs: [] as ClaudexJob[], route: async (c: { argv: readonly string[] }) => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(opts.status))
    if (c.argv[1] === 'set') return stub('')
    if (c.argv[1] === 'jobs') return release ? stub('[]') : new Promise<ReturnType<typeof stub>>(resolve => { release = resolve })
    return stub('')
  } }
  const h = harness(on, opts)
  await start($)
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(1)
  await h.clock.advance(6000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(1)
  opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  const count = h.statuses.length
  release?.(stub(JSON.stringify([job('late-abcdef12')])))
  await h.clock.settle()
  expect(h.statuses.length).toBe(count)
  expect(h.statuses.at(-1)).toBeUndefined()
  await h.clock.advance(60000)
  // Off performs one recovery poll after the old single-flight call releases.
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(2)
})

test('a status refresh observes an external off switch and stops polling', async ($, on) => {
  const s = status()
  const h = harness(on, { status: s, jobs: [job('123-abcdef12')] })
  await start($)
  await h.clock.advance(2000)
  s.policy.CLAUDEX = 'off'
  await h.clock.advance(30000)
  expect(h.calls.filter(c => c.argv[1] === 'status')).toHaveLength(4)
  expect(h.statuses.at(-1)).toBeUndefined()
  const jobsSeen = h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit')).length
  await h.clock.advance(120000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(jobsSeen)
})

test('cold off registers only command; config on/off re-arms and effective change adds context', async ($, on) => {
  const s = status()
  s.policy.CLAUDEX = 'off'
  const h = harness(on, { status: s, jobs: [] })
  await start($)
  expect(h.commands).toEqual(['claudex'])
  expect(h.tools).toHaveLength(0)
  expect(h.statuses).toHaveLength(0)
  await h.clock.advance(120000)
  // One startup reconciliation is permitted while off, but no timer fires.
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(1)
  h.opts.route = c => {
    if (c.argv[1] === 'set') { s.policy.CLAUDEX = c.argv[3] ?? 'off'; return stub('') }
    if (c.argv[1] === 'status') return stub(JSON.stringify(s))
    if (c.argv[1] === 'jobs') return stub('[]')
    return stub('')
  }
  const enabled = await command($, 'config CLAUDEX on')
  expect(enabled.context).toEqual(['claudex policy changed: CLAUDEX=on. This overrides the session-start policy line for the rest of this session.'])
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(2)
  const disabled = await command($, 'config CLAUDEX off')
  expect(disabled.context).toHaveLength(1)
  expect(h.statuses.at(-1)).toBeUndefined()
  await h.clock.advance(120000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(3)
  await command($, 'config CLAUDEX on')
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv[1] === 'jobs' && c.argv.includes('--limit'))).toHaveLength(4)
})

test('status shows resolved models and deprecation notes from worker status JSON', async ($, on) => {
  const s = status()
  s.models = { luna: 'gpt-6-luna', sol: 'gpt-6.1-sol', astra: 'gpt-6-astra',
    terra: 'gpt-6.1-sol', source: 'backend', fetched_age_s: 28 }
  s.deprecations = ['terra is deprecated (served by sol)']
  harness(on, { status: s, jobs: [] })
  await start($)
  const response = await command($, 'status')
  expect(response.text).toContain('Models: luna=gpt-6-luna sol=gpt-6.1-sol astra=gpt-6-astra (backend)')
  expect(response.text).toContain('terra is deprecated (served by sol)')
  s.models = null
  s.deprecations = []
  const missing = await command($, 'status')
  expect(missing.text).not.toContain('Models:')
  expect(missing.text).not.toContain('terra is deprecated')
})

test('config shows policy sources, writes argv, distinguishes env shadowing, and rejects unknown', async ($, on) => {
  const s = status()
  s.policy_sources.CLAUDEX_MAX_PARALLEL = 'env'
  const h = harness(on, { status: s, jobs: [job('new-abcdef12', 'done')] })
  await start($)
  const overview = await command($)
  expect(overview.text).toContain('CLAUDEX')
  expect(overview.text).toContain('new-abcdef12')
  const config = await command($, 'config')
  expect(config.text).toContain('CLAUDEX_MAX_PARALLEL')
  expect(config.text).toContain('env')
  expect(config.text).toContain('extra workers queue')
  const shadowed = await command($, 'config CLAUDEX_MAX_PARALLEL 8')
  expect(h.calls.at(-2)?.argv.slice(1)).toEqual(['set', 'CLAUDEX_MAX_PARALLEL', '8'])
  expect(shadowed.text).toContain("environment sets CLAUDEX_MAX_PARALLEL=4 which wins")
  expect(shadowed.context).toBeUndefined()
  h.opts.route = c => {
    if (c.argv[1] === 'set') { s.policy.CLAUDEX_MAX_PARALLEL = '8'; s.policy_sources.CLAUDEX_MAX_PARALLEL = 'file'; return stub('') }
    if (c.argv[1] === 'status') return stub(JSON.stringify(s))
    return stub('[]')
  }
  const changed = await command($, 'config CLAUDEX_MAX_PARALLEL 8')
  expect(changed.context).toHaveLength(1)
  expect(changed.context?.[0]).toContain('CLAUDEX_MAX_PARALLEL=8')
  h.opts.route = call => call.argv[1] === 'set' ? stub('', 4, 'invalid setting') : stub(JSON.stringify(s))
  const refused = await command($, 'config CLAUDEX_MAX_PARALLEL bad')
  expect(refused.text).toBe('invalid setting')
  expect(refused.context).toBeUndefined()
  expect((await command($, 'not-a-command')).text).toContain('Usage:')
  expect(h.calls.every(c => c.argv[0]?.endsWith('/bin/claudex-worker') && !c.argv.includes('yolo') && typeof c.init?.timeoutMs === 'number')).toBe(true)
})

test('workers command opens pane and terminal/desktop buttons cancel, show report and close', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job('100-abcdef12'), job('101-abcdef12', 'done')] })
  await start($)
  await h.clock.advance(2000)
  const opened = await command($, 'workers')
  expect(opened.text).toBe('Workers pane opened.')
  expect(h.opened).toContain('claudex-workers')
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'claudex', surface, component: 'Pane', requestId: 'claudex-workers',
      props: { title: 'claudex workers', isFocused: true, bodyColumns: 70, placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect((await pane.find({ type: 'Text', text: /gpt-6-sol@high/ })), `missing job row: ${JSON.stringify(await pane.drawn())}`).toBeDefined()
    expect((await pane.find({ key: 'cancel-100-abcdef12' })), `missing cancel button: ${JSON.stringify(await pane.drawn())}`).toBeDefined()
    await pane.press({ key: 'cancel-100-abcdef12' })
    expect(h.calls.some(c => c.argv.slice(1).join(' ') === 'cancel 100-abcdef12')).toBe(true)
    await pane.press({ key: 'report-101-abcdef12' })
    await pane.redraw()
    expect((await pane.find({ type: 'Markdown', text: /Worker report from stub/ })), `missing report: ${JSON.stringify(await pane.drawn())}`).toBeDefined()
    await pane.press({ key: 'close' })
    expect(h.closed.at(-1)).toBe('claudex-workers')
    await pane.unmount()
  }
  expect(h.calls.every(c => !c.argv.includes('yolo') && typeof c.init?.timeoutMs === 'number')).toBe(true)
})
