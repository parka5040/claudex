import type { EngineInterface, On } from 'claude-code'
import type { ClaudexJob, ClaudexStatus } from '../types/index.d.ts'
import { FINDINGS_PANE } from './adversary.tsx'
import { activateCurrent, live, policyChangedCurrent, selectReview, syncSessionCurrent } from './jobs.ts'
import { WORKERS_PANE } from './panes.tsx'
import { jobsRequest, parseJobs, parseStatus, setRequest, statusRequest } from './worker.ts'

async function getStatus($: EngineInterface): Promise<ClaudexStatus> {
  const request = statusRequest($.plugin.root)
  return parseStatus(await $.process.run(request.argv, request.init))
}
async function listJobs($: EngineInterface, limit: number): Promise<ClaudexJob[]> {
  const request = jobsRequest($.plugin.root, { limit })
  return parseJobs(await $.process.run(request.argv, request.init))
}
async function setKey($: EngineInterface, key: string, value: string) {
  const request = setRequest($.plugin.root, key, value)
  return $.process.run(request.argv, request.init)
}

export function registerCommands(on: On): void {
  on('command.run', { command: 'claudex' }, ($, e) => command($, e.args))
}

const descriptions: Record<string, string> = {
  CLAUDEX: 'master switch',
  CLAUDEX_DELEGATION: 'on-request, suggest, auto, off',
  CLAUDEX_ADVERSARY: 'on-request, plans, plans+diffs, off',
  CLAUDEX_TIERS: 'enabled worker tiers',
  CLAUDEX_DEFAULT_WORKER: 'default worker tier',
  CLAUDEX_ADVERSARY_MODEL: 'adversary model',
  CLAUDEX_MAX_PARALLEL: '1-16; extra workers queue',
  CLAUDEX_WORKER_MODE: 'edit or read; yolo is per call only',
}
const keys = Object.keys(descriptions)
const usage = 'Usage: /claudex [status|config [KEY VALUE]|workers|findings [JOB]]'

function policyLine(s: ClaudexStatus, key: string): string {
  return `${key.padEnd(25)} ${String(s.policy[key] ?? '?').padEnd(24)} ${s.policy_sources[key] ?? '?'}  ${descriptions[key]}`
}
async function synchronize($: EngineInterface, status: ClaudexStatus): Promise<void> {
  if ((status.policy.CLAUDEX === 'on') !== live.on) await activateCurrent()
  else {
    const previous = live.status?.policy
    live.status = status
    await $.state.set({ plugin: 'claudex', key: 'status' } as const, status)
    if (status.policy.CLAUDEX_WORKER_MODE !== previous?.CLAUDEX_WORKER_MODE ||
      status.policy.CLAUDEX_TIERS !== previous?.CLAUDEX_TIERS) await policyChangedCurrent()
  }
}

async function showStatus($: EngineInterface) {
  const [status, jobs] = await Promise.all([getStatus($), listJobs($, 5)])
  await synchronize($, status)
  return { text: [
    'Key                       Effective                Source  Meaning',
    ...keys.map(key => policyLine(status, key)),
    `Proxy: ${status.proxy.up ? status.proxy.ours ? 'running' : 'port taken' : 'stopped'} (${status.proxy.port})`,
    `Plan: ${status.plan ? `${status.plan.used_pct}% (${status.plan.limit}, ${status.plan.age_s}s old)` : 'unknown'}`,
    ...(status.models ? [`Models: luna=${status.models.luna} sol=${status.models.sol} astra=${status.models.astra} (${status.models.source})`] : []),
    ...status.deprecations,
    'Recent jobs:',
    ...jobs.slice(0, 5).map(job => `${job.id}  ${job.tier ?? '?'}  ${job.model ?? '?'}  ${job.state}`),
  ].join('\n') }
}
async function showConfig($: EngineInterface, args: string[]) {
  if (args.length === 0) {
    const status = await getStatus($)
    await synchronize($, status)
    return { text: ['Key                       Effective                Source  Meaning', ...keys.map(key => policyLine(status, key))].join('\n') }
  }
  if (args.length !== 2 || !keys.includes(args[0] ?? '')) return { text: usage }
  const [key, value] = args as [string, string]
  const before = await getStatus($)
  const result = await setKey($, key, value)
  if (result.exitCode !== 0) {
    await synchronize($, before)
    return { text: result.stderr || `claudex-worker set failed (${result.exitCode})` }
  }
  const after = await getStatus($)
  await synchronize($, after)
  if (after.policy[key] !== before.policy[key]) return {
    text: policyLine(after, key),
    context: [`claudex policy changed: ${key}=${after.policy[key]}. This overrides the session-start policy line for the rest of this session.`],
  }
  if (after.policy_sources[key] === 'env') return {
    text: `${key}=${value} stored in the config file, but this session's environment sets ${key}=${after.policy[key]} which wins; it takes effect in a new session without that variable.`,
  }
  return { text: policyLine(after, key) }
}
async function showWorkers($: EngineInterface) {
  await $.ui.open({ id: WORKERS_PANE, title: 'claudex workers' })
  return { text: 'Workers pane opened.' }
}
async function showFindings($: EngineInterface, args: string[]) {
  if (args.length > 1) return { text: usage }
  const reviews = live.reviews
  const wanted = args[0]
  const id = wanted ? (reviews[wanted] ? wanted : Object.values(reviews).find(review =>
    review.rounds.some(round => round.job === wanted))?.id) : Object.keys(reviews).at(-1)
  if (wanted && !id) return { text: `Unknown review ${wanted}.` }
  selectReview(id ?? null)
  await $.ui.open({ id: FINDINGS_PANE, title: 'claudex adversary review' })
  return { text: 'Findings pane opened.' }
}

export const subcommands: Record<string, ($: EngineInterface, args: string[]) => Promise<{ text: string; context?: string[] }>> = {
  status: showStatus, config: showConfig, workers: showWorkers, findings: showFindings,
}

export async function command($: EngineInterface, args: string): Promise<{ text: string; context?: string[] }> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const name = parts.shift() ?? 'status'
  try {
    await syncSessionCurrent()
    if (name === 'status') return await showStatus($)
    if (name === 'config') return await showConfig($, parts)
    if (name === 'workers') return await showWorkers($)
    if (name === 'findings') return await showFindings($, parts)
    return { text: usage }
  } catch (error) {
    return { text: `claudex: ${String(error)}` }
  }
}
