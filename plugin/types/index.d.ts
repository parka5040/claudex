// Keep the published state contract self-contained; it mirrors hooks/agents.ts.
export type ClaudexAgent = {
  tier: 'luna' | 'sol' | 'astra'; cwd: string; prompt: string | null; mode: 'read' | 'edit'; model: string
  final: string | null
  thinking: Record<string, { type: 'thinking'; thinking: string; signature: string }[]>
}

export type ClaudexJobState = 'running' | 'done' | 'failed' | 'cancelled' | 'lost' | 'missing'
export type ClaudexJob = {
  id: string; tier: string | null; kind: 'worker' | 'adversary' | null; model: string | null; mode: string | null
  cwd: string | null; origin: 'mod' | 'bash' | null; owner: string | null; state: ClaudexJobState
  started: number | null; elapsed_s: number | null; rc: number | null; session: string | null
  has_findings: boolean; findings_error: string | null; legacy: boolean
}
export type ClaudexStatus = {
  policy: Record<string, string>
  policy_sources: Record<string, 'default' | 'file' | 'env'>
  proxy: { up: boolean; ours: boolean; port: number }
  token_hours_left: number | null
  plan: { used_pct: number; limit: string; age_s: number } | null
}
export type ClaudexDelivery = 'pending' | 'waiting' | 'claimed' | 'notified' | 'dropped' | 'delivered'
export type ClaudexOwned = {
  job: string; kind: 'adversary'; review: string | null; owner: string
  delivery: ClaudexDelivery; since: number; lease?: string
}
export type ClaudexFinding = {
  id: string; severity: 'critical' | 'high' | 'medium' | 'low'
  title: string; mechanism: string; evidence: string; fix: string; unverified: boolean
}
export type ClaudexVerdict = { stance: 'accepted' | 'rebutted' | 'unresolved'; note: string }
export type ClaudexRound = {
  round: number; job: string; session: string | null; findings: ClaudexFinding[] | null
  findings_error: string | null; report: string | null
  verdicts: Record<string, ClaudexVerdict>; decisions: Record<string, 'claude' | 'gpt'>; sent: string[]
}
export type ClaudexReview = {
  id: string; cwd: string; model: string; rounds: ClaudexRound[]; active_round: number; running: boolean
  launching?: string
}
declare module 'claude-code' {
  interface PluginState {
    claudex: {
      generation: number; on: boolean; status: ClaudexStatus | null; jobs: ClaudexJob[]
      owned: Record<string, ClaudexOwned>; agents: Record<string, ClaudexAgent>; reviews: Record<string, ClaudexReview>
      selected: string | null; report: { job: string; text: string } | null; toasted: string[]; alerted: string[]
    }
  }
}
