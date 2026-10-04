import type { ApiMessage, EngineInterface, On, TurnStepChunk, TurnStepResult, TurnStepToolUse, TurnUsage } from 'claude-code'
import type { ClaudexAgent, ThinkingBlock } from './agents.ts'
import { agentFor, changeAgent, lookupAgent, systemPrompt, toolsFor } from './agents.ts'
import { HANDBACK_SCHEMA, TOOL_SCHEMAS } from './tool-schemas.ts'
import { stepArgv } from './worker.ts'
import { recordGptCall } from './approve.ts'

type StopReason = TurnStepResult['stopReason']
type ToolPart = { id: string; name: string; input: string }
type Thought = { thinking: string; signature: string }
export type StepState = {
  answer: string
  toolUses: TurnStepToolUse[]
  stopReason: StopReason
  usage: TurnUsage
  thinking: Record<string, ThinkingBlock[]>
  stopped: boolean
  started: boolean
  blocks: Map<number, { type: 'text' | 'thinking' | 'tool_use'; closed: boolean }>
  toolParts: Map<number, ToolPart>
  thoughts: Map<number, Thought>
  signed: ThinkingBlock[]
  firstToolId: string | null
}

const reasons: StopReason[] = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'compaction', 'refusal', 'model_context_window_exceeded']
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
function usage(model: string, raw: unknown): TurnUsage {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    model, input_tokens: count(source.input_tokens), output_tokens: count(source.output_tokens),
    cache_creation_input_tokens: count(source.cache_creation_input_tokens),
    cache_read_input_tokens: count(source.cache_read_input_tokens),
  }
}
export function createStepState(model: string): StepState {
  return { answer: '', toolUses: [], stopReason: null, usage: usage(model, null), thinking: {},
    stopped: false, started: false, blocks: new Map(), toolParts: new Map(), thoughts: new Map(), signed: [], firstToolId: null }
}

export function buildRequest(agent: ClaudexAgent, messages: ApiMessage[], available: string[]): object {
  const copy: ApiMessage[] = messages.map(m => ({ ...m, content: m.content.map(block => ({ ...block })) }))
  const prompt = agent.prompt
  if (prompt && !copy.some(m => m.role === 'user' && m.content.some(block => block.type === 'text' &&
    typeof block.text === 'string' && block.text.includes(prompt)))) {
    const first = copy.find(m => m.role === 'user')
    if (!first) throw new Error('no user message for spawn prompt')
    first.content.unshift({ type: 'text', text: prompt })
  }
  for (const message of copy) {
    if (message.role !== 'assistant') continue
    const first = message.content.find(block => block.type === 'tool_use')
    const retained = first && typeof first.id === 'string' ? agent.thinking[first.id] : undefined
    if (retained?.length) message.content.unshift(...retained.map(block => ({ ...block })))
  }
  const installed = new Set(available)
  const tools = toolsFor(agent.mode).filter(name => installed.has(name)).map(name => TOOL_SCHEMAS[name]).filter(
    (schema): schema is NonNullable<typeof schema> => schema !== undefined)
  return { system: systemPrompt(agent), messages: copy, tools: [...tools, HANDBACK_SCHEMA], max_tokens: 32000, stream: true }
}

function recordThinking(s: StepState): void {
  if (s.firstToolId && s.signed.length) s.thinking[s.firstToolId] = s.signed
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed step stream')
  return value as Record<string, unknown>
}
function blockIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('malformed content block index')
  return value
}
function streamUsage(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  const raw = fields(value)
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0)) {
      throw new Error('malformed step usage')
    }
  }
  return raw
}

// Each input is one NDJSON payload from claudex-worker step (not an SSE envelope).
export function translate(line: string, s: StepState): TurnStepChunk[] {
  const item = fields(JSON.parse(line))
  if (typeof item.type !== 'string' || s.stopped) throw new Error('malformed step stream')
  if (item.type === 'ping') return []
  if (item.type === 'message_start') {
    if (s.started) throw new Error('duplicate message start')
    const message = fields(item.message)
    if (typeof message.model !== 'string') throw new Error('malformed message model')
    s.usage = usage(message.model, streamUsage(message.usage))
    s.started = true
    return []
  }
  if (!s.started) throw new Error('step block before message start')
  if (item.type === 'content_block_start') {
    const index = blockIndex(item.index)
    if (s.blocks.has(index)) throw new Error('duplicate content block')
    const b = fields(item.content_block)
    if (b.type !== 'text' && b.type !== 'thinking' && b.type !== 'tool_use') throw new Error('unknown content block')
    if (b.type === 'tool_use') {
      if (typeof b.id !== 'string' || typeof b.name !== 'string') throw new Error('malformed tool call')
      s.blocks.set(index, { type: b.type, closed: false })
      s.toolParts.set(index, { id: b.id, name: b.name, input: '' })
      if (!s.firstToolId) { s.firstToolId = b.id; recordThinking(s) }
      return [{ kind: 'tool', index, id: b.id, name: b.name }]
    }
    if (b.type === 'thinking') {
      if (typeof b.thinking !== 'string' || b.signature !== undefined && typeof b.signature !== 'string') throw new Error('malformed thinking block')
      s.blocks.set(index, { type: b.type, closed: false })
      s.thoughts.set(index, { thinking: b.thinking, signature: typeof b.signature === 'string' ? b.signature : '' })
      return b.thinking ? [{ kind: 'thinking', index, text: b.thinking }] : []
    }
    if (typeof b.text !== 'string') throw new Error('malformed text block')
    s.blocks.set(index, { type: b.type, closed: false })
    s.answer += b.text
    return b.text ? [{ kind: 'text', index, text: b.text }] : []
  }
  if (item.type === 'content_block_delta') {
    const index = blockIndex(item.index)
    const block = s.blocks.get(index)
    if (!block || block.closed) throw new Error('delta without open content block')
    const d = fields(item.delta)
    if (d.type === 'text_delta' && block.type === 'text' && typeof d.text === 'string') {
      s.answer += d.text
      return [{ kind: 'text', index, text: d.text }]
    }
    if (d.type === 'input_json_delta' && block.type === 'tool_use' && typeof d.partial_json === 'string') {
      s.toolParts.get(index)!.input += d.partial_json
      return [{ kind: 'input', index, json: d.partial_json }]
    }
    if (d.type === 'thinking_delta' && block.type === 'thinking' && typeof d.thinking === 'string') {
      s.thoughts.get(index)!.thinking += d.thinking
      return [{ kind: 'thinking', index, text: d.thinking }]
    }
    if (d.type === 'signature_delta' && block.type === 'thinking' && typeof d.signature === 'string') {
      s.thoughts.get(index)!.signature += d.signature
      return []
    }
    throw new Error('malformed content block delta')
  }
  if (item.type === 'content_block_stop') {
    const index = blockIndex(item.index)
    const block = s.blocks.get(index)
    if (!block || block.closed) throw new Error('stop without open content block')
    if (block.type === 'tool_use') {
      const part = s.toolParts.get(index)!
      s.toolUses.push({ name: part.name, input: JSON.parse(part.input || '{}') })
      s.toolParts.delete(index)
    }
    if (block.type === 'thinking') {
      const thought = s.thoughts.get(index)!
      if (thought.signature) { s.signed.push({ type: 'thinking', ...thought }); recordThinking(s) }
      s.thoughts.delete(index)
    }
    block.closed = true
    return []
  }
  if (item.type === 'message_delta') {
    const delta = fields(item.delta)
    if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
      if (!reasons.includes(delta.stop_reason as StopReason)) throw new Error('invalid stop reason')
      s.stopReason = delta.stop_reason as StopReason
    }
    s.usage = usage(s.usage.model, { ...s.usage, ...streamUsage(item.usage) })
    return []
  }
  if (item.type === 'message_stop') {
    if (!s.stopReason || [...s.blocks.values()].some(block => !block.closed)) throw new Error('incomplete step stream')
    s.stopped = true
    return [{ kind: 'stop', stopReason: s.stopReason, usage: s.usage }]
  }
  throw new Error(`unexpected step event: ${item.type}`)
}

export function stepResult(turnId: string, index: number, state: StepState): TurnStepResult {
  return { turnId, index, answer: state.answer, toolUses: state.toolUses, stopReason: state.stopReason, usage: state.usage }
}

export function registerSteps(on: On): void {
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const agentId = e.agentId
    let agent = agentFor(agentId)
    if (!agent) {
      const owner = await lookupAgent({ agent: { list: () => $.agent.list() } } as EngineInterface, agentId)
      // Unknown ownership can pass through only because agent.spawn forces the GPT alias fallback.
      if (owner.kind !== 'claudex') return yield* next(e)
      agent = owner.agent
    }
    let highestIndex = -1
    let streamedAnswer = ''
    try {
      if (agent.final !== null) {
        const input = { message: agent.final }
        changeAgent(agentId, old => ({ ...old, final: null }))
        const id = `toolu_claudex_handback_${e.index}`
        recordGptCall(id)
        yield { kind: 'tool', index: 0, id, name: 'SubagentHandback' }
        yield { kind: 'input', index: 0, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SubagentHandback', input }], stopReason: 'tool_use', usage: null }
      }
      const messages = await $.session.messages({ agentId, as: 'api' })
      if (!Array.isArray(messages)) throw new Error('session.messages did not return messages')
      const available = (await $.tool.list()).map(tool => tool.name)
      const request = buildRequest(agent, messages, available)
      const child = $.process.spawn({ argv: stepArgv($.plugin.root, agent.tier), input: JSON.stringify(request) })
      const state = createStepState(agent.model)
      const bufferedTools: Extract<TurnStepChunk, { kind: 'tool' | 'input' }>[] = []
      let buffer = '', stderr = '', seen = false
      for await (const piece of child) {
        if (piece.stream === 'stderr') { stderr += piece.text.slice(0, Math.max(0, 512 - stderr.length)); continue }
        buffer += piece.text
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim()
          buffer = buffer.slice(end + 1)
          if (!line) continue
          seen = true
          for (const chunk of translate(line, state)) {
            if (chunk.kind === 'tool' || chunk.kind === 'input') bufferedTools.push(chunk)
            else if (chunk.kind === 'text' || chunk.kind === 'thinking') {
              highestIndex = Math.max(highestIndex, chunk.index)
              if (chunk.kind === 'text') streamedAnswer += chunk.text
              yield chunk
            }
          }
        }
      }
      const exit = await child.result
      if (exit.code !== 0) throw new Error(stderr || `worker step exited ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`)
      if (buffer.trim() || !seen || !state.stopped) throw new Error('incomplete step stream')
      changeAgent(agentId, old => ({ ...old, final: state.stopReason === 'end_turn' && !state.toolUses.length ? state.answer : null,
        thinking: { ...old.thinking, ...state.thinking } }))
      for (const chunk of bufferedTools) {
        highestIndex = Math.max(highestIndex, chunk.index)
        if (chunk.kind === 'tool') recordGptCall(chunk.id)
        yield chunk
      }
      yield { kind: 'stop', stopReason: state.stopReason, usage: state.usage }
      return stepResult(e.turnId, e.index, state)
    } catch (error) {
      const text = `claudex: ${error instanceof Error ? error.message : String(error)}`
      changeAgent(agentId, old => ({ ...old, final: text }))
      yield { kind: 'text', index: highestIndex + 1, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: streamedAnswer + text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  })
}
