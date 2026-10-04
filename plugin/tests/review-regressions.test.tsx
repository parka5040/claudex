import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ClaudexJob, ClaudexOwned, ClaudexStatus, ClaudexReview } from '../types/index.d.ts'
import { harness, stub } from './harness.ts'

const ID = '1790000000-abcdef12'
const SECOND = '1790000001-abcdef12'
const status = (enabled = true): ClaudexStatus => ({
  policy: { CLAUDEX: enabled ? 'on' : 'off' }, policy_sources: { CLAUDEX: 'file' },
  proxy: { up: false, ours: false, port: 18765 }, token_hours_left: null, plan: null,
  models: null, deprecations: [],
})
const job = (id = ID, state: ClaudexJob['state'] = 'done'): ClaudexJob => ({
  id, tier: 'sol', kind: 'worker', model: 'gpt-6-sol@high', mode: 'read', cwd: '/repo',
  origin: 'mod', owner: 'session-a', state, started: 1790000000, elapsed_s: 1,
  rc: state === 'running' ? null : 0, session: null, has_findings: false, findings_error: null,
  legacy: false,
})
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) => $.command.run({
  command: 'claudex', args, origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
})
const owned = (h: ReturnType<typeof harness>) => h.state.get('claudex:owned')?.value as Record<string, ClaudexOwned>

test('a review wait returning after re-activation cannot return a second report', async ($, on) => {
  let release: ((value: ReturnType<typeof stub>) => void) | undefined
  const review = { ...job(ID, 'running'), tier: 'adversary', kind: 'adversary' as const }
  const h = harness(on, { status: status(), jobs: [review] })
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'start') return stub(ID)
    if (c.argv[1] === 'wait') return new Promise(resolve => { release = resolve })
    if (c.argv[1] === 'jobs') return stub(JSON.stringify(h.opts.jobs))
    if (c.argv[1] === 'findings') return stub('', 1)
    return stub('Review report from stub.')
  }
  await start($)
  const waiting = $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit', wait: true })
  await h.clock.settle()
  expect(owned(h)[ID]?.delivery).toBe('waiting')
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'config CLAUDEX on')
  h.opts.jobs = [{ ...review, state: 'done' }]
  await h.clock.advance(2000)
  expect(h.submitted).toHaveLength(1)
  release?.(stub('Review report from stub.'))
  const answer = await waiting
  expect(answer.isError).toBe(true)
  expect(String(answer.result)).toContain('activation changed')
  expect(h.submitted).toHaveLength(1)
})

// F9: one poll flag covers all generations, including an off/on while jobs is slow.
test('activation cannot overlap an in-flight poll from an older generation', async ($, on) => {
  let release: ((value: ReturnType<typeof stub>) => void) | undefined
  const h = harness(on, { status: status(), jobs: [] })
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'jobs' && c.argv.includes('--limit') && !release) {
      return new Promise(resolve => { release = resolve })
    }
    return stub('[]')
  }
  await start($)
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv.includes('--limit'))).toHaveLength(1)
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'config CLAUDEX on')
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv.includes('--limit'))).toHaveLength(1)
  release?.(stub('[]'))
  await h.clock.settle()
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv.includes('--limit'))).toHaveLength(2)
})

test('blocked initial state read cannot start overlapping polls', async ($, on) => {
  let block = false
  const readers: (() => void)[] = []
  let finishJobs: ((value: ReturnType<typeof stub>) => void) | undefined
  const h = harness(on, { status: status(), jobs: [],
    readState: key => key === 'claudex:generation' && block ? new Promise(resolve => { readers.push(resolve) }) : Promise.resolve(),
    route: c => c.argv[1] === 'status' ? stub(JSON.stringify(status())) :
      c.argv[1] === 'jobs' && c.argv.includes('--limit') ? new Promise(resolve => { finishJobs = resolve }) : stub('[]'),
  })
  await start($)
  block = true
  await h.clock.advance(2000)
  await h.clock.advance(2000)
  expect(h.calls.filter(c => c.argv.includes('--limit'))).toHaveLength(1)
  for (const resume of readers) resume()
  finishJobs?.(stub('[]'))
  await h.clock.settle()
  expect(h.gets.filter(key => key === 'claudex:generation')).toHaveLength(0)
})

// F10: display/status cache is not the pre-set effective policy or the activation latch.
test('external switch observed by status then config still synchronizes activation', async ($, on) => {
  const h = harness(on, { status: status(false), jobs: [] })
  await start($)
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'status')
  const enabled = await command($, 'config CLAUDEX on')
  expect(enabled.context).toBeUndefined()
  expect(h.tools).toEqual(['review', 'verdict'])
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'status')
  await command($, 'config CLAUDEX off')
  expect(h.statuses.at(-1)).toBeUndefined()
  expect((await $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit' })).isError).toBe(true)
})

test('config context describes the effective value, not the requested value', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [] })
  await start($)
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'set') { h.opts.status.policy.CLAUDEX = 'off'; return stub('') }
    if (c.argv[1] === 'jobs') return stub('[]')
    return stub('')
  }
  const response = await command($, 'config CLAUDEX on')
  expect(response.context?.[0]).toContain('CLAUDEX=off')
})

// F12: rows from old worker versions have null metadata; healthy rows must still draw.
test('workers pane renders legacy rows with unknown fields', async ($, on) => {
  const legacy: ClaudexJob = { ...job(), tier: null, model: null, mode: null, cwd: null, origin: null, started: null, elapsed_s: null, legacy: true }
  const h = harness(on, { status: status(), jobs: [legacy, job(SECOND)] })
  await start($)
  await h.clock.advance(2000)
  const pane = await $.ui.mount({ plugin: 'claudex', surface: 'terminal', component: 'Pane', requestId: 'claudex-workers',
    props: { title: 'workers', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  expect(await pane.find({ type: 'Text', text: /\? \? \? done/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /gpt-6-sol@high/ })).toBeDefined()
  await pane.unmount()
  expect(h.opened).not.toContain('claudex-workers')
})

// F13: each new review round has its own alert, regardless of host pane controls.
test('unresolved reviews each request their own pane and toast', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [
    { ...job(ID), tier: 'adversary', kind: 'adversary', model: 'gpt-6-astra@xhigh', owner: 'session-a' },
  ] })
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'start') return stub(h.calls.filter(v => v.argv[1] === 'start').length === 1 ? ID : SECOND)
    if (c.argv[1] === 'jobs') return stub(JSON.stringify(c.argv.includes('--id') ? [h.opts.jobs.find(j => j.id === c.argv.at(-1))] : h.opts.jobs))
    if (c.argv[1] === 'findings') return stub(JSON.stringify([{ id: 'F1', severity: 'high', title: 'One', mechanism: 'M', evidence: 'E', fix: 'Fix', unverified: false }]))
    return stub('review report')
  }
  await start($)
  for (const id of [ID, SECOND]) {
    if (id === SECOND) h.opts.jobs.push({ ...job(SECOND), tier: 'adversary', kind: 'adversary', model: 'gpt-6-astra@xhigh' })
    await $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit' })
    await h.clock.advance(2000)
    await $.tool.call({ tool: 'mcp__claudex__verdict', review: id, round: 1, verdicts: [{ id: 'F1', stance: 'unresolved', note: 'ask' }] })
  }
  expect(h.opened.filter(id => id === 'claudex-findings')).toHaveLength(2)
  expect(h.toasts.filter(t => t.includes('need your decision'))).toHaveLength(2)
  const reviews = h.state.get('claudex:reviews')?.value as Record<string, ClaudexReview>
  expect(Object.keys(reviews)).toHaveLength(2)
})


