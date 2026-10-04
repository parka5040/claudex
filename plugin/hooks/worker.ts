import type { ProcessRunResult } from 'claude-code'
import type { ClaudexFinding, ClaudexJob, ClaudexStatus } from '../types/index.d.ts'
import type { Tier } from './agents.ts'

export type Request = {
  argv: string[]
  init: { stdin?: string; env?: Record<string, string>; timeoutMs: number }
}
export class WorkerUnavailable extends Error {}

// Only pure argv builders live here; the hook's own module invokes process.run.
function request(root: string, args: string[], init: Request['init']): Request {
  return { argv: [`${root}/bin/claudex-worker`, ...args], init }
}
function json<T>(result: ProcessRunResult, command: string): T {
  if (result.exitCode !== 0) throw new WorkerUnavailable(result.stderr || `claudex-worker ${command} failed (${result.exitCode})`)
  try { return JSON.parse(result.stdout) as T }
  catch (error) { throw new WorkerUnavailable(`claudex-worker ${command} returned invalid JSON: ${String(error)}`) }
}
export const parseStatus = (result: ProcessRunResult): ClaudexStatus => json(result, 'status')
export const parseJobs = (result: ProcessRunResult): ClaudexJob[] => json(result, 'jobs')
export function parseFindings(result: ProcessRunResult): ClaudexFinding[] | null {
  if (result.exitCode === 1) return null
  return json(result, 'findings')
}
export const admitRequest = (root: string, tier: Tier, running: number): Request =>
  request(root, ['admit', tier, '--running', String(running)], { timeoutMs: 15_000 })
export const stepArgv = (root: string, tier: Tier): string[] => [`${root}/bin/claudex-worker`, 'step', tier]
export const statusRequest = (root: string): Request => request(root, ['status', '--json'], { timeoutMs: 15_000 })
export function jobsRequest(root: string, options: { limit?: number; ids?: string[]; owner?: string } = {}): Request {
  const args = ['jobs', '--json']
  if (options.ids?.length) {
    for (const id of options.ids) args.push('--id', id)
  } else if (options.owner !== undefined) args.push('--owner', options.owner)
  else args.push('--limit', String(options.limit ?? 20))
  return request(root, args, { timeoutMs: 15_000 })
}
export function startRequest(root: string, input: {
  tier: string; brief: string; owner: string; cwd?: string; mode?: 'read' | 'edit'
  effort?: string; resume?: string
}): Request {
  const args = ['start', input.tier]
  if (input.cwd) args.push('--cwd', input.cwd)
  if (input.mode) args.push('--mode', input.mode)
  if (input.effort) args.push('--effort', input.effort)
  if (input.resume) args.push('--resume', input.resume)
  return request(root, args, {
    stdin: input.brief, env: { CLAUDEX_JOB_ORIGIN: 'mod', CLAUDEX_JOB_OWNER: input.owner }, timeoutMs: 30_000,
  })
}
export const waitRequest = (root: string, job: string, seconds: number): Request =>
  request(root, ['wait', job, '--timeout', String(seconds)], { timeoutMs: (seconds + 30) * 1000 })
export const cancelRequest = (root: string, job: string): Request =>
  request(root, ['cancel', job], { timeoutMs: 20_000 })
export const findingsRequest = (root: string, job: string): Request =>
  request(root, ['findings', job], { timeoutMs: 15_000 })
export const resultRequest = (root: string, job: string): Request =>
  request(root, ['result', job], { timeoutMs: 15_000 })
export const setRequest = (root: string, key: string, value: string): Request =>
  request(root, ['set', key, value], { timeoutMs: 15_000 })
