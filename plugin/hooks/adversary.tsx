import { atom, read } from 'claude-code'
import type { On } from 'claude-code'
import type { ClaudexFinding, ClaudexJob, ClaudexOwned, ClaudexReview, ClaudexRound, ClaudexVerdict } from '../types/index.d.ts'
import { alertRound, changeReviews, contextCurrent, currentToken, isCurrent, live, nextOperation, onEnable, onSessionReady, rearmCurrent, selectReview, syncSessionCurrent } from './jobs.ts'
import { launchFinishedCurrent, launchPendingForCurrent, onIngest, ownCurrent, persistReviewsCurrent, transitionCurrent, ownedHereCurrent } from './delivery.ts'
import { findingsRequest, jobsRequest, parseFindings, parseJobs, resultRequest, startRequest, waitRequest } from './worker.ts'

export const FINDINGS_PANE = 'claudex-findings'
const reviewsState = atom({ plugin: 'claudex', key: 'reviews' } as const, {})
const selectedState = atom({ plugin: 'claudex', key: 'selected' } as const, null)
const idPattern = /^[0-9]+-(?:[0-9a-f]{8}|[0-9]+)$/
const reviewTool = 'mcp__claudex__review'
async function gateCurrent(tool: string, input: Record<string, unknown>): Promise<{ ok: true } | { deny: string }> {
  const decision = await contextCurrent().checkTool(tool, input)
  if (decision.decision === 'allow') return { ok: true }
  if (decision.decision === 'deny') return { deny: decision.reason ?? 'denied by permission rules' }
  return { deny: `claudex: ${tool} needs permission. Add "${tool}" to permissions.allow in ~/.claude/settings.json, or dispatch with Bash: claudex-worker start … (that path prompts).` }
}
type Fields = Record<string, unknown>
type Answer = { result: string; isError?: true } | { deny: string }
const error = (message: string): Answer => ({ result: message, isError: true })
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
const roundOf = (review: ClaudexReview): ClaudexRound | undefined =>
  review.rounds.find(round => round.round === review.active_round)
const emptyRound = (round: number, job: string): ClaudexRound => ({
  round, job, session: null, findings: null, findings_error: null, report: null,
  verdicts: {}, decisions: {}, sent: [],
})
const plain = (e: Fields): Fields => {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = e
  return input
}
let registered = false
const sending = new Set<string>()
const launching = new Set<string>()

function reviewInput(input: Fields): string | undefined {
  if (!validText(input.artifact, 200000)) return 'artifact must be non-empty and at most 200000 characters'
  if (input.context !== undefined && (typeof input.context !== 'string' || input.context.length > 20000)) return 'context must be at most 20000 characters'
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.startsWith('/'))) return 'cwd must be an absolute path'
  if (input.wait !== undefined && typeof input.wait !== 'boolean') return 'wait must be boolean'
  return undefined
}
function verdictInput(input: Fields): string | undefined {
  if (typeof input.review !== 'string' || !idPattern.test(input.review)) return 'invalid review id'
  if (!Number.isInteger(input.round) || typeof input.round !== 'number' || input.round < 1) return 'round must be a positive integer'
  if (!Array.isArray(input.verdicts) || input.verdicts.length > 50) return 'verdicts must be an array of at most 50 items'
  for (const item of input.verdicts) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
      !['accepted', 'rebutted', 'unresolved'].includes(item.stance) ||
      !validText(item.note, 2000)) return 'invalid verdict (id, stance, and note are required)'
  }
  return undefined
}
function summary(review: ClaudexReview, round: ClaudexRound): string {
  if (round.findings === null) {
    const report = round.report ?? '(no report available)'
    return `claudex review ${review.id} round ${round.round} finished.\n\n${report.slice(0, 20000)}` +
      (report.length > 20000 ? `\n\n[Report shortened; use claudex-worker result ${round.job} for the full report.]` : '') +
      '\n\nno structured findings were returned; answer it in prose and do not call verdict.'
  }
  const lines = round.findings.map(f =>
    `${f.id} [${f.severity}] ${f.title}${f.unverified ? ' UNVERIFIED' : ''} — ${f.evidence} — ${f.fix}`)
  return `claudex review ${review.id} round ${round.round} finished.\n` +
    (lines.length ? lines.join('\n') : 'No findings.') +
    '\n\nAnswer every finding with mcp__claudex__verdict (review, round, id, stance: accepted + what changed / rebutted + evidence / unresolved); unresolved findings are the user\'s to arbitrate in the findings pane — do not settle them yourself.'
}

// Both the poller and the wait path use this hook. The job id is the round's
// identity, so a repeated tick or a restored review cannot duplicate a round.
export async function ingest(owned: ClaudexOwned, job: ClaudexJob, gen = currentToken()): Promise<string> {
  const api = contextCurrent()
  if (!isCurrent(gen)) return ''
  const session = await api.session()
  if (!isCurrent(gen) || job.owner !== session || owned.owner !== session) return ''
  const currentOwned = live.owned[job.id]
  if (!currentOwned || currentOwned.owner !== session || launchPendingForCurrent(currentOwned)) return ''
  const reviewId = currentOwned.review ?? job.id
  let review = live.reviews[reviewId]
  if (!review) {
    review = { id: reviewId, cwd: job.cwd ?? api.cwd, model: job.model ?? '?',
      rounds: [emptyRound(1, job.id)], active_round: 1, running: true }
    changeReviews(old => old[reviewId] ? old : { ...old, [reviewId]: review! })
    review = live.reviews[reviewId]
  }
  const round = review?.rounds.find(item => item.job === job.id)
  if (!review || !round) return `claudex review ${reviewId}: unknown round job ${job.id}`
  if (round.findings !== null || round.report !== null) return summary(review, round)
  const request = findingsRequest(api.root, job.id)
  const found = await api.run(request.argv, request.init)
  if (!isCurrent(gen)) return ''
  let findings: ClaudexFinding[] | null
  let findingsError = job.findings_error
  try { findings = parseFindings(found) }
  catch (cause) { findings = null; findingsError = `invalid findings: ${String(cause)}` }
  let report: string | null = null
  if (findings === null) {
    const result = resultRequest(api.root, job.id)
    const response = await api.run(result.argv, result.init)
    if (!isCurrent(gen)) return ''
    report = response.stdout || response.stderr || '(no report available)'
  }
  if (!isCurrent(gen) || session !== await api.session()) return ''
  if (!isCurrent(gen)) return ''
  changeReviews(old => {
    const current = old[reviewId]
    if (!current) return old
    const rounds = current.rounds.map(item => item.job !== job.id || item.findings !== null || item.report !== null
      ? item : { ...item, session: job.session, findings, findings_error: findingsError, report })
    return { ...old, [reviewId]: { ...current, rounds,
      running: current.active_round === round.round ? false : current.running } }
  })
  void persistReviewsCurrent(gen)
  review = live.reviews[reviewId]
  return review ? summary(review, review.rounds.find(item => item.job === job.id)!) : ''
}

async function waitFor(id: string, seconds: number, owner: string): Promise<Answer> {
  const api = contextCurrent()
  const token = currentToken()
  if (!ownedHereCurrent(id, owner)) return error('not a job of this session')
  if (!transitionCurrent(id, 'pending', 'waiting', token)) return error(`claudex job ${id} is already being delivered`)
  try {
    const request = waitRequest(api.root, id, seconds)
    const result = await api.run(request.argv, request.init)
    if (!isCurrent(token)) return error('claudex activation changed')
    if (result.exitCode === 5) {
      transitionCurrent(id, 'waiting', 'pending', token)
      const since = live.owned[id]?.since ?? Math.floor((await api.now()) / 1000)
      if (!isCurrent(token)) return error('claudex activation changed')
      const elapsed = Math.max(0, Math.floor((await api.now()) / 1000) - since)
      if (!isCurrent(token)) return error('claudex activation changed')
      return { result: `claudex job ${id} still running (elapsed ${Math.floor(elapsed / 60)}m${elapsed % 60}s); a completion notification will follow.` }
    }
    const lookup = jobsRequest(api.root, { ids: [id] })
    const [job] = parseJobs(await api.run(lookup.argv, lookup.init))
    if (!isCurrent(token)) return error('claudex activation changed')
    if (job && job.state !== 'missing' && live.owned[id]) await ingest(live.owned[id]!, job, token)
    if (!isCurrent(token)) return error('claudex activation changed')
    transitionCurrent(id, 'waiting', 'delivered', token)
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no report returned)'
    const suffix = result.isStdoutTruncated || result.isStderrTruncated
      ? `\n[Output truncated; use claudex-worker result ${id} for the full report.]` : ''
    return result.exitCode === 0 ? { result: text + suffix } : error(text + suffix)
  } catch (cause) {
    if (!isCurrent(token)) return error('claudex activation changed')
    transitionCurrent(id, 'waiting', 'pending', token)
    return error(`claudex-worker did not answer: ${String(cause)}`)
  }
}

function changeReview(fn: (old: Record<string, ClaudexReview>) => Record<string, ClaudexReview>): void {
  changeReviews(fn)
  void persistReviewsCurrent()
}

async function toggleDecision(id: string, round: number, finding: string, side: 'claude' | 'gpt'): Promise<void> {
  const token = currentToken()
  const session = await contextCurrent().session()
  if (!isCurrent(token) || !ownedHereCurrent(id, session)) return
  changeReview(old => {
    const review = old[id]
    if (!review || review.active_round !== round) return old
    return { ...old, [id]: { ...review, rounds: review.rounds.map(item => {
      if (item.round !== round || item.verdicts[finding]?.stance !== 'unresolved' ||
        item.sent.includes(finding)) return item
      const decisions = { ...item.decisions }
      if (decisions[finding] === side) delete decisions[finding]
      else decisions[finding] = side
      return { ...item, decisions }
    }) } }
  })
}

export function registerReviewTools(on: On): void {
  onEnable(async () => {
    if (registered) return
    await contextCurrent().registerTool({
      name: 'review', description: 'Start a read-only adversary review with structured findings; notify on completion.',
      inputSchema: { type: 'object', properties: {
        artifact: { type: 'string' }, context: { type: 'string' }, cwd: { type: 'string' },
        wait: { type: 'boolean' },
      }, required: ['artifact'] },
    })
    await contextCurrent().registerTool({
      name: 'verdict', description: 'Record a stance on each finding in the active adversary round.',
      inputSchema: { type: 'object', properties: {
        review: { type: 'string' }, round: { type: 'integer' },
        verdicts: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, stance: { type: 'string', enum: ['accepted', 'rebutted', 'unresolved'] },
          note: { type: 'string' },
        }, required: ['id', 'stance', 'note'] } },
      }, required: ['review', 'round', 'verdicts'] },
    })
    registered = true
  })
  onIngest(ingest)
  onSessionReady(async () => {
    const api = contextCurrent()
    const token = currentToken()
    changeReview(old => Object.fromEntries(Object.entries(old).map(([id, review]) => [id,
      review.launching && !launching.has(review.launching) ? { ...review, launching: undefined } : review])))
    for (const review of Object.values(live.reviews)) {
      for (const round of review.rounds) {
        if (!isCurrent(token)) return
        if (round.findings !== null || round.report !== null) continue
        const request = jobsRequest(api.root, { ids: [round.job] })
        const [job] = parseJobs(await api.run(request.argv, request.init))
        if (!isCurrent(token)) return
        const owned = live.owned[round.job]
        if (owned && job && !['running', 'missing'].includes(job.state)) await ingest(owned, job, token)
      }
    }
  })
  on('tool.call', { tool: reviewTool }, async ($, e): Promise<Answer> => {
    await syncSessionCurrent()
    const token = currentToken()
    const input = plain(e as unknown as Fields)
    if (!live.on) return error('claudex is off')
    const invalid = reviewInput(input)
    if (invalid) return error(invalid)
    const permission = await gateCurrent(reviewTool, input)
    await syncSessionCurrent()
    if (!isCurrent(token)) return error('claudex activation changed')
    if ('deny' in permission) return { deny: permission.deny }
    try {
      const owner = await $.session.id()
      if (!isCurrent(token) || !live.on) return error('claudex is off')
      const cwd = (input.cwd as string | undefined) ?? contextCurrent().cwd
      const request = startRequest($.plugin.root, {
        tier: 'adversary', brief: `Context:\n${input.context || '(none)'}\n\nArtifact:\n${input.artifact}`,
        owner, cwd: input.cwd as string | undefined,
      })
      const result = await $.process.run(request.argv, request.init)
      if (result.exitCode !== 0) return error(result.stderr || result.stdout || `claudex-worker start failed (${result.exitCode})`)
      const id = result.stdout.trim()
      if (!idPattern.test(id)) return error(`claudex-worker returned an invalid job id: ${id}`)
      await syncSessionCurrent()
      if (owner !== live.session) return error(`claudex review ${id} belongs to an earlier conversation`)
      const model = live.status?.policy.CLAUDEX_ADVERSARY_MODEL ?? 'adversary'
      changeReview(old => old[id] ? old : { ...old, [id]: {
        id, cwd, model, rounds: [emptyRound(1, id)], active_round: 1, running: true,
      } })
      if (!await ownCurrent(id, 'adversary', id, owner)) return error(`claudex review ${id} belongs to an earlier conversation`)
      if (input.wait === true) return await waitFor(id, 540, owner)
      return { result: `Started review ${id} (${model}). You will get a notification when it finishes; pass wait: true to review to wait for completion.` }
    } catch (cause) {
      return error(`claudex-worker did not answer: ${String(cause)}`)
    }
  })
  on('tool.call', { tool: 'mcp__claudex__verdict' }, async ($, e): Promise<Answer> => {
    await syncSessionCurrent()
    const input = plain(e as unknown as Fields)
    const invalid = verdictInput(input)
    if (invalid) return error(invalid)
    const id = input.review as string
    const n = input.round as number
    const token = currentToken()
    const session = await $.session.id()
    if (!isCurrent(token)) return error('review activation changed')
    const review = live.reviews[id]
    if (!review) return error(`unknown review ${id}`)
    if (!ownedHereCurrent(id, session)) return error('not a review of this session')
    if (n !== review.active_round) return error(`stale round ${n}; active is ${review.active_round}`)
    const round = roundOf(review)
    if (!round || round.findings === null) return error(`review ${id} has no structured findings`)
    const votes = input.verdicts as { id: string; stance: ClaudexVerdict['stance']; note: string }[]
    for (const vote of votes) {
      if (!round.findings.some(f => f.id === vote.id)) return error(`unknown finding ${vote.id}`)
    }
    await changeReview(old => {
      const current = old[id]
      if (!current || current.active_round !== n) return old
      return { ...old, [id]: { ...current, rounds: current.rounds.map(item => item.round !== n ? item : {
        ...item, verdicts: { ...item.verdicts, ...Object.fromEntries(votes.map(v => [v.id, { stance: v.stance, note: v.note }])) },
      }) } }
    })
    if (!isCurrent(token)) return error('review activation changed')
    const current = live.reviews[id]
    if (!current || current.active_round !== n) return error(`stale round ${n}; active is ${current?.active_round ?? '?'}`)
    const active = roundOf(current)!
    const unanswered = (active.findings ?? []).filter(f => !active.verdicts[f.id]).map(f => f.id)
    const unresolved = Object.values(active.verdicts).filter(v => v.stance === 'unresolved').length
    if (unresolved) selectReview(id)
    if (unresolved && alertRound(`${id}:${n}`)) {
      void persistReviewsCurrent(token)
      await $.ui.open({ id: FINDINGS_PANE, title: 'claudex adversary review' })
      if (isCurrent(token)) $.ui.toast(`claudex: ${unresolved} findings need your decision — /claudex findings`)
    }
    return { result: unanswered.length ? `Recorded ${votes.length}. Unanswered: ${unanswered.join(', ')}.` : 'All findings answered.' }
  })
  on('ui.render', { component: 'Pane', requestId: FINDINGS_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const reviews = await read($, reviewsState)
    const selected = await read($, selectedState)
    const review = selected ? reviews[selected] : Object.values(reviews).at(-1)
    const round = review && roundOf(review)
    const findings = round?.findings ?? []
    const counts = { accepted: 0, rebutted: 0, unresolved: 0, pending: 0 }
    for (const finding of findings) {
      const stance = round?.verdicts[finding.id]?.stance
      if (stance) counts[stance]++
      else counts.pending++
    }
    const pending = findings.filter(f => round?.verdicts[f.id]?.stance === 'unresolved' &&
      round.decisions[f.id] && !round.sent.includes(f.id))
    const canRound = !review?.running && !review?.launching && findings.some(f =>
      ['rebutted', 'unresolved'].includes(round?.verdicts[f.id]?.stance ?? ''))
    const width = Math.max(20, e.props.bodyColumns)
    const fit = (text: string) => text.length > width ? text.slice(0, width - 3) + '...' : text
    return (
      <Box flexDirection="column">
        {!review && <Text dimColor>No adversary reviews yet.</Text>}
        {review && round && <Box flexDirection="column">
          <Text bold>{fit(`review ${review.id} · ${review.model} · round ${round.round} · accepted ${counts.accepted} · rebutted ${counts.rebutted} · unresolved ${counts.unresolved} · pending ${counts.pending}`)}</Text>
          {round.findings === null && !review.running && <Box flexDirection="column">
            <Text dimColor>No structured findings were returned. Answer this review in prose; do not call verdict.</Text>
            {round.findings_error && <Text dimColor>{fit(round.findings_error)}</Text>}
            {round.report && <Markdown text={round.report.slice(0, 9500).replace(/[^\P{Cc}\t\n]/gu, '') + (round.report.length > 9500 ? `\n\n[Report shortened; use claudex-worker result ${round.job}]` : '')} />}
          </Box>}
          {review.running && <Text dimColor>Review round is running.</Text>}
          {findings.map(f => <Box key={f.id} flexDirection="column">
            <Text bold>{fit(`${f.severity} ${f.id} ${f.title}${f.unverified ? ' UNVERIFIED' : ''}`)}</Text>
            <Text dimColor>{fit(`Evidence: ${f.evidence}`)}</Text>
            <Text>{fit(`Fix: ${f.fix}`)}</Text>
            <Text>{fit(`${round.verdicts[f.id]?.stance ?? 'pending'}${round.verdicts[f.id] ? ': ' + round.verdicts[f.id]!.note : ''}`)}</Text>
            {round.verdicts[f.id]?.stance === 'unresolved' && !round.sent.includes(f.id) && <Box>
              <Button key={`claude-${f.id}`} label={`Claude is right${round.decisions[f.id] === 'claude' ? ' (selected)' : ''}`} onPress={() =>
                toggleDecision(review.id, round.round, f.id, 'claude')} />
              <Button key={`gpt-${f.id}`} label={`GPT is right${round.decisions[f.id] === 'gpt' ? ' (selected)' : ''}`} onPress={() =>
                toggleDecision(review.id, round.round, f.id, 'gpt')} />
            </Box>}
          </Box>)}
          {pending.length > 0 && <Button key="send" label={`Send decisions (${pending.length})`} onPress={async () => {
            await syncSessionCurrent()
            const token = currentToken()
            const key = `${review.id}:${round.round}`
            if (sending.has(key)) return
            sending.add(key)
            try {
              const session = live.session
              if (!ownedHereCurrent(review.id, session)) return
              const current = live.reviews[review.id]
              if (!current || current.active_round !== round.round) return
              const active = roundOf(current)!
              const decisions = (active.findings ?? []).filter(f =>
                active.verdicts[f.id]?.stance === 'unresolved' && active.decisions[f.id] && !active.sent.includes(f.id))
              if (!decisions.length) return
              const text = `User arbitration on review ${review.id} round ${round.round}: ` + decisions.map(f =>
                `${f.id} → ${active.decisions[f.id] === 'gpt' ? 'GPT is right: apply its fix' : 'Claude is right: keep as is'}`).join('; ') + '.'
              if (session !== await $.session.id() || !isCurrent(token)) return
              const submitted = await $.prompt.submit({ text })
              if ('drop' in submitted && submitted.drop) {
                if (session === live.session) $.ui.toast(`claudex: decisions not sent: ${submitted.drop}`)
                return
              }
              if (session !== await $.session.id() || session !== live.session) return
              changeReview(old => {
                const latest = old[review.id]
                if (!latest) return old
                return { ...old, [review.id]: { ...latest, rounds: latest.rounds.map(item => {
                  if (item.round !== round.round) return item
                  const next = { ...item.decisions }
                  for (const f of decisions) delete next[f.id]
                  return { ...item, decisions: next, sent: [...new Set([...item.sent, ...decisions.map(f => f.id)])] }
                }) } }
              })
            } finally { sending.delete(key) }
          }} />}
          {canRound && <Button key="round" label="Another round" onPress={async () => {
            await syncSessionCurrent()
            const token = currentToken()
            const current = live.reviews[review.id]
            if (!current || current.active_round !== round.round || current.running || current.launching) return
            const active = roundOf(current)!
            if (!active.findings) return
            if (!active.session) { $.ui.toast('claudex: review session is unavailable for another round'); return }
            const disputed = active.findings.filter(f => ['rebutted', 'unresolved'].includes(active.verdicts[f.id]?.stance ?? ''))
            if (!disputed.length) return
            const owner = live.session
            if (!ownedHereCurrent(review.id, owner)) return
            if (!live.on) { $.ui.toast('claudex is off'); return }
            const op = nextOperation()
            launching.add(op)
            changeReview(old => {
              const latest = old[review.id]
              return !latest || latest.active_round !== round.round || latest.running || latest.launching ? old :
                { ...old, [review.id]: { ...latest, launching: op } }
            })
            try {
              const brief = disputed.map(f => `${f.id} (${active.verdicts[f.id]!.stance}): ${active.verdicts[f.id]!.note}`).join('\n')
              const input = { artifact: brief, cwd: current.cwd, resume: active.session }
              const permission = await gateCurrent(reviewTool, input)
              if (!isCurrent(token)) return
              if ('deny' in permission) { $.ui.toast(permission.deny); return }
              if (!live.on || owner !== await $.session.id() || !isCurrent(token)) return
              const request = startRequest($.plugin.root, { tier: 'adversary', brief, owner, cwd: current.cwd, resume: active.session })
              const result = await $.process.run(request.argv, request.init)
              if (result.exitCode !== 0) {
                if (owner === live.session) $.ui.toast(result.stderr || 'claudex: another round failed')
                return
              }
              const id = result.stdout.trim()
              if (!idPattern.test(id)) {
                if (owner === live.session) $.ui.toast('claudex-worker returned an invalid job id')
                return
              }
              await syncSessionCurrent()
              if (owner !== live.session) return
              changeReview(old => {
                const latest = old[review.id]
                if (!latest || latest.launching !== op || latest.active_round !== round.round) return old
                const nextRound = round.round + 1
                return { ...old, [review.id]: { ...latest, rounds: [...latest.rounds, emptyRound(nextRound, id)], active_round: nextRound, running: true } }
              })
              await ownCurrent(id, 'adversary', review.id, owner)
              rearmCurrent()
            } catch (cause) { if (owner === live.session) $.ui.toast(`claudex: another round failed: ${String(cause)}`) }
            finally {
              launching.delete(op)
              if (owner === live.session) changeReview(old => {
                const latest = old[review.id]
                return !latest || latest.launching !== op ? old : { ...old, [review.id]: { ...latest, launching: undefined } }
              })
              launchFinishedCurrent(op)
            }
          }} />}
        </Box>}
        <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: FINDINGS_PANE })} />
      </Box>
    )
  })
}
