import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Hook, On } from 'claude-code'
import { isGptCall, recordGptCall, registerApproval } from '../hooks/approve.ts'

function approvalHook(): Hook<'tool.check'> {
  let hook: Hook<'tool.check'> | undefined
  registerApproval(((name: string, callback: Hook<'tool.check'>) => {
    expect(name).toBe('tool.check')
    expect(hook).toBeUndefined()
    hook = callback
  }) as On)
  if (!hook) throw new Error('approval hook not registered')
  return hook
}
const forbidden = new Proxy({}, { get() { throw new Error('approval used an engine capability') } }) as EngineInterface

test('recorded GPT checks allow core ask/allow, but preserve the exact core deny', async () => {
  const hook = approvalHook()
  const e = { tool: 'Write', input: { file_path: '/repo/a' }, tool_use_id: 'approval-gpt' }
  recordGptCall(e.tool_use_id)
  expect(isGptCall(e.tool_use_id)).toBe(true)
  for (const decision of ['ask', 'allow', 'deny'] as const) {
    const core = { decision, reason: 'core reason', rule: 'Write(*)' }
    let calls = 0
    const next = (async (input: typeof e) => { calls++; expect(input).toBe(e); return core }) as Parameters<typeof hook>[2]
    const result = await hook(forbidden, e, next)
    expect(calls).toBe(1)
    if (decision === 'ask') expect(result).toEqual({ decision: 'allow', reason: 'claudex: GPT agent call, confined by claudex' })
    else expect(result).toBe(core)
  }
})

test('recorded GPT SubagentHandback checks pass through unchanged', async () => {
  const hook = approvalHook()
  const e = { tool: 'SubagentHandback', input: {}, tool_use_id: 'approval-handback' }
  recordGptCall(e.tool_use_id)
  const core = { decision: 'ask' as const, reason: 'x' }
  const next = (async (input: typeof e) => { expect(input).toBe(e); return core }) as Parameters<typeof hook>[2]
  expect(await hook(forbidden, e, next)).toBe(core)
})

test('unrecorded ids and permission queries pass through unchanged with no capabilities', async () => {
  const hook = approvalHook()
  const core = { decision: 'ask' as const, reason: 'native ask', rule: 'Bash(*)' }
  for (const e of [
    { tool: 'Bash', input: { command: 'pwd' }, tool_use_id: 'approval-native' },
    { tool: 'Write', input: { file_path: '/repo/a' } },
  ]) {
    let calls = 0
    const next = (async (input: typeof e) => { calls++; expect(input).toBe(e); return core }) as Parameters<typeof hook>[2]
    expect(await hook(forbidden, e, next)).toBe(core)
    expect(calls).toBe(1)
  }
  expect(isGptCall('approval-native')).toBe(false)
})

test('GPT call ids are capped at 2000 with insertion-ordered oldest eviction', () => {
  for (let i = 0; i < 2000; i++) recordGptCall(`approval-cap-${i}`)
  recordGptCall('approval-cap-0')
  expect(isGptCall('approval-cap-0')).toBe(true)
  recordGptCall('approval-cap-new')
  expect(isGptCall('approval-cap-0')).toBe(false)
  expect(isGptCall('approval-cap-1')).toBe(true)
  expect(isGptCall('approval-cap-1999')).toBe(true)
  expect(isGptCall('approval-cap-new')).toBe(true)
})
