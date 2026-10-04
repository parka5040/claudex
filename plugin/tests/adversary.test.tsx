import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ClaudexFinding, ClaudexJob, ClaudexReview, ClaudexStatus } from '../types/index.d.ts'
import { harness, stub } from './harness.ts'

const FIRST = '1790000000-abcdef12'
const SECOND = '1790000001-abcdef12'
const SESSION = '12345678-1234-4234-8234-123456789abc'
const status = (enabled = true): ClaudexStatus => ({
  policy: { CLAUDEX: enabled ? 'on' : 'off', CLAUDEX_ADVERSARY_MODEL: 'gpt-6-astra@xhigh' },
  policy_sources: { CLAUDEX: 'default' }, proxy: { up: false, ours: false, port: 18765 },
  token_hours_left: null, plan: null, models: null, deprecations: [],
})
const finding = (id: string, severity: ClaudexFinding['severity'] = 'high'): ClaudexFinding => ({
  id, severity, title: `Title ${id}`, mechanism: `Mechanism ${id}`,
  evidence: `Evidence ${id}`, fix: `Fix ${id}`, unverified: id === 'F2',
})
const job = (id = FIRST, state: ClaudexJob['state'] = 'done'): ClaudexJob => ({
  id, tier: 'adversary', kind: 'adversary', model: 'gpt-6-astra@xhigh', mode: 'read',
  cwd: '/repo/tree', origin: 'mod', owner: 'session-a', state, started: 1790000000,
  elapsed_s: 45, rc: state === 'running' ? null : 0, session: SESSION,
  has_findings: true, findings_error: null, legacy: false,
})
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const tool = async ($: Engine, name: 'review' | 'verdict', fields: Record<string, unknown>) => {
  const result = await $.tool.call({ tool: `mcp__claudex__${name}`, ...fields })
  return { ...result, text: result.text ?? ('deny' in result ? result.deny : String(result.result ?? '')) }
}
const command = ($: Engine, args: string) => $.command.run({
  command: 'claudex', args, origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 100 },
})
const reviewState = (h: ReturnType<typeof harness>): ClaudexReview | undefined =>
  (h.state.get('claudex:reviews')?.value as Record<string, ClaudexReview> | undefined)?.[FIRST]
const route = (h: ReturnType<typeof harness>, findings: ClaudexFinding[] | null = [finding('F1'), finding('F2')]) =>
  (c: { argv: readonly string[] }) => {
    if (c.argv[1] === 'status') return stub(JSON.stringify(h.opts.status))
    if (c.argv[1] === 'start') return stub(`${c.argv.includes('--resume') ? SECOND : FIRST}\n`)
    if (c.argv[1] === 'jobs') {
      const ids = c.argv.flatMap((arg, i) => arg === '--id' ? [c.argv[i + 1]] : []).filter((id): id is string => !!id)
      const owner = c.argv.includes('--owner') ? c.argv[c.argv.indexOf('--owner') + 1] : undefined
      return stub(JSON.stringify(ids.length ? ids.map(id => h.opts.jobs.find(j => j.id === id) ?? { id, state: 'missing' }) :
        owner !== undefined ? h.opts.jobs.filter(j => j.owner === owner).slice(0, 500) : h.opts.jobs))
    }
    if (c.argv[1] === 'findings') return findings === null ? stub('', 1) : stub(JSON.stringify(findings))
    if (c.argv[1] === 'result' || c.argv[1] === 'wait') return stub('Review report from stub.')
    return stub('')
  }
const mount = ($: Engine, surface: 'terminal' | 'desktop') => $.ui.mount({
  plugin: 'claudex', surface, component: 'Pane', requestId: 'claudex-findings',
  props: { title: 'claudex adversary review', isFocused: true, bodyColumns: 90, placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 }, view: {} },
})

test('review validates, gates, launches adversary with formatted brief, and refuses when off', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  expect(h.tools).toContain('review')
  expect(h.tools).toContain('verdict')
  for (const input of [{ artifact: '' }, { artifact: 'x'.repeat(200001) }, { artifact: 'x', context: 'y'.repeat(20001) }, { artifact: 'x', cwd: 'relative' }]) {
    expect((await tool($, 'review', input)).isError).toBe(true)
  }
  expect(h.checks).toHaveLength(0)
  for (const decision of ['ask', 'deny'] as const) {
    h.opts.check = { decision, reason: decision === 'deny' ? 'blocked' : undefined }
    const answer = await tool($, 'review', { artifact: 'audit' })
    expect(answer.text).toContain(decision === 'deny' ? 'blocked' : 'needs permission')
  }
  expect(h.calls.filter(c => c.argv[1] === 'start')).toHaveLength(0)
  h.opts.check = { decision: 'allow' }
  const answer = await tool($, 'review', { artifact: 'audit', context: 'scope', cwd: '/repo/tree' })
  expect(answer.text).toContain(`Started review ${FIRST}`)
  expect(h.checks.at(-1)).toEqual({ tool: 'mcp__claudex__review', input: { artifact: 'audit', context: 'scope', cwd: '/repo/tree' } })
  const launch = h.calls.find(c => c.argv[1] === 'start')
  expect(launch?.argv[0]?.endsWith('/bin/claudex-worker')).toBe(true)
  expect(launch?.argv.slice(1)).toEqual(['start', 'adversary', '--cwd', '/repo/tree'])
  expect(launch?.init).toMatchObject({ stdin: 'Context:\nscope\n\nArtifact:\naudit', env: { CLAUDEX_JOB_ORIGIN: 'mod', CLAUDEX_JOB_OWNER: 'session-a' }, timeoutMs: 30000 })
  expect(reviewState(h)?.rounds[0]?.round).toBe(1)
  expect(reviewState(h)?.model).toBe('gpt-6-astra@xhigh')
  expect((await tool($, 'review', { artifact: 'x', context: '' })).text).toContain(`Started review ${FIRST}`)
  expect(h.calls.at(-1)?.init?.stdin).toBe('Context:\n(none)\n\nArtifact:\nx')
  expect(h.calls.every(c => !c.argv.includes('yolo') && typeof c.init?.timeoutMs === 'number')).toBe(true)
  h.opts.status.policy.CLAUDEX = 'off'
  await command($, 'config CLAUDEX off')
  expect((await tool($, 'review', { artifact: 'x' })).isError).toBe(true)
})

test('cold-off review is absent, and preflight failure never creates a review', async ($, on) => {
  const h = harness(on, { status: status(false), jobs: [] })
  h.opts.route = route(h)
  await start($)
  expect(h.tools).toHaveLength(0)
  expect((await tool($, 'review', { artifact: 'audit' })).isError).toBe(true)
  expect(h.calls.filter(c => c.argv[1] === 'start')).toHaveLength(0)
  h.opts.status.policy.CLAUDEX = 'on'
  await command($, 'config CLAUDEX on')
  h.opts.route = c => c.argv[1] === 'start' ? stub('', 4, 'adversary tier disabled') : route(h)(c)
  const answer = await tool($, 'review', { artifact: 'audit' })
  expect(answer.isError).toBe(true)
  expect(answer.text).toContain('adversary tier disabled')
  expect(reviewState(h)).toBeUndefined()
})

test('poll ingestion is once and notifies with every finding and verdict guidance', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  await tool($, 'review', { artifact: 'audit' })
  await h.clock.advance(2000)
  expect(h.submitted).toHaveLength(1)
  expect(h.submitted[0]).toContain('F1 [high] Title F1')
  expect(h.submitted[0]).toContain('F2 [high] Title F2')
  expect(h.submitted[0]).toContain('UNVERIFIED')
  expect(h.submitted[0]).toContain('mcp__claudex__verdict')
  expect(h.submitted[0]).toContain('unresolved findings are the user\'s to arbitrate')
  expect(reviewState(h)?.rounds[0]?.session).toBe(SESSION)
  expect(reviewState(h)?.running).toBe(false)
  expect(h.calls.filter(c => c.argv[1] === 'findings')).toHaveLength(1)
  await h.clock.advance(4000)
  expect(h.submitted).toHaveLength(1)
  expect(h.calls.filter(c => c.argv[1] === 'findings')).toHaveLength(1)
})

test('wait ingests before returning, without a later notification', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  expect((await tool($, 'review', { artifact: 'audit', wait: true })).text).toContain('Review report from stub.')
  expect(reviewState(h)?.rounds[0]?.findings?.map(f => f.id)).toEqual(['F1', 'F2'])
  expect(h.calls.filter(c => c.argv[1] === 'findings')).toHaveLength(1)
  await h.clock.advance(2000)
  expect(h.submitted).toHaveLength(0)
})

test('review wait ingests findings without the removed mcp wait tool or a completion prompt', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  expect(h.tools).toEqual(['review', 'verdict'])
  const answer = await tool($, 'review', { artifact: 'audit', wait: true })
  expect(answer.text).toContain('Review report from stub.')
  expect(reviewState(h)?.rounds[0]?.findings?.map(f => f.id)).toEqual(['F1', 'F2'])
  expect(h.calls.find(c => c.argv[1] === 'wait')?.init?.timeoutMs).toBe(570000)
  await h.clock.advance(2000)
  expect(h.submitted).toHaveLength(0)
})

test('unstructured results retain the report, error and no-verdict instruction in notification and pane', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [{ ...job(), has_findings: false, findings_error: 'invalid JSON' }] })
  h.opts.route = route(h, null)
  await start($)
  await tool($, 'review', { artifact: 'audit' })
  await h.clock.advance(2000)
  expect(h.submitted[0]).toContain('Review report from stub.')
  expect(h.submitted[0]).toContain('no structured findings were returned')
  expect(h.submitted[0]).toContain('do not call verdict')
  expect(reviewState(h)?.rounds[0]?.findings_error).toBe('invalid JSON')
  expect((await command($, 'findings 999-abcdef12')).text).toContain('Unknown review')
  const opened = await command($, `findings ${FIRST}`)
  expect(opened.text).toContain('Findings pane opened.')
  expect(h.state.get('claudex:selected')?.value).toBe(FIRST)
  expect(h.opened).toContain('claudex-findings')
  const pane = await mount($, 'terminal')
  expect(await pane.find({ type: 'Markdown', text: /Review report from stub/ })).toBeDefined()
  await pane.unmount()
})

test('verdict checks review, round and ids; unresolved opens once, decisions and send are exact', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  await tool($, 'review', { artifact: 'audit' })
  await h.clock.advance(2000)
  expect((await tool($, 'verdict', { review: '999-abcdef12', round: 1, verdicts: [] })).isError).toBe(true)
  expect((await tool($, 'verdict', { review: FIRST, round: 2, verdicts: [] })).text).toContain('stale round 2; active is 1')
  expect((await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [{ id: 'F3', stance: 'accepted', note: 'fixed' }] })).text).toContain('F3')
  const a = await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [{ id: 'F1', stance: 'accepted', note: 'changed' }] })
  expect(a.text).toBe('Recorded 1. Unanswered: F2.')
  const b = await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [{ id: 'F2', stance: 'unresolved', note: 'need decision' }] })
  expect(b.text).toBe('All findings answered.')
  expect(h.opened.filter(id => id === 'claudex-findings')).toHaveLength(1)
  expect(h.toasts.filter(t => t.includes('need your decision'))).toHaveLength(1)
  await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [{ id: 'F2', stance: 'unresolved', note: 'still unclear' }] })
  expect(h.opened.filter(id => id === 'claudex-findings')).toHaveLength(1)
  const panes = [await mount($, 'terminal'), await mount($, 'desktop')]
  for (const pane of panes) {
    const drawing = JSON.stringify(await pane.drawn())
    expect(await pane.find({ type: 'Text', text: /review 1790000000-abcdef12/ }), drawing).toBeDefined()
    expect(await pane.find({ key: 'claude-F1' }), drawing).toBeUndefined()
    expect(await pane.find({ key: 'gpt-F1' }), drawing).toBeUndefined()
    expect(await pane.find({ key: 'claude-F2' }), drawing).toBeDefined()
    expect(await pane.find({ key: 'gpt-F2' }), drawing).toBeDefined()
  }
  await panes[0]!.press({ key: 'gpt-F2' })
  await panes[0]!.redraw()
  expect(await panes[0]!.find({ key: 'send' })).toBeDefined()
  await panes[0]!.press({ key: 'send' })
  expect(h.submitted.at(-1)).toBe(`User arbitration on review ${FIRST} round 1: F2 → GPT is right: apply its fix.`)
  expect(reviewState(h)?.rounds[0]?.sent).toContain('F2')
  expect(reviewState(h)?.rounds[0]?.decisions.F2).toBeUndefined()
  for (const pane of panes) {
    await pane.press({ key: 'close' })
    expect(h.closed.at(-1)).toBe('claudex-findings')
    await pane.unmount()
  }
  expect(h.submitted).toHaveLength(2) // completion and one combined arbitration
})

test('send combines all pending decisions, allows toggling, and never sends twice', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  await tool($, 'review', { artifact: 'audit' })
  await h.clock.advance(2000)
  await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [
    { id: 'F1', stance: 'unresolved', note: 'not agreed' },
    { id: 'F2', stance: 'unresolved', note: 'not agreed either' },
  ] })
  const pane = await mount($, 'desktop')
  await pane.press({ key: 'claude-F1' })
  await pane.redraw()
  await pane.press({ key: 'claude-F1' })
  expect(reviewState(h)?.rounds[0]?.decisions.F1).toBeUndefined()
  await pane.redraw()
  await pane.press({ key: 'claude-F1' })
  await pane.redraw()
  await pane.press({ key: 'gpt-F2' })
  await pane.redraw()
  expect(await pane.find({ key: 'send' })).toBeDefined()
  await pane.press({ key: 'send' })
  expect(h.submitted.at(-1)).toBe(`User arbitration on review ${FIRST} round 1: F1 → Claude is right: keep as is; F2 → GPT is right: apply its fix.`)
  expect(h.submitted).toHaveLength(2)
  expect(reviewState(h)?.rounds[0]?.sent).toEqual(['F1', 'F2'])
  await pane.redraw()
  expect(await pane.find({ key: 'send' })).toBeUndefined()
  await pane.unmount()
})

test('review rounds and stances persist without storing report or findings text', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  await tool($, 'review', { artifact: 'audit' })
  await h.clock.advance(2000)
  await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [{ id: 'F1', stance: 'accepted', note: 'changed' }] })
  const saved = h.stored.get('claudex:v1:session-a') as { reviews: Record<string, unknown> }
  expect(JSON.stringify(saved)).not.toContain('Evidence F1')
  expect(JSON.stringify(saved)).not.toContain('Review report from stub.')
  expect(JSON.stringify(saved)).toContain('changed')
  h.state.delete('claudex:reviews')
  h.state.delete('claudex:owned')
  await start($)
  expect(reviewState(h)?.rounds[0]?.findings?.[0]?.id).toBe('F1')
  expect(reviewState(h)?.rounds[0]?.verdicts.F1?.note).toBe('changed')
  await h.clock.advance(2000)
  expect(h.submitted).toHaveLength(1)
})

test('another round is gated, resumes prior session with only disputed notes, and rejects stale verdicts', async ($, on) => {
  const h = harness(on, { status: status(), jobs: [job()] })
  h.opts.route = route(h)
  await start($)
  await tool($, 'review', { artifact: 'audit', cwd: '/repo/tree' })
  await h.clock.advance(2000)
  const pane = await mount($, 'terminal')
  expect(await pane.find({ key: 'round' })).toBeUndefined()
  await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [
    { id: 'F1', stance: 'rebutted', note: 'counter evidence' },
    { id: 'F2', stance: 'unresolved', note: 'needs user' },
  ] })
  await pane.redraw()
  h.opts.check = { decision: 'ask' }
  await pane.press({ key: 'round' })
  expect(h.calls.filter(c => c.argv[1] === 'start')).toHaveLength(1)
  h.opts.check = { decision: 'allow' }
  h.opts.jobs = [job(), job(SECOND, 'running')]
  await pane.press({ key: 'round' })
  const launches = h.calls.filter(c => c.argv[1] === 'start')
  expect(launches).toHaveLength(2)
  expect(launches[1]?.argv.slice(1)).toEqual(['start', 'adversary', '--cwd', '/repo/tree', '--resume', SESSION])
  expect(launches[1]?.init?.stdin).toBe('F1 (rebutted): counter evidence\nF2 (unresolved): needs user')
  expect(h.checks.at(-1)?.tool).toBe('mcp__claudex__review')
  expect(reviewState(h)?.active_round).toBe(2)
  expect(reviewState(h)?.rounds[0]?.verdicts.F1?.stance).toBe('rebutted')
  expect(reviewState(h)?.running).toBe(true)
  await pane.redraw()
  expect(await pane.find({ key: 'round' })).toBeUndefined()
  expect((await tool($, 'verdict', { review: FIRST, round: 1, verdicts: [{ id: 'F1', stance: 'accepted', note: 'late' }] })).text).toContain('stale round 1; active is 2')
  h.opts.jobs = [job(), job(SECOND)]
  await h.clock.advance(2000)
  expect(reviewState(h)?.rounds[1]?.job).toBe(SECOND)
  expect(reviewState(h)?.rounds[1]?.findings?.[0]?.id).toBe('F1')
  expect(reviewState(h)?.running).toBe(false)
  await pane.unmount()
})
