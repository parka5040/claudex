import { expect, test } from 'claude-code/testing'
import type { ApiMessage, EngineInterface, On, ProcessSpawnRequest, StreamHook, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import type { ClaudexStatus } from '../types/index.d.ts'
import type { ClaudexAgent } from '../hooks/agents.ts'
import { buildRequest, createStepState, registerSteps, stepResult, translate } from '../hooks/step.ts'
import { TOOL_SCHEMAS } from '../hooks/tool-schemas.ts'
import { harness } from './harness.ts'

const status: ClaudexStatus = {
  policy: { CLAUDEX: 'on', CLAUDEX_TIERS: 'sol', CLAUDEX_WORKER_MODE: 'edit' },
  policy_sources: { CLAUDEX: 'file', CLAUDEX_TIERS: 'file', CLAUDEX_WORKER_MODE: 'file' },
  proxy: { up: false, ours: false, port: 18765 }, token_hours_left: null, plan: null,
  models: null, deprecations: [],
}
const agent = (changes: Partial<ClaudexAgent> = {}): ClaudexAgent => ({
  tier: 'sol', cwd: '/repo', prompt: 'Delegated task', mode: 'edit', model: 'gpt-sol', final: null, thinking: {}, ...changes,
})
const event = (value: object) => JSON.stringify(value)
const fixture = [
  { type: 'message_start', message: { model: 'gpt-6-sol', usage: { input_tokens: 8, cache_read_input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Hi' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' there' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"/repo/a"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9, cache_creation_input_tokens: 3 } },
  { type: 'message_stop' },
]
const chunks: TurnStepChunk[] = [
  { kind: 'thinking', index: 0, text: 'reason' },
  { kind: 'text', index: 1, text: 'Hi' }, { kind: 'text', index: 1, text: ' there' },
  { kind: 'tool', index: 2, id: 'toolu_a', name: 'Read' },
  { kind: 'input', index: 2, json: '{"file_path":' }, { kind: 'input', index: 2, json: '"/repo/a"}' },
  { kind: 'tool', index: 3, id: 'toolu_b', name: 'Bash' }, { kind: 'input', index: 3, json: '{"command":"pwd"}' },
  { kind: 'stop', stopReason: 'tool_use', usage: {
    model: 'gpt-6-sol', input_tokens: 8, output_tokens: 9, cache_creation_input_tokens: 3, cache_read_input_tokens: 2,
  } },
]
const texts = (lines: object[]) => lines.map(event).join('\n') + '\n'
const step = ($: Engine, agentId?: string, index = 0) => $.turn.step({
  turnId: 'turn-test', index, model: 'gpt-sol', messageCount: 1, agentId,
})
async function collect(stream: ReturnType<typeof step>): Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult }> {
  const received: TurnStepChunk[] = []
  for await (const item of stream) received.push(item)
  return { chunks: received, result: await stream.result }
}
function nativeStub(on: On): void {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'native' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'native', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}
function spawnStub(on: On): void {
  on('agent.spawn', ($, e) => ({ agentId: e.description, model: e.model ?? 'gpt-sol' }))
}
function spawn($: Engine, id = 'a') {
  return $.agent.spawn({ subagentType: 'claudex:gpt-sol', description: id, prompt: 'Delegated task', cwd: '/repo',
    tool_use_id: 'toolu_spawn', provider: { plugin: 'claudex', tier: 'user' }, parentModel: 'claude-sonnet-4',
    background: false, fork: false })
}
function registered(h: ReturnType<typeof harness>, id = 'a'): ClaudexAgent | undefined {
  return (h.state.get('claudex:agents')?.value as Record<string, ClaudexAgent> | undefined)?.[id]
}
async function approvedTools($: Engine, chunks: TurnStepChunk[]): Promise<void> {
  const tools = chunks.filter(chunk => chunk.kind === 'tool')
  expect(tools.length > 0).toBe(true)
  for (const tool of tools) {
    // Like synthetic agentId in tool.call, the kit accepts a real-call id here.
    expect(await $.tool.check({ tool: tool.name, input: {}, tool_use_id: tool.id } as never))
      .toEqual({ decision: 'allow', reason: 'claudex: GPT agent call, confined by claudex' })
  }
}

test('buildRequest injects prompt only when missing, splices signed thinking only at matched tool id, filters installed tools', () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'environment' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'file' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} }] },
  ]
  const signed = { type: 'thinking' as const, thinking: 'retained', signature: 'opaque' }
  const a = agent({ thinking: { toolu_a: [signed] } })
  const built = buildRequest(a, messages, ['Read', 'Bash', 'Glob']) as {
    system: string; messages: ApiMessage[]; tools: (typeof TOOL_SCHEMAS)[string][]; max_tokens: number; stream: boolean; model?: string
  }
  expect(built.messages[0]?.content[0]).toEqual({ type: 'text', text: 'Delegated task' })
  expect(built.messages[0]?.content[1]).toEqual(messages[0]?.content[0])
  expect(built.messages[1]?.content).toEqual([signed, messages[1]?.content[0]])
  expect(built.messages[3]?.content).toEqual(messages[3]?.content)
  expect(messages[0]?.content).toHaveLength(1)
  expect(built.tools.map(t => t.name)).toEqual(['Read', 'Glob', 'Bash', 'SubagentHandback'])
  expect(built.tools[0]).toEqual(TOOL_SCHEMAS.Read)
  expect(built.max_tokens).toBe(32000)
  expect(built.stream).toBe(true)
  expect(built.system.length > 0).toBe(true)
  expect(built.model).toBeUndefined()
  expect((buildRequest(agent({ mode: 'read' }), [{ role: 'user', content: [{ type: 'text', text: 'Delegated task' }] }],
    ['Read', 'Bash', 'Glob']) as { messages: ApiMessage[]; tools: { name: string }[] }).tools.map(t => t.name)).toEqual(['Read', 'Glob', 'SubagentHandback'])
  expect((buildRequest(a, [{ role: 'user', content: [{ type: 'text', text: 'Delegated task' }] }], ['Read']) as { messages: ApiMessage[] }).messages[0]?.content).toHaveLength(1)
})

test('buildRequest always appends the handback schema after installed tools in both modes', () => {
  for (const mode of ['read', 'edit'] as const) {
    for (const available of [[], ['Read', 'Bash'], ['Read', 'Bash', 'SubagentHandback']]) {
      const built = buildRequest(agent({ mode, prompt: null }), [], available) as {
        tools: { name: string; input_schema: { required: string[]; properties: { message: { minLength: number } }; additionalProperties: boolean } }[]
      }
      expect(built.tools.map(t => t.name)).toEqual([
        ...available.includes('Read') ? ['Read'] : [],
        ...mode === 'edit' && available.includes('Bash') ? ['Bash'] : [],
        'SubagentHandback',
      ])
      expect(built.tools.at(-1)?.input_schema.required).toEqual(['message'])
      expect(built.tools.at(-1)?.input_schema.properties.message.minLength).toBe(1)
      expect(built.tools.at(-1)?.input_schema.additionalProperties).toBe(false)
    }
  }
})

test('proxy-style SSE fixture translates to exact chunks, complete result and signed thinking keyed by first tool id', () => {
  const s = createStepState('gpt-sol')
  const output = fixture.flatMap(line => translate(event(line), s))
  expect(output).toEqual(chunks)
  expect(s.answer).toBe('Hi there')
  expect(s.toolUses).toEqual([{ name: 'Read', input: { file_path: '/repo/a' } }, { name: 'Bash', input: { command: 'pwd' } }])
  expect(s.stopReason).toBe('tool_use')
  expect(s.usage).toEqual((chunks.at(-1) as { usage: unknown }).usage)
  expect(s.thinking).toEqual({ toolu_a: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }] })
  expect(stepResult('turn-test', 0, s)).toEqual({ turnId: 'turn-test', index: 0, answer: 'Hi there',
    toolUses: [{ name: 'Read', input: { file_path: '/repo/a' } }, { name: 'Bash', input: { command: 'pwd' } }],
    stopReason: 'tool_use', usage: (chunks.at(-1) as { usage: unknown }).usage })
})

test('text-only streamed step stores final and next step hands it back without another spawn', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  nativeStub(on)
  spawnStub(on)
  const requests: ProcessSpawnRequest[] = []
  on('tool.list', () => ({ value: [{ name: 'Read', description: 'Read', mcp: false }] }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'environment' }] }] }))
  on('process.spawn', async function* ($, e) {
    requests.push(e)
    yield { stream: 'stdout', text: texts([
      { type: 'message_start', message: { model: 'gpt-6-sol', usage: { input_tokens: 4 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]).slice(0, 27) }
    yield { stream: 'stdout', text: texts([
      { type: 'message_start', message: { model: 'gpt-6-sol', usage: { input_tokens: 4 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]).slice(27) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await spawn($)
  const first = await collect(step($, 'a'))
  expect(requests).toHaveLength(1)
  expect(requests[0]?.argv.slice(1)).toEqual(['step', 'sol'])
  expect((JSON.parse(requests[0]?.input ?? '{}') as { messages: ApiMessage[] }).messages[0]?.content[0]).toEqual({ type: 'text', text: 'Delegated task' })
  expect(first.chunks).toEqual([{ kind: 'text', index: 0, text: 'Done' }, { kind: 'stop', stopReason: 'end_turn', usage: {
    model: 'gpt-6-sol', input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  } }])
  expect(first.result).toBeUndefined() // The testing engine does not expose streaming hooks' returned result.
  expect(registered(h)?.final).toBe('Done')
  const handback = await collect(step($, 'a', 1))
  expect(handback.chunks).toEqual([
    { kind: 'tool', index: 0, id: expect.any(String), name: 'SubagentHandback' },
    { kind: 'input', index: 0, json: '{"message":"Done"}' },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ])
  expect(handback.result).toBeUndefined()
  h.opts.check = { decision: 'ask' }
  // SubagentHandback only accepts the engine's own verdict, so the approval hook leaves it alone.
  const handbackTool = handback.chunks.find(chunk => chunk.kind === 'tool')
  expect(handbackTool?.kind === 'tool' && handbackTool.name).toBe('SubagentHandback')
  expect(await $.tool.check({ tool: 'SubagentHandback', input: {}, tool_use_id: handbackTool?.kind === 'tool' ? handbackTool.id : '' } as never))
    .toEqual({ decision: 'ask' })
  expect(requests).toHaveLength(1)
  expect(registered(h)?.final).toBeNull()
  expect(h.calls.every(c => c.argv[1] !== 'step')).toBe(true)
})

test('tool step preserves signed thinking and split-line input, hands back only after final text', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  nativeStub(on)
  spawnStub(on)
  const requests: ProcessSpawnRequest[] = []
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }, { name: 'Bash', description: '', mcp: false }] }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'Delegated task' }] }] }))
  on('process.spawn', async function* ($, e) {
    requests.push(e)
    const data = texts(fixture)
    yield { stream: 'stdout', text: data.slice(0, 11) }
    yield { stream: 'stdout', text: data.slice(11, data.length - 7) }
    yield { stream: 'stdout', text: data.slice(-7) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await spawn($)
  const output = await collect(step($, 'a'))
  expect(output.chunks).toEqual(chunks)
  h.opts.check = { decision: 'ask' }
  await approvedTools($, output.chunks)
  expect(output.result).toBeUndefined()
  expect(registered(h)?.thinking).toEqual({ toolu_a: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }] })
  expect(registered(h)?.final).toBeNull()
  expect(requests).toHaveLength(1)
})

test('worker exit 7 with stderr, malformed stream and spawn failure fail closed and hand back error', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  nativeStub(on)
  spawnStub(on)
  let variant: 'exit' | 'garbage' | 'throw' | 'late-exit' = 'exit'
  on('tool.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'Delegated task' }] }] }))
  on('process.spawn', async function* () {
    if (variant === 'throw') throw new Error('unable to start')
    if (variant === 'garbage') yield { stream: 'stdout', text: 'garbage\n' }
    else if (variant === 'late-exit') {
      yield { stream: 'stdout', text: texts(fixture) }
      yield { stream: 'stderr', text: 'HTTP 503 after message_stop' }
    } else yield { stream: 'stderr', text: 'HTTP 503 upstream unavailable' }
    return { value: { code: variant === 'exit' || variant === 'late-exit' ? 7 : 0, signal: null } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const [i, type] of (['exit', 'garbage', 'throw', 'late-exit'] as const).entries()) {
    variant = type
    await spawn($, `failed-${i}`)
    const output = await collect(step($, `failed-${i}`, i * 2))
    expect(output.chunks.map(c => c.kind).at(-2)).toBe('text')
    expect(output.chunks.filter(c => c.kind === 'stop')).toHaveLength(1)
    const text = (output.chunks.at(-2) as { text: string }).text
    expect(text.startsWith('claudex: ')).toBe(true)
    expect(text).toContain(type === 'exit' || type === 'late-exit' ? 'HTTP 503' : type === 'garbage' ? 'garbage' : 'no implementation for process.spawn')
    expect(output.result).toBeUndefined()
    expect(registered(h, `failed-${i}`)?.final).toBe(text)
    const handback = await collect(step($, `failed-${i}`, i * 2 + 1))
    expect(handback.chunks.map(c => c.kind)).toEqual(['tool', 'input', 'stop'])
    expect((handback.chunks[1] as { json: string }).json).toBe(JSON.stringify({ message: text }))
  }
})

test('malformed typed NDJSON fails closed through streamed host chunks', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  nativeStub(on)
  spawnStub(on)
  on('tool.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'Delegated task' }] }] }))
  let lines: object[] = []
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: texts(lines) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const beginning = fixture.slice(0, 1)
  const bad = [
    [...beginning, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'bad' } }],
    [{ type: 'message_start', message: { model: 42 } }],
    [...beginning, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 42 } }],
    [...beginning, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 42 } }],
    [...beginning, { type: 'content_block_start', index: 0, content_block: { type: 'other', text: '' } }],
    [...beginning, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bad' } }],
    [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    [...beginning, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'bad' } }],
    [...fixture, { type: 'ping' }],
  ]
  for (const [index, broken] of bad.entries()) {
    lines = broken
    await spawn($, `malformed-${index}`)
    const output = await collect(step($, `malformed-${index}`))
    expect(output.chunks.at(-1)?.kind).toBe('stop')
    expect(output.chunks.some(c => c.kind === 'tool' || c.kind === 'input')).toBe(false)
    const error = output.chunks.at(-2) as { kind: string; index: number; text: string }
    expect(error.kind).toBe('text')
    expect(error.text).toContain('claudex: ')
    expect(registered(h, `malformed-${index}`)?.final).toBe(error.text)
  }
})

test('late failures never publish buffered tool calls and put errors after emitted indexes', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  nativeStub(on)
  spawnStub(on)
  on('tool.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'Delegated task' }] }] }))
  let lines: object[] = []
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: texts(lines) }
    yield { stream: 'stderr', text: 'late worker failure' }
    return { value: { code: 7, signal: null } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const [id, events, emitted, errorIndex] of [
    ['tool-complete', fixture, ['thinking', 'text', 'text'], 2],
    ['tool-partial', fixture.slice(0, 10), ['thinking', 'text', 'text'], 2],
    ['text-only', [
      { type: 'message_start', message: { model: 'gpt-6-sol' } },
      { type: 'content_block_start', index: 4, content_block: { type: 'text', text: 'Hi' } },
    ], ['text'], 5],
  ] as const) {
    lines = [...events]
    await spawn($, id)
    const output = await collect(step($, id))
    expect(output.chunks.map(c => c.kind)).toEqual([...emitted, 'text', 'stop'])
    expect(output.chunks.at(-2)).toMatchObject({ kind: 'text', index: errorIndex, text: 'claudex: late worker failure' })
    expect(registered(h, id)?.final).toBe('claudex: late worker failure')
  }
})

test('main and foreign agent pass through unchanged without accessing any engine capability', async ($, on) => {
  const h = harness(on, { status, jobs: [] })
  let nextCalls = 0
  const sentinel = { turnId: 'turn-test', index: 0, answer: 'native', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  on('turn.step', async function* () {
    nextCalls++
    yield { kind: 'text', index: 0, text: 'native' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return sentinel
  })
  on('session.messages', () => { throw new Error('foreign step read messages') })
  on('tool.list', () => { throw new Error('foreign step listed tools') })
  on('process.spawn', async function* () { throw new Error('foreign step spawned worker') })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const baseline = h.calls.length
  expect(await collect(step($))).toEqual({ chunks: [{ kind: 'text', index: 0, text: 'native' }, { kind: 'stop', stopReason: 'end_turn', usage: null }], result: undefined })
  expect(h.calls).toHaveLength(baseline)
  h.listed.push({ id: 'foreign', type: 'general-purpose', status: 'running', description: 'other' })
  expect(await collect(step($, 'foreign'))).toEqual({ chunks: [{ kind: 'text', index: 0, text: 'native' }, { kind: 'stop', stopReason: 'end_turn', usage: null }], result: undefined })
  expect(await collect(step($, 'foreign'))).toEqual({ chunks: [{ kind: 'text', index: 0, text: 'native' }, { kind: 'stop', stopReason: 'end_turn', usage: null }], result: undefined })
  expect(nextCalls).toBe(3)
})

test('unknown ownership after a failed lookup delegates, while identified claudex failures hand back', async ($, on) => {
  const h = harness(on, { status, jobs: [], listed: [] })
  nativeStub(on)
  on('session.messages', () => { throw new Error('claudex messages unavailable') })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  h.opts.listAgents = async () => { throw new Error('agent list unavailable') }
  const unknown = await collect(step($, 'unknown-owner'))
  expect(unknown.chunks[0]).toEqual({ kind: 'text', index: 0, text: 'native' })
  h.opts.listAgents = async () => [{ id: 'found-gpt', type: 'claudex:gpt-sol', status: 'running', description: 'GPT' }]
  const identified = await collect(step($, 'found-gpt'))
  expect(identified.chunks.at(-2)?.kind).toBe('text')
  expect((identified.chunks.at(-2) as { text: string }).text).toContain('claudex:')
  expect(identified.chunks[0]).not.toEqual({ kind: 'text', index: 0, text: 'native' })
  const handback = await collect(step($, 'found-gpt', 1))
  expect(handback.chunks.map(c => c.kind)).toEqual(['tool', 'input', 'stop'])
})

test('stale lookup retries against current activation without losing known claudex ownership', async ($, on) => {
  const s = { ...status, policy: { ...status.policy } }
  const h = harness(on, { status: s, jobs: [] })
  nativeStub(on)
  on('session.messages', () => { throw new Error('identified claudex failure') })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  let lookups = 0
  h.opts.listAgents = async () => {
    lookups++
    if (lookups === 1) {
      s.policy.CLAUDEX = 'off'
      await $.command.run({ command: 'claudex', args: 'config CLAUDEX off', origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 100 } })
      return [{ id: 'stale-gpt', type: 'claudex:gpt-sol', status: 'running', description: 'GPT' }]
    }
    return []
  }
  const result = await collect(step($, 'stale-gpt'))
  expect(lookups).toBe(2)
  expect((result.chunks.at(-2) as { text: string }).text).toContain('claudex: no implementation for session.messages')
  expect(result.chunks[0]).not.toEqual({ kind: 'text', index: 0, text: 'native' })
})

test('foreign and unknown steps propagate a downstream yield followed by the original error', async () => {
  let hook: StreamHook<'turn.step'> | undefined
  registerSteps(((name: string, callback: StreamHook<'turn.step'>) => {
    if (name === 'turn.step') hook = callback
  }) as On)
  if (!hook) throw new Error('step hook not registered')
  const error = new Error('native failure after yielding')
  const chunk = { kind: 'text' as const, index: 7, text: 'native partial' }
  const next = (() => (async function* () {
    yield chunk
    throw error
  })()) as unknown as Parameters<StreamHook<'turn.step'>>[2]
  for (const unknown of [false, true]) {
    const engine = { agent: { list: async () => {
      if (unknown) throw new Error('classification unavailable')
      return [{ id: 'foreign-throws', type: 'general-purpose', status: 'running' }]
    } } } as unknown as EngineInterface
    const stream = hook(engine, { turnId: 't-native', index: 0, model: 'native', messageCount: 1,
      agentId: unknown ? 'unknown-throws' : 'foreign-throws' }, next)
    expect(await stream.next()).toEqual({ value: chunk, done: false })
    let caught: unknown
    try { await stream.next() } catch (failure) { caught = failure }
    expect(caught).toBe(error)
  }
})

test('direct step hook returns the unchanged next result for the main loop without touching $', async () => {
  let hook: StreamHook<'turn.step'> | undefined
  registerSteps(((name: string, callback: StreamHook<'turn.step'>) => {
    if (name === 'turn.step') hook = callback
  }) as On)
  if (!hook) throw new Error('step hook not registered')
  const sentinel: TurnStepResult = { turnId: 'turn-test', index: 0, answer: 'native', toolUses: [], stopReason: 'end_turn', usage: null }
  const next = (() => (async function* () {
    yield { kind: 'text' as const, index: 0, text: 'native' }
    return sentinel
  })()) as unknown as Parameters<StreamHook<'turn.step'>>[2]
  const forbidden = new Proxy({}, { get() { throw new Error('main loop called an engine capability') } }) as EngineInterface
  const input = { turnId: 'turn-test', index: 0, model: 'native', messageCount: 1 }
  const stream = hook(forbidden, input, next)
  expect(await stream.next()).toEqual({ value: { kind: 'text', index: 0, text: 'native' }, done: false })
  expect(await stream.next()).toEqual({ value: sentinel, done: true })
})
