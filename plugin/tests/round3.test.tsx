import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ClaudexJob, ClaudexOwned, ClaudexReview, ClaudexStatus } from '../types/index.d.ts'
import { harness, stub } from './harness.ts'

const FIRST = '1790000000-abcdef12'
const SECOND = '1790000001-abcdef12'
const SESSION = '12345678-1234-4234-8234-123456789abc'
const status = (): ClaudexStatus => ({
  policy: { CLAUDEX: 'on', CLAUDEX_ADVERSARY_MODEL: 'gpt-6-astra@xhigh' },
  policy_sources: { CLAUDEX: 'file' }, proxy: { up: false, ours: false, port: 18765 },
  token_hours_left: null, plan: null, models: null, deprecations: [],
})
const job = (id: string, state: ClaudexJob['state']): ClaudexJob => ({
  id, tier: 'adversary', kind: 'adversary', model: 'gpt-6-astra@xhigh', mode: 'read', cwd: '/repo',
  origin: 'mod', owner: 'session-a', state, started: 1790000000, elapsed_s: 1,
  rc: state === 'running' ? null : 0, session: SESSION,
  has_findings: true, findings_error: null, legacy: false,
})
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) => $.command.run({
  command: 'claudex', args, origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
})
const owned = (h: ReturnType<typeof harness>) => h.state.get('claudex:owned')?.value as Record<string, ClaudexOwned>
const reviews = (h: ReturnType<typeof harness>) => h.state.get('claudex:reviews')?.value as Record<string, ClaudexReview>
const mount = ($: Engine) => $.ui.mount({
  plugin: 'claudex', surface: 'terminal', component: 'Pane', requestId: 'claudex-findings',
  props: { title: 'adversary', isFocused: true, bodyColumns: 90, placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 }, view: {} },
})

// M5: discovery can observe the child before the start command returns its id.
test('discovered Another-round child waits for launch registration and ingests under its parent', async ($, on) => {
  let releaseLaunch: ((value: ReturnType<typeof stub>) => void) | undefined
  const h = harness(on, { status: status(), jobs: [job(FIRST, 'done')] })
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'start') return c.argv.includes('--resume') ? new Promise(resolve => { releaseLaunch = resolve }) : stub(FIRST)
    if (c.argv[1] === 'jobs') {
      const ids = c.argv.flatMap((arg, i) => arg === '--id' ? [c.argv[i + 1]] : []).filter(Boolean)
      return stub(JSON.stringify(ids.length ? ids.map(id => h.opts.jobs.find(j => j.id === id)) : h.opts.jobs))
    }
    if (c.argv[1] === 'findings') return stub(JSON.stringify([
      { id: 'F1', severity: 'high', title: 'Issue', mechanism: 'M', evidence: 'E', fix: 'Fix', unverified: false },
    ]))
    return stub('Review report.')
  }
  await start($)
  const first = await $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit', wait: true })
  expect(String(first.result)).toContain('Review report.')
  expect(owned(h)[FIRST]?.delivery).toBe('delivered')
  await $.tool.call({ tool: 'mcp__claudex__verdict', review: FIRST, round: 1,
    verdicts: [{ id: 'F1', stance: 'rebutted', note: 'still broken' }] })
  const pane = await mount($)
  const launched = pane.press({ key: 'round' })
  await h.clock.settle()
  expect(releaseLaunch).toBeDefined()
  h.opts.jobs.push(job(SECOND, 'done'))
  await h.clock.advance(2000) // owner discovery gets the child while launch has not returned
  expect(h.calls.some(c => c.argv.includes('--owner') && c.argv.includes('session-a'))).toBe(true)
  expect(owned(h)[SECOND]?.review).toBe(SECOND) // discovery is provisional
  expect(h.submitted.filter(text => text.includes(SECOND))).toHaveLength(0)
  expect(reviews(h)[SECOND]).toBeUndefined()
  releaseLaunch?.(stub(SECOND))
  await launched
  expect(owned(h)[SECOND]?.review).toBe(FIRST)
  expect(owned(h)[SECOND]?.delivery).toBe('pending')
  await h.clock.advance(2000)
  expect(owned(h)[SECOND]?.delivery).toBe('notified')
  expect(reviews(h)[FIRST]?.rounds[1]?.job).toBe(SECOND)
  expect(reviews(h)[FIRST]?.rounds[1]?.findings?.[0]?.id).toBe('F1')
  expect(reviews(h)[FIRST]?.running).toBe(false)
  expect(reviews(h)[SECOND]).toBeUndefined()
  expect(h.submitted).toHaveLength(1)
  expect(h.submitted.at(-1)).toContain(`review ${FIRST} round 2`)
  await pane.unmount()
})

test('a discovered terminal round is not ingested before its parent launch completes', async ($, on) => {
  let releaseLaunch: ((value: ReturnType<typeof stub>) => void) | undefined
  const h = harness(on, { status: status(), jobs: [job(FIRST, 'done')] })
  h.opts.route = c => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'start') return c.argv.includes('--resume') ? new Promise(resolve => { releaseLaunch = resolve }) : stub(FIRST)
    if (c.argv[1] === 'jobs') {
      const ids = c.argv.flatMap((arg, i) => arg === '--id' ? [c.argv[i + 1]] : []).filter(Boolean)
      return stub(JSON.stringify(ids.length ? ids.map(id => h.opts.jobs.find(j => j.id === id)) : h.opts.jobs))
    }
    if (c.argv[1] === 'findings') return stub(JSON.stringify([
      { id: 'F1', severity: 'high', title: 'Issue', mechanism: 'M', evidence: 'E', fix: 'Fix', unverified: false },
    ]))
    return stub(c.argv[1] === 'wait' && c.argv[2] === SECOND ? 'Second report.' : 'Review report.')
  }
  await start($)
  await $.tool.call({ tool: 'mcp__claudex__review', artifact: 'audit', wait: true })
  await $.tool.call({ tool: 'mcp__claudex__verdict', review: FIRST, round: 1,
    verdicts: [{ id: 'F1', stance: 'rebutted', note: 'still broken' }] })
  const pane = await mount($)
  const launched = pane.press({ key: 'round' })
  await h.clock.settle()
  h.opts.jobs.push(job(SECOND, 'done'))
  await h.clock.advance(2000)
  expect(owned(h)[SECOND]?.review).toBe(SECOND)
  expect(owned(h)[SECOND]?.delivery).toBe('pending')
  expect(reviews(h)[SECOND]).toBeUndefined()
  expect(reviews(h)[FIRST]?.rounds).toHaveLength(1)
  releaseLaunch?.(stub(SECOND))
  await launched
  expect(owned(h)[SECOND]?.review).toBe(FIRST)
  await h.clock.advance(2000)
  expect(owned(h)[SECOND]?.delivery).toBe('notified')
  expect(reviews(h)[FIRST]?.rounds[1]?.findings?.[0]?.id).toBe('F1')
  expect(reviews(h)[FIRST]?.running).toBe(false)
  expect(reviews(h)[SECOND]).toBeUndefined()
  await h.clock.advance(4000)
  expect(h.submitted).toHaveLength(1)
  await pane.unmount()
})

