import { atom, read } from 'claude-code'
import type { EngineInterface, On, Timer, ProcessRunResult, PromptSubmitResult, ToolSpec } from 'claude-code'
import type { ClaudexJob, ClaudexStatus, ClaudexOwned, ClaudexReview } from '../types/index.d.ts'
import type { ClaudexAgent } from './agents.ts'
import { jobsRequest, parseJobs, parseStatus, statusRequest } from './worker.ts'

const generation = atom({ plugin: 'claudex', key: 'generation' } as const, 0)
const on = atom({ plugin: 'claudex', key: 'on' } as const, false)
const statusState = atom({ plugin: 'claudex', key: 'status' } as const, null)
const jobState = atom({ plugin: 'claudex', key: 'jobs' } as const, [])
const owned = atom({ plugin: 'claudex', key: 'owned' } as const, {})
const agents = atom({ plugin: 'claudex', key: 'agents' } as const, {})
const reviews = atom({ plugin: 'claudex', key: 'reviews' } as const, {})
const selected = atom({ plugin: 'claudex', key: 'selected' } as const, null)
const report = atom({ plugin: 'claudex', key: 'report' } as const, null)
const toasted = atom({ plugin: 'claudex', key: 'toasted' } as const, [])
const alertedState = atom({ plugin: 'claudex', key: 'alerted' } as const, [])

export const S = { generation, on, status: statusState, jobs: jobState, owned, agents, reviews, selected, report, toasted, alerted: alertedState }

// The host's state.get is a per-dispatch snapshot. All coordination happens here,
// synchronously, before yielding; state and store are only published projections.
export const live: {
  token: number; session: string; on: boolean; status: ClaudexStatus | null; jobs: ClaudexJob[]
  owned: Record<string, ClaudexOwned>; agents: Record<string, ClaudexAgent>; reviews: Record<string, ClaudexReview>
  selected: string | null; toasted: string[]; alerted: string[]; inflight: Set<string>
} = { token: 0, session: '', on: false, status: null, jobs: [], owned: {}, agents: {}, reviews: {},
  selected: null, toasted: [], alerted: [], inflight: new Set() }

const instance = crypto.randomUUID()
let operation = 0
export const nextOperation = (): string => String(++operation)
export const leaseFor = (token: number): string => `${instance}:${token}`
export const currentToken = (): number => live.token
export const isCurrent = (token: number): boolean => token === live.token
export function changeOwned(fn: (old: Record<string, ClaudexOwned>) => Record<string, ClaudexOwned>): void {
  const next = fn(live.owned)
  if (next === live.owned) return
  live.owned = next
  void contextCurrent().publishOwned(next)
}
export function changeReviews(fn: (old: Record<string, ClaudexReview>) => Record<string, ClaudexReview>): void {
  const next = fn(live.reviews)
  if (next === live.reviews) return
  live.reviews = next
  void contextCurrent().publishReviews(next)
}
export function selectReview(id: string | null): void {
  live.selected = id
  void contextCurrent().publishSelected(id)
}
export function alertRound(key: string): boolean {
  if (live.alerted.includes(key)) return false
  live.alerted = [...live.alerted, key]
  void contextCurrent().publishAlerted(live.alerted)
  return true
}

export type CurrentContext = {
  root: string
  cwd: string
  session: () => Promise<string>
  checkTool: (tool: string, input: unknown) => Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string }>
  now: () => Promise<number>
  run: (argv: string[], init: { stdin?: string; env?: Record<string, string>; timeoutMs: number }) => Promise<ProcessRunResult>
  getStore: (key: string) => Promise<unknown>
  setStore: (key: string, value: unknown) => Promise<void>
  submit: (text: string) => Promise<PromptSubmitResult>
  toast: (text: string) => void
  registerTool: (spec: ToolSpec) => Promise<void>
  registerAgent: EngineInterface['agent']['register']
  listAgents: EngineInterface['agent']['list']
  publishAgents: (entries: Record<string, ClaudexAgent>) => Promise<void>
  publishOwned: (entries: Record<string, ClaudexOwned>) => Promise<void>
  publishReviews: (entries: Record<string, ClaudexReview>) => Promise<void>
  publishSelected: (id: string | null) => Promise<void>
  publishAlerted: (keys: string[]) => Promise<void>
  toastOnce: (key: string, text: string) => void
}
let currentContext: CurrentContext | undefined
let agentWrites: Promise<void> = Promise.resolve()
let ownedWrites: Promise<void> = Promise.resolve()
let reviewWrites: Promise<void> = Promise.resolve()
let selectedWrites: Promise<void> = Promise.resolve()
let alertWrites: Promise<void> = Promise.resolve()
export function contextCurrent(): CurrentContext {
  if (!currentContext) throw new Error('claudex session has not started')
  return currentContext
}

type Tick = (gen: number, jobs: ClaudexJob[]) => Promise<void>
const ticks: Tick[] = []
const enabled: (() => Promise<void>)[] = []
const policyChanged: (() => Promise<void>)[] = []
const sessionReady: (() => Promise<void>)[] = []
const restorers: ((token: number) => Promise<void>)[] = []
export const onTick = (fn: Tick): void => { ticks.push(fn) }
export const onEnable = (fn: () => Promise<void>): void => { enabled.push(fn) }
export const onPolicyChange = (fn: () => Promise<void>): void => { policyChanged.push(fn) }
export async function policyChangedCurrent(): Promise<void> {
  for (const fn of policyChanged) await fn()
}
export const onSessionReady = (fn: () => Promise<void>): void => { sessionReady.push(fn) }
export const onRestore = (fn: (token: number) => Promise<void>): void => { restorers.push(fn) }
let timer: Timer | undefined
let cadence = 0
let inFlight: number | null = null
let lastStatusAt = 0
let firstPoll = false
let activateLater: () => Promise<void> = async () => {}
let pollLater: () => Promise<void> = async () => {}
let rearmLater: () => void = () => {}
let syncLater: () => Promise<void> = async () => {}
let sessionBoot: Promise<void> | undefined
export const rearmCurrent = (): void => rearmLater()
export const activateCurrent = (): Promise<void> => activateLater()
export const pollCurrent = (): Promise<void> => pollLater()
export const syncSessionCurrent = (): Promise<void> => syncLater()

async function getStatus($: EngineInterface): Promise<ClaudexStatus> {
  const request = statusRequest($.plugin.root)
  const result = await $.process.run(request.argv, request.init)
  return parseStatus(result)
}
async function listJobs($: EngineInterface): Promise<ClaudexJob[]> {
  const request = jobsRequest($.plugin.root, { limit: 20 })
  const result = await $.process.run(request.argv, request.init)
  return parseJobs(result)
}

export function registerJobs(registrar: On): void {
  registrar('session.start', async ($, e, next) => {
    const started = await next(e)
    activateLater = () => activate($)
    pollLater = () => poll($)
    rearmLater = () => arm($, live.token)
    syncLater = () => syncSession($)
    currentContext = {
      root: $.plugin.root, cwd: e.cwd,
      session: () => $.session.id(),
      checkTool: (tool, input) => $.tool.check({ tool, input }),
      now: () => $.clock.now(),
      run: (argv, init) => $.process.run(argv, init),
      getStore: key => $.store.get(key),
      setStore: (key, value) => $.store.set(key, value),
      submit: text => $.prompt.submit({ text }),
      toast: text => { $.ui.toast(text) },
      registerTool: async spec => { await $.tool.register(spec) },
      registerAgent: spec => $.agent.register(spec),
      listAgents: () => $.agent.list(),
      publishAgents: entries => {
        agentWrites = agentWrites.then(async () => { await $.state.set({ plugin: 'claudex', key: 'agents' } as const, entries) }).catch(() => {})
        return agentWrites
      },
      publishOwned: entries => {
        ownedWrites = ownedWrites.then(async () => { await $.state.set({ plugin: 'claudex', key: 'owned' } as const, entries) }).catch(() => {})
        return ownedWrites
      },
      publishReviews: entries => {
        reviewWrites = reviewWrites.then(async () => { await $.state.set({ plugin: 'claudex', key: 'reviews' } as const, entries) }).catch(() => {})
        return reviewWrites
      },
      publishSelected: id => {
        selectedWrites = selectedWrites.then(async () => { await $.state.set({ plugin: 'claudex', key: 'selected' } as const, id) }).catch(() => {})
        return selectedWrites
      },
      publishAlerted: keys => {
        alertWrites = alertWrites.then(async () => { await $.state.set({ plugin: 'claudex', key: 'alerted' } as const, keys) }).catch(() => {})
        return alertWrites
      },
      toastOnce: (key, text) => { void warn($, live.token, key, text) },
    }
    await $.command.register({
      name: 'claudex', description: 'claudex: status, config, workers, findings',
      argumentHint: '[status|config [KEY VALUE]|workers|findings [JOB]]',
    })
    await activate($, true)
    return started
  })
}

export function statusLine(status: ClaudexStatus | null, jobs: ClaudexJob[]): string | undefined {
  if (!status || status.policy.CLAUDEX !== 'on') return undefined
  if (status.proxy.up && !status.proxy.ours) return 'port taken'
  const count = jobs.filter(job => job.state === 'running').length + Object.keys(live.agents).length
  const pieces = [count ? `${count} running` : 'idle']
  if (status.plan) pieces.push(status.plan.age_s > 3600 ? 'usage ?' : `usage ${Math.round(status.plan.used_pct)}%`)
  if (status.token_hours_left !== null) {
    const hours = Math.max(0, Math.floor(status.token_hours_left))
    pieces.push(hours < 24 ? `login ${hours}h!` : `login ${Math.floor(hours / 24)}d`)
  }
  return pieces.join(' · ')
}

function arm($: EngineInterface, gen: number): void {
  if (!isCurrent(gen)) return
  const undelivered = Object.values(live.owned).some(entry => !['delivered', 'notified', 'dropped'].includes(entry.delivery))
  const interval = !live.on && !undelivered && !Object.keys(live.agents).length ? 0 :
    firstPoll || live.jobs.some(job => job.state === 'running') || undelivered || Object.keys(live.agents).length ? 2000 : 60000
  if (cadence === interval && timer) return
  timer?.cancel()
  timer = undefined
  cadence = interval
  if (interval) timer = $.clock.every(interval, () => { void poll($, gen) })
}

async function syncSession($: EngineInterface): Promise<void> {
  const session = await $.session.id()
  if (session === live.session) {
    if (sessionBoot) await sessionBoot
    return
  }
  const previous = live.session
  live.session = session
  changeOwned(() => ({}))
  live.agents = {}
  void contextCurrent().publishAgents({})
  changeReviews(() => ({}))
  selectReview(null)
  live.alerted = []
  void contextCurrent().publishAlerted([])
  live.toasted = []
  live.jobs = []
  void $.state.set({ plugin: 'claudex', key: 'jobs' } as const, [])
  const boot = activate($)
  sessionBoot = boot
  if (previous) $.ui.toast('claudex: earlier jobs belong to the previous conversation')
  try { await boot } finally { if (sessionBoot === boot) sessionBoot = undefined }
}

export async function activate($: EngineInterface, reload = false): Promise<void> {
  // Bump before the first await, invalidating every old continuation and claim.
  const gen = ++live.token
  timer?.cancel()
  timer = undefined
  cadence = 0
  firstPoll = false
  await $.state.set({ plugin: 'claudex', key: 'generation' } as const, gen)
  if (!isCurrent(gen)) return
  if (reload) {
    const session = await $.session.id()
    if (!isCurrent(gen)) return
    const sameSession = !live.session || live.session === session
    const [snapshotOwned, snapshotAgents, snapshotReviews, snapshotSelected, snapshotToasted, snapshotAlerted] = await Promise.all([
      read($, owned), read($, agents), read($, reviews), read($, selected), read($, toasted), read($, alertedState),
    ])
    if (!isCurrent(gen)) return
    live.session = session
    live.owned = sameSession ? snapshotOwned : {}
    live.agents = sameSession ? snapshotAgents : {}
    live.reviews = sameSession ? snapshotReviews : {}
    live.selected = sameSession ? snapshotSelected : null
    live.toasted = sameSession ? snapshotToasted : []
    live.alerted = sameSession ? snapshotAlerted : []
  }
  for (const fn of restorers) {
    await fn(gen)
    if (!isCurrent(gen)) return
  }
  // A fetch claimed in this module and generation is active before it enters inflight.
  const reset = Object.fromEntries(Object.entries(live.owned).map(([id, entry]) => [id,
    (entry.delivery === 'waiting' && entry.lease !== leaseFor(gen) ||
      entry.delivery === 'claimed' && !entry.lease?.startsWith(`${leaseFor(gen)}:`) && !live.inflight.has(entry.lease ?? ''))
      ? { ...entry, delivery: 'pending' as const, lease: undefined } : entry]))
  changeOwned(() => reset)
  for (const fn of sessionReady) {
    await fn()
    if (!isCurrent(gen)) return
  }
  const status = await getStatus($)
  if (!isCurrent(gen)) return
  const wasOn = live.on
  live.status = status
  live.on = status.policy.CLAUDEX === 'on'
  await $.state.set({ plugin: 'claudex', key: 'status' } as const, status)
  if (!isCurrent(gen)) return
  await $.state.set({ plugin: 'claudex', key: 'on' } as const, live.on)
  if (!isCurrent(gen)) return
  if (live.on) {
    for (const fn of enabled) {
      await fn()
      if (!isCurrent(gen)) return
    }
    lastStatusAt = await $.clock.now()
    if (!isCurrent(gen)) return
    $.ui.status(statusLine(status, live.jobs))
    firstPoll = true
  } else if (wasOn) $.ui.status(undefined)
  arm($, gen)
  // Cold-off has no timer, but a job created just before a crash may be absent
  // from both published copies. A one-shot poll discovers it by worker owner.
  if (!live.on && isCurrent(gen)) await poll($, gen, false)
}

function warn($: EngineInterface, gen: number, key: string, text: string): void {
  if (!isCurrent(gen) || live.toasted.includes(key)) return
  live.toasted = [...live.toasted, key]
  void $.state.set({ plugin: 'claudex', key: 'toasted' } as const, live.toasted)
  $.ui.toast(text)
}

export async function poll($: EngineInterface, gen = live.token, sync = true): Promise<void> {
  if (sync) await syncSession($)
  // One guard across all activations; acquired without yielding to another callback.
  if (!isCurrent(gen) || inFlight !== null) return
  inFlight = gen
  try {
    const jobs = await listJobs($)
    if (!isCurrent(gen)) return
    live.jobs = jobs
    await $.state.set({ plugin: 'claudex', key: 'jobs' } as const, jobs)
    if (!isCurrent(gen)) return
    let status = live.status
    const now = await $.clock.now()
    if (!isCurrent(gen)) return
    if (now - lastStatusAt >= 30000) {
      status = await getStatus($)
      if (!isCurrent(gen)) return
      if ((status.policy.CLAUDEX === 'on') !== live.on) {
        await activate($)
        return
      }
      lastStatusAt = now
      const previousPolicy = live.status?.policy
      live.status = status
      await $.state.set({ plugin: 'claudex', key: 'status' } as const, status)
      if (!isCurrent(gen)) return
      if (status.policy.CLAUDEX_WORKER_MODE !== previousPolicy?.CLAUDEX_WORKER_MODE ||
        status.policy.CLAUDEX_TIERS !== previousPolicy?.CLAUDEX_TIERS) {
        await policyChangedCurrent()
        if (!isCurrent(gen)) return
      }
    }
    for (const fn of ticks) {
      await fn(gen, jobs)
      if (!isCurrent(gen)) return
    }
    if (live.on) $.ui.status(statusLine(status, jobs))
    if (live.on && status) {
      if (status.token_hours_left !== null && status.token_hours_left < 24) {
        warn($, gen, 'login', `claudex: login expires in ${Math.floor(status.token_hours_left)}h`)
      }
      if (status.plan && status.plan.age_s <= 3600) {
        if (status.plan.used_pct >= 80) warn($, gen, 'plan-80', 'claudex: plan usage passed 80%')
        if (status.plan.used_pct >= 95) warn($, gen, 'plan-95', 'claudex: plan usage passed 95%')
      }
    }
    firstPoll = false
    arm($, gen)
  } finally {
    if (inFlight === gen) {
      inFlight = null
      if (!isCurrent(gen) && !live.on) void poll($, live.token)
    }
  }
}
