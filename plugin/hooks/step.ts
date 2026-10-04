import type { ApiMessage, EngineInterface, On, TurnStepChunk, TurnStepResult, TurnStepToolUse, TurnUsage } from 'claude-code'
import type { ClaudexAgent, ThinkingBlock } from './agents.ts'
import { agentFor, changeAgent, lookupAgent, systemPrompt, toolsFor } from './agents.ts'
import { TOOL_SCHEMAS } from './tool-schemas.ts'
import { stepArgv } from './worker.ts'

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
    stopped: false, toolParts: new Map(), thoughts: new Map(), signed: [], firstToolId: null }
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
  return { system: systemPrompt(agent), messages: copy, tools, max_tokens: 32000, stream: true }
}

function recordThinking(s: StepState): void {
  if (s.firstToolId && s.signed.length) s.thinking[s.firstToolId] = s.signed
}

// Each input is one NDJSON payload from claudex-worker step (not an SSE envelope).
export function translate(line: string, s: StepState): TurnStepChunk[] {
  const item = JSON.parse(line) as Record<string, any>
  if (!item || typeof item !== 'object' || typeof item.type !== 'string' || s.stopped) throw new Error('malformed step stream')
  if (item.type === 'message_start') {
    s.usage = usage(item.message?.model || s.usage.model, item.message?.usage)
  } else if (item.type === 'content_block_start') {
    if (!Number.isInteger(item.index) || item.index < 0 || !item.content_block) throw new Error('malformed content block')
    const b = item.content_block
    if (b.type === 'tool_use') {
      if (typeof b.id !== 'string' || typeof b.name !== 'string') throw new Error('malformed tool call')
      s.toolParts.set(item.index, { id: b.id, name: b.name, input: '' })
      if (!s.firstToolId) { s.firstToolId = b.id; recordThinking(s) }
      return [{ kind: 'tool', index: item.index, id: b.id, name: b.name }]
    }
    if (b.type === 'thinking') {
      s.thoughts.set(item.index, { thinking: b.thinking || '', signature: b.signature || '' })
      return b.thinking ? [{ kind: 'thinking', index: item.index, text: b.thinking }] : []
    }
    if (b.type === 'text' && b.text) {
      s.answer += b.text
      return [{ kind: 'text', index: item.index, text: b.text }]
    }
  } else if (item.type === 'content_block_delta') {
    const d = item.delta
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      s.answer += d.text
      return [{ kind: 'text', index: item.index, text: d.text }]
    }
    if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      const part = s.toolParts.get(item.index)
      if (!part) throw new Error('tool input without tool start')
      part.input += d.partial_json
      return [{ kind: 'input', index: item.index, json: d.partial_json }]
    }
    if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
      const thought = s.thoughts.get(item.index)
      if (!thought) throw new Error('thinking without block start')
      thought.thinking += d.thinking
      return [{ kind: 'thinking', index: item.index, text: d.thinking }]
    }
    if (d?.type === 'signature_delta' && typeof d.signature === 'string') {
      const thought = s.thoughts.get(item.index)
      if (!thought) throw new Error('signature without thinking block')
      thought.signature += d.signature
    }
  } else if (item.type === 'content_block_stop') {
    const part = s.toolParts.get(item.index)
    if (part) {
      s.toolUses.push({ name: part.name, input: JSON.parse(part.input || '{}') })
      s.toolParts.delete(item.index)
    }
    const thought = s.thoughts.get(item.index)
    if (thought) {
      if (thought.signature) { s.signed.push({ type: 'thinking', ...thought }); recordThinking(s) }
      s.thoughts.delete(item.index)
    }
  } else if (item.type === 'message_delta') {
    if (item.delta?.stop_reason !== undefined && item.delta.stop_reason !== null) {
      if (!reasons.includes(item.delta.stop_reason)) throw new Error('invalid stop reason')
      s.stopReason = item.delta.stop_reason
    }
    const delta = item.usage && typeof item.usage === 'object' ? item.usage : {}
    s.usage = usage(s.usage.model, { ...s.usage, ...delta })
  } else if (item.type === 'message_stop') {
    if (!s.stopReason || s.toolParts.size || s.thoughts.size) throw new Error('incomplete step stream')
    s.stopped = true
    return [{ kind: 'stop', stopReason: s.stopReason, usage: s.usage }]
  } else if (!['content_block_start', 'content_block_delta', 'content_block_stop', 'ping'].includes(item.type)) {
    throw new Error(`unexpected step event: ${item.type}`)
  }
  return []
}

export function stepResult(turnId: string, index: number, state: StepState): TurnStepResult {
  return { turnId, index, answer: state.answer, toolUses: state.toolUses, stopReason: state.stopReason, usage: state.usage }
}

export function registerSteps(on: On): void {
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const agent = agentFor(e.agentId) ?? await lookupAgent({ agent: { list: () => $.agent.list() } } as EngineInterface, e.agentId)
    if (!agent) return yield* next(e)
    const agentId = e.agentId
    try {
      if (agent.final !== null) {
        const input = { message: agent.final }
        changeAgent(agentId, old => ({ ...old, final: null }))
        yield { kind: 'tool', index: 0, id: `toolu_claudex_handback_${e.index}`, name: 'SubagentHandback' }
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
          for (const chunk of translate(line, state)) if (chunk.kind !== 'stop') yield chunk
        }
      }
      const exit = await child.result
      if (exit.code !== 0) throw new Error(stderr || `worker step exited ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`)
      if (buffer.trim() || !seen || !state.stopped) throw new Error('incomplete step stream')
      changeAgent(agentId, old => ({ ...old, final: state.stopReason === 'end_turn' && !state.toolUses.length ? state.answer : null,
        thinking: { ...old.thinking, ...state.thinking } }))
      yield { kind: 'stop', stopReason: state.stopReason, usage: state.usage }
      return stepResult(e.turnId, e.index, state)
    } catch (error) {
      const text = `claudex: ${error instanceof Error ? error.message : String(error)}`
      changeAgent(agentId, old => ({ ...old, final: text }))
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  })
}
