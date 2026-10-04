import type { Register } from 'claude-code'
import { registerReviewTools } from './adversary.tsx'
import { registerAgents } from './agents.ts'
import { registerApproval } from './approve.ts'
import { registerCommands } from './commands.ts'
import { registerConfinement } from './confine.ts'
import { registerDelivery } from './delivery.ts'
import { registerJobs } from './jobs.ts'
import { registerWorkersPane } from './panes.tsx'
import { registerSteps } from './step.ts'

export const register: Register = on => {
  registerJobs(on)
  registerCommands(on)
  registerWorkersPane(on)
  registerDelivery(on)
  registerAgents(on)
  registerSteps(on)
  registerApproval(on)
  registerConfinement(on)
  registerReviewTools(on)
}
