import type { On, ProcessRunResult } from 'claude-code'
import type { ClaudexJob, ClaudexOwned, ClaudexReview, ClaudexRound } from '../types/index.d.ts'
import { changeOwned, changeReviews, contextCurrent, currentToken, isCurrent, leaseFor, live, nextOperation, onRestore, onTick, rearmCurrent, syncSessionCurrent } from './jobs.ts'
import { jobsRequest, parseJobs, resultRequest } from './worker.ts'

const week = 7 * 24 * 60 * 60
const terminal = new Set(['done', 'failed', 'cancelled', 'lost', 'missing'])
const settled = new Set(['delivered', 'notified', 'dropped'])
type RetryingOwned = ClaudexOwned & { submitRejections?: number }
const ingesters: ((owned: ClaudexOwned, job: ClaudexJob, token: number) => Promise<string>)[] = []
let writes: Promise<void> = Promise.resolve()
let discovered = -1
const launchWaiters = new Map<string, (() => void)[]>()

export const onIngest = (fn: (owned: ClaudexOwned, job: ClaudexJob, token: number) => Promise<string>): void => { ingesters.push(fn) }
export const ownedHereCurrent = (job: string, session: string): boolean => live.owned[job]?.owner === session

// A discovered adversary child has no parent id until its start returns.
// Defer provisional ingestion until any in-flight round can register its id.
function pendingLaunch(entry: ClaudexOwned): string | undefined {
  if (entry.kind !== 'adversary' || entry.review !== entry.job) return undefined
  return Object.values(live.reviews).find(review => review.id !== entry.job && review.launching &&
    live.owned[review.id]?.owner === entry.owner)?.launching
}
export const launchPendingForCurrent = (entry: ClaudexOwned): boolean => !!pendingLaunch(entry)
export function launchFinishedCurrent(op: string): void {
  for (const resolve of launchWaiters.get(op) ?? []) resolve()
  launchWaiters.delete(op)
}
async function waitForLaunchCurrent(entry: ClaudexOwned): Promise<void> {
  let op: string | undefined
  while (live.session === entry.owner && (op = pendingLaunch(live.owned[entry.job] ?? entry))) {
    const launch = op
    await new Promise<void>(resolve => {
      const waiting = launchWaiters.get(launch) ?? []
      waiting.push(resolve)
      launchWaiters.set(launch, waiting)
    })
  }
}

function snapshot(session: string) {
  const jobs: Record<string, Omit<RetryingOwned, 'job'>> = {}
  for (const [id, entry] of Object.entries(live.owned)) {
    if (entry.owner !== session) continue
    jobs[id] = { kind: entry.kind, owner: entry.owner, review: entry.review, delivery: entry.delivery, since: entry.since,
      submitRejections: (entry as RetryingOwned).submitRejections }
  }
  const reviews: Record<string, unknown> = {}
  for (const [id, review] of Object.entries(live.reviews)) {
    if (live.owned[id]?.owner !== session) continue
    reviews[id] = { id, cwd: review.cwd, model: review.model, active_round: review.active_round,
      running: review.running, rounds: review.rounds.map(round => ({
        round: round.round, job: round.job, session: round.session,
        verdicts: round.verdicts, decisions: round.decisions, sent: round.sent,
      })) }
  }
  return { v: 1, jobs, reviews, alerted: live.alerted }
}

export async function persistCurrent(token = currentToken()): Promise<void> {
  const api = contextCurrent()
  const session = live.session
  const value = snapshot(session)
  writes = writes.catch(() => {}).then(async () => {
    if (!isCurrent(token)) return
    try {
      await api.setStore(`claudex:v1:${session}`, value)
    } catch {
      if (isCurrent(token)) api.toastOnce('store-full', 'claudex: persistent job storage unavailable; job state remains in this session')
    }
  })
  await writes
}
export const persistReviewsCurrent = persistCurrent

export async function ownCurrent(job: string, kind: ClaudexOwned['kind'], review: string | null, expectedOwner?: string): Promise<boolean> {
  const api = contextCurrent()
  await syncSessionCurrent()
  const session = live.session
  if (expectedOwner !== undefined && expectedOwner !== session) {
    api.toast(`claudex: job ${job} started in an earlier conversation`)
    return false
  }
  const since = Math.floor((await api.now()) / 1000)
  if (session !== live.session) return false
  changeOwned(old => {
    const entry = old[job]
    if (!entry) return { ...old, [job]: { job, kind, review, owner: session, delivery: 'pending', since } }
    if (entry.owner !== session || entry.kind === kind && entry.review === review) return old
    return { ...old, [job]: { ...entry, kind, review } }
  })
  void persistCurrent()
  rearmCurrent()
  return true
}

// Reservation/claim is synchronous: no snapshot read or await between check and set.
export function transitionCurrent(id: string, from: ClaudexOwned['delivery'], to: ClaudexOwned['delivery'], token = currentToken(), lease?: string): boolean {
  if (!isCurrent(token) || live.owned[id]?.delivery !== from) return false
  changeOwned(old => ({ ...old, [id]: { ...old[id]!, delivery: to, lease: to === 'waiting' ? leaseFor(token) : lease } }))
  void persistCurrent(token)
  rearmCurrent()
  return true
}

function settleSubmission(id: string, owner: string, op: string, to: 'notified' | 'dropped' | 'pending'): boolean {
  const entry = live.owned[id]
  if (live.session !== owner || entry?.owner !== owner || entry.delivery !== 'claimed' || entry.lease !== op) return false
  changeOwned(old => ({ ...old, [id]: { ...old[id]!, delivery: to, lease: undefined, submitRejections: undefined } }))
  void persistCurrent()
  rearmCurrent()
  return true
}

function rejectSubmission(id: string, owner: string, op: string): boolean | undefined {
  const entry = live.owned[id]
  if (live.session !== owner || entry?.owner !== owner || entry.delivery !== 'claimed' || entry.lease !== op) return undefined
  const count = ((entry as RetryingOwned).submitRejections ?? 0) + 1
  changeOwned(old => ({ ...old, [id]: { ...old[id]!, delivery: count >= 3 ? 'dropped' : 'pending',
    lease: undefined, submitRejections: count } }))
  void persistCurrent()
  rearmCurrent()
  return count >= 3
}

async function lookup(ids: string[]): Promise<ClaudexJob[]> {
  const api = contextCurrent()
  const request = jobsRequest(api.root, { ids })
  const result = await api.run(request.argv, request.init)
  return parseJobs(result)
}

export async function ingestWaitCurrent(id: string, token = currentToken()): Promise<void> {
  const owned = live.owned[id]
  if (!isCurrent(token) || owned?.kind !== 'adversary' || !ingesters.length) return
  const session = await contextCurrent().session()
  if (!isCurrent(token) || owned.owner !== session) return
  const [job] = await lookup([id])
  if (!isCurrent(token)) return
  await waitForLaunchCurrent(owned)
  if (!isCurrent(token)) return
  const current = live.owned[id]
  if (current?.owner === session && job && job.state !== 'missing' && job.owner === session) {
    for (const fn of ingesters) {
      await fn(current, job, token)
      if (!isCurrent(token)) return
    }
  }
}

async function restore(token: number): Promise<void> {
  const api = contextCurrent()
  const session = live.session
  const stored = await api.getStore(`claudex:v1:${session}`) as {
    v?: number; jobs?: Record<string, Partial<RetryingOwned>>; reviews?: Record<string, ClaudexReview>; alerted?: string[]
  } | undefined
  if (!isCurrent(token)) return
  const now = Math.floor((await api.now()) / 1000)
  if (!isCurrent(token)) return
  if (stored?.v === 1 && stored.jobs) {
    const loaded: Record<string, RetryingOwned> = {}
    for (const [id, entry] of Object.entries(stored.jobs)) {
      if (!/^[0-9]+-(?:[0-9a-f]{8}|[0-9]+)$/.test(id) ||
        typeof entry.since !== 'number' || entry.since < now - week || entry.since > now ||
        entry.kind !== 'adversary' ||
        !['pending', 'waiting', 'claimed', 'notified', 'dropped', 'delivered'].includes(entry.delivery ?? '') ||
        (entry.owner !== undefined && entry.owner !== session)) continue
      loaded[id] = { job: id, kind: entry.kind as ClaudexOwned['kind'], owner: session,
        review: typeof entry.review === 'string' ? entry.review : null,
        delivery: entry.delivery as ClaudexOwned['delivery'], since: entry.since,
        submitRejections: Number.isInteger(entry.submitRejections) && (entry.submitRejections ?? 0) >= 1 &&
          (entry.submitRejections ?? 0) <= 2 ? entry.submitRejections : undefined }
    }
    changeOwned(old => {
      const next = { ...old }
      for (const [id, entry] of Object.entries(loaded)) if (!next[id]) next[id] = entry
      return next
    })
  }
  if (stored?.v === 1 && stored.reviews) {
    const loaded: Record<string, ClaudexReview> = {}
    for (const [id, review] of Object.entries(stored.reviews)) {
      if (live.owned[id]?.kind !== 'adversary' || !Array.isArray(review.rounds)) continue
      const rounds: ClaudexRound[] = review.rounds.filter(round =>
        typeof round.job === 'string' && Number.isInteger(round.round)).map(round => ({
          round: round.round, job: round.job, session: round.session ?? null,
          findings: null, findings_error: null, report: null,
          verdicts: round.verdicts ?? {}, decisions: round.decisions ?? {}, sent: round.sent ?? [],
        }))
      if (rounds.length) loaded[id] = { id, cwd: review.cwd, model: review.model, rounds,
        active_round: review.active_round, running: review.running }
    }
    changeReviews(old => {
      const next = { ...old }
      for (const [id, review] of Object.entries(loaded)) if (!next[id]) next[id] = review
      return next
    })
  }
  if (stored?.v === 1 && Array.isArray(stored.alerted)) live.alerted = [...new Set([...live.alerted, ...stored.alerted])]
  if (isCurrent(token)) void persistCurrent(token)
}

async function adopt(jobs: ClaudexJob[], token: number): Promise<void> {
  if (!isCurrent(token)) return
  const session = await contextCurrent().session()
  if (!isCurrent(token) || session !== live.session) return
  const adopted = jobs.filter((job): job is ClaudexJob & { kind: 'adversary' } =>
    job.origin === 'mod' && job.owner === session && job.kind === 'adversary' && !live.owned[job.id])
  if (!adopted.length) return
  const since = Math.floor((await contextCurrent().now()) / 1000)
  if (!isCurrent(token) || session !== await contextCurrent().session() || !isCurrent(token)) return
  changeOwned(old => {
    const next = { ...old }
    for (const job of adopted) {
      if (next[job.id]) continue
      next[job.id] = {
        job: job.id, kind: job.kind, owner: session, review: job.id,
        delivery: 'pending', since: job.started ?? since,
      }
    }
    return next
  })
  void persistCurrent(token)
  rearmCurrent()
}

export function registerDelivery(_on: On): void {
  onRestore(async token => {
    try { await restore(token) } catch (error) {
      if (isCurrent(token)) contextCurrent().toast(`claudex: job reconciliation failed: ${String(error)}`)
    }
  })
  onTick(deliver)
}

function reportText(job: ClaudexJob, result: ProcessRunResult): string {
  const text = result.stdout || result.stderr || '(no report available)'
  return `claudex job ${job.id} (${job.tier ?? '?'}, ${job.model ?? '?'}) finished: ${job.state}.\n\n` +
    text.slice(0, 20000) + (text.length > 20000 || result.isStdoutTruncated
      ? `\n\n[Report shortened; use claudex-worker result ${job.id} for the full report.]` : '')
}

export async function deliver(token: number, _displayJobs: ClaudexJob[]): Promise<void> {
  const api = contextCurrent()
  if (!isCurrent(token)) return
  if (discovered !== token) {
    const request = jobsRequest(api.root, { owner: live.session })
    const response = await api.run(request.argv, request.init)
    if (!isCurrent(token)) return
    await adopt(parseJobs(response), token)
    if (!isCurrent(token)) return
    discovered = token
  }
  const ids = Object.values(live.owned).filter(entry => !settled.has(entry.delivery)).map(entry => entry.job)
  if (!ids.length) return
  const jobs = await lookup(ids)
  if (!isCurrent(token)) return
  for (const job of jobs) {
    if (!isCurrent(token)) return
    const entry = live.owned[job.id]
    if (!terminal.has(job.state) || entry?.delivery !== 'pending' || launchPendingForCurrent(entry)) continue
    const session = await api.session()
    if (!isCurrent(token)) return
    if (entry.owner !== session || (job.state !== 'missing' && job.owner !== session)) {
      if (transitionCurrent(job.id, 'pending', 'dropped', token)) api.toast(`claudex: job ${job.id} finished in an earlier conversation`)
      continue
    }
    const op = `${leaseFor(token)}:${nextOperation()}`
    if (!transitionCurrent(job.id, 'pending', 'claimed', token, op)) continue
    let issued = false
    try {
      let text: string
      if (job.state === 'missing') text = `claudex job ${job.id}: result expired (pruned)`
      else if (ingesters.length) {
        text = (await Promise.all(ingesters.map(fn => fn(entry, job, token)))).join('\n')
      } else {
        const request = resultRequest(api.root, job.id)
        const result = await api.run(request.argv, request.init)
        text = reportText(job, result)
      }
      if (!isCurrent(token)) return
      if (session !== await api.session()) {
        if (isCurrent(token) && transitionCurrent(job.id, 'claimed', 'dropped', token)) api.toast(`claudex: job ${job.id} finished in an earlier conversation`)
        continue
      }
      if (!isCurrent(token)) return
      const claimed = live.owned[job.id]
      if (text === '' || claimed?.owner !== session || claimed.delivery !== 'claimed' ||
        claimed.lease !== op || launchPendingForCurrent(claimed)) continue
      // Issuing a prompt is irreversible: retain its lease across activations.
      live.inflight.add(op)
      issued = true
      void (async () => {
        try {
          let response: Awaited<ReturnType<typeof api.submit>>
          try {
            response = await api.submit(text)
          } catch (error) {
            if (rejectSubmission(job.id, session, op)) api.toast(`claudex: job ${job.id} notification failed after 3 attempts: ${String(error)}`)
            return
          }
          if ('drop' in response) {
            if (settleSubmission(job.id, session, op, 'dropped')) api.toast(`claudex: job ${job.id} notification dropped: ${response.drop}`)
            return
          }
          if (!settleSubmission(job.id, session, op, 'notified')) return
          try {
            if (session !== await api.session()) { await syncSessionCurrent(); return }
          } catch {
            return // The prompt was sent; an unavailable session id cannot make it retryable.
          }
          const duration = Math.max(0, Math.floor(job.elapsed_s ?? 0))
          api.toast(`claudex: ${job.tier ?? 'worker'} job ${job.id} ${job.state} (${Math.floor(duration / 60)}m${duration % 60}s)`)
        } finally {
          live.inflight.delete(op)
        }
      })()
    } catch (error) {
      if (isCurrent(token) && transitionCurrent(job.id, 'claimed', 'dropped', token)) {
        api.toast(`claudex: job ${job.id} notification failed: ${String(error)}`)
      }
    } finally {
      if (!issued && isCurrent(token) && live.owned[job.id]?.lease === op) transitionCurrent(job.id, 'claimed', 'pending', token)
    }
  }
}
