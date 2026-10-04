import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ClaudexJob, ClaudexOwned, ClaudexReview, ClaudexStatus } from '../types/index.d.ts'
import { harness, stub } from './harness.ts'

const FIRST = '1790000000-abcdef12'
const SECOND = '1790000001-abcdef12'
const SESSION = '12345678-1234-4234-8234-123456789abc'
const status = (): ClaudexStatus => ({
  policy: { CLAUDEX: 'on', CLAUDEX_ADVERSARY_MODEL: 'gpt-6-astra@xhigh' },
  policy_sources: { CLAUDEX: 'file' },
  proxy: { up: false, ours: false, port: 18765 }, token_hours_left: null, plan: null,
  models: null, deprecations: [],
})
const job = (id = FIRST, state: ClaudexJob['state'] = 'running'): ClaudexJob => ({
  id, tier: 'adversary', kind: 'adversary', model: 'gpt-6-astra@xhigh', mode: 'read', cwd: '/repo',
  origin: 'mod', owner: 'session-a', state, started: 1790000000, elapsed_s: 1,
  rc: state === 'running' ? null : 0, session: SESSION, has_findings: true, findings_error: null, legacy: false,
})
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) => $.command.run({
  command: 'claudex', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 },
})
const owned = (h: ReturnType<typeof harness>) => h.state.get('claudex:owned')?.value as Record<string, ClaudexOwned>
const reviews = (h: ReturnType<typeof harness>) => h.state.get('claudex:reviews')?.value as Record<string, ClaudexReview>
const mount = ($: Engine) => $.ui.mount({
  plugin: 'claudex', surface: 'terminal', component: 'Pane', requestId: 'claudex-findings',
  props: { title: 'adversary', isFocused: true, bodyColumns: 90, placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 }, view: {} },
})
const finding = [{ id: 'F1', severity: 'high', title: 'Issue', mechanism: 'M', evidence: 'E', fix: 'Fix', unverified: false }]

// N4: the round reservation and result belong to an operation, not an activation token.
test('off/on during Another round keeps a single launch and the original review linkage', async ($, on) => {
  let finishLaunch: ((result: ReturnType<typeof stub>) => void) | undefined
  const h = harness(on, { status: status(), jobs: [job(FIRST, 'done')] })
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'start') return c.argv.includes('--resume') ? new Promise(resolve => { finishLaunch = resolve }) : stub(FIRST)
    if (c.argv[1] === 'jobs') return stub(JSON.stringify(h.opts.jobs))
    if (c.argv[1] === 'findings') return stub(JSON.stringify(finding))
    return stub('Review report.')
  }
  await start($)
  await $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit' })
  await h.clock.advance(2000)
  await $.tool.call({ tool: 'mcp__claudex__verdict', review: FIRST, round: 1, verdicts: [{ id: 'F1', stance: 'rebutted', note: 'still broken' }] })
  const pane = await mount($)
  const launched = pane.press({ key: 'round' })
  await h.clock.settle()
  expect(h.calls.filter(c => c.argv[1] === 'start')).toHaveLength(2)
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'config CLAUDEX on')
  await pane.press({ key: 'round' })
  expect(h.calls.filter(c => c.argv[1] === 'start')).toHaveLength(2)
  expect(reviews(h)[FIRST]?.launching).toBeDefined()
  h.opts.jobs.push(job(SECOND))
  finishLaunch?.(stub(SECOND))
  await launched
  expect(reviews(h)[FIRST]?.active_round).toBe(2)
  expect(reviews(h)[FIRST]?.rounds[1]?.job).toBe(SECOND)
  expect(reviews(h)[FIRST]?.launching).toBeUndefined()
  expect(owned(h)[SECOND]?.review).toBe(FIRST)
  await pane.unmount()
})

// N4/N2: an arbitration prompt queued across activation must be acknowledged exactly once.
test('Send decisions remains exclusive and records its delayed acknowledgment after off/on', async ($, on) => {
  let release: ((result: { text: string }) => void) | undefined
  const h = harness(on, { status: status(), jobs: [job(FIRST, 'done')],
    submit: text => text.startsWith('User arbitration') ? new Promise(resolve => { release = resolve }) : Promise.resolve({ text }),
  })
  h.opts.route = c => c.argv[1] === 'status' ? stub(JSON.stringify(h.opts.status)) :
    c.argv[1] === 'start' ? stub(FIRST) : c.argv[1] === 'jobs' ? stub(JSON.stringify(h.opts.jobs)) :
    c.argv[1] === 'findings' ? stub(JSON.stringify(finding)) : stub('Review report.')
  await start($)
  await $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit' })
  await h.clock.advance(2000)
  await $.tool.call({ tool: 'mcp__claudex__verdict', review: FIRST, round: 1, verdicts: [{ id: 'F1', stance: 'unresolved', note: 'decide' }] })
  const pane = await mount($)
  await pane.press({ key: 'gpt-F1' })
  await pane.redraw()
  const sending = pane.press({ key: 'send' })
  await h.clock.settle()
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'config CLAUDEX on')
  await pane.press({ key: 'send' })
  expect(h.submitted.filter(text => text.startsWith('User arbitration'))).toHaveLength(1)
  release?.({ text: h.submitted.at(-1)! })
  await sending
  expect(reviews(h)[FIRST]?.rounds[0]?.sent).toEqual(['F1'])
  expect(reviews(h)[FIRST]?.rounds[0]?.decisions.F1).toBeUndefined()
  await pane.unmount()
})

// N4: a completed review launch may be recorded even though config changed while process.run was pending.
test('review registers a successful launch after an activation change', async ($, on) => {
  let finish: ((result: ReturnType<typeof stub>) => void) | undefined
  const h = harness(on, { status: status(), jobs: [] })
  h.opts.route = c => c.argv[1] === 'status' ? stub(JSON.stringify(h.opts.status)) :
    c.argv[1] === 'start' ? new Promise(resolve => { finish = resolve }) :
    c.argv[1] === 'jobs' ? stub(JSON.stringify(h.opts.jobs)) : stub('')
  await start($)
  const launch = $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit' })
  await h.clock.settle()
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'config CLAUDEX on')
  h.opts.jobs.push(job(FIRST))
  finish?.(stub(FIRST))
  await launch
  expect(owned(h)[FIRST]?.owner).toBe('session-a')
  expect(reviews(h)[FIRST]?.rounds[0]?.job).toBe(FIRST)
})
