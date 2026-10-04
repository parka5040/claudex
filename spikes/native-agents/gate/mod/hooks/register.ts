import type { Register } from 'claude-code'

const str = { type: 'string' }
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required })
const schemas = [
  { name: 'Read', description: 'Read a file using its absolute path.', input_schema: object({ file_path: str }, ['file_path']) },
  { name: 'Bash', description: 'Run a shell command in the working directory.', input_schema: object({ command: str, description: str }, ['command']) },
  { name: 'Edit', description: 'Replace an exact string in a file.', input_schema: object({ file_path: str, old_string: str, new_string: str }, ['file_path', 'old_string', 'new_string']) },
]
const contract = 'You are a coding subagent. Perform only the delegated task. Use Read, Bash and Edit to do the work when requested. Give a concise account of the results and errors. Do not access credentials or files outside the assigned scratch directory.'
const prompts = new Map<string, string>()
const finals = new Map<string, string>()
const kinds = new Map<string, string>()
let log = ''
let history = ''
async function record($: any, event: Record<string, unknown>) {
  if (!log) return
  history += JSON.stringify({ ms: Date.now(), ...event }) + '\n'
  await $.fs.write(log, history)
}
function usage(model: string, source: any) {
  return { model, input_tokens: source?.input_tokens ?? 0, output_tokens: source?.output_tokens ?? 0,
    cache_creation_input_tokens: source?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: source?.cache_read_input_tokens ?? 0 }
}
function normalized(messages: any[], prompt: string | undefined) {
  const copy = messages.map(m => ({ ...m, content: m.content.map((b: any) => ({ ...b })) }))
  const first = copy.find(m => m.role === 'user')
  const found = Boolean(prompt && copy.some(m => m.role === 'user' && m.content.some((b: any) => b.type === 'text' && String(b.text).includes(prompt))))
  if (first && prompt && !found) first.content.unshift({ type: 'text', text: prompt })
  return { messages: copy, found, injected: Boolean(first && prompt && !found) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    log = `${$.plugin.root}/../captures/${(await $.env.get('GATE_CASE')) || 'unknown'}-events.jsonl`
    history = ''
    const model = (await $.env.get('GATE_AGENT_MODEL')) || 'gpt-sol'
    try {
      await $.agent.register({ name: 'gpt', description: 'GPT native agent for scratch file gate', prompt: contract,
        tools: ['Read', 'Bash', 'Edit'], model, effort: 'high' })
      await record($, { event: 'registered', model })
    } catch (err) {
      await record($, { event: 'registration-error', model, error: String(err).slice(0, 500) })
    }
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== 'gate:gpt') return next(e)
    await record($, { event: 'spawn', prompt: e.prompt, model: e.model, background: e.background })
    const result = await next(e)
    if (result.agentId) {
      prompts.set(result.agentId, e.prompt)
      await record($, { event: 'spawned', agentId: result.agentId, model: result.model })
    } else await record($, { event: 'spawn-denied', result })
    return result
  })
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      if (e.index === 0) return yield* next(e)
      const main = await $.session.messages({ as: 'api' })
      const agents = await $.agent.list()
      await record($, { event: 'parent-followup', agentTypes: agents.map(a => ({ id: a.id, type: a.type, status: a.status, model: a.model })),
        toolResults: Array.isArray(main) ? main.flatMap((m: any) => m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => ({ error: b.is_error }))) : [] })
      const text = 'Gate parent has handed off its tasks.'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    if (!kinds.has(e.agentId)) {
      const agent = (await $.agent.list()).find(a => a.id === e.agentId)
      kinds.set(e.agentId, agent?.type || 'unknown')
    }
    if (kinds.get(e.agentId) !== 'gate:gpt') return yield* next(e)
    await record($, { event: 'step', agentId: e.agentId, index: e.index, model: e.model })
    if ((await $.env.get('GATE_SKIP')) === '1') {
      await record($, { event: 'skipped', agentId: e.agentId })
      return yield* next(e)
    }
    if (finals.has(e.agentId)) {
      const input = { message: finals.get(e.agentId) }
      finals.delete(e.agentId)
      yield { kind: 'tool', index: 0, id: `toolu_gate_handback_${e.index}`, name: 'SubagentHandback' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SubagentHandback', input }], stopReason: 'tool_use', usage: null }
    }
    try {
      const raw = await $.session.messages({ agentId: e.agentId, as: 'api' })
      if (!Array.isArray(raw)) throw Error('session.messages did not return messages')
      const prompt = prompts.get(e.agentId)
      // Exercise the repair against a forced omission as well as the naturally received spawn.
      const simulateOmission = (await $.env.get('GATE_SIMULATE_OMISSION')) === '1'
      const input = simulateOmission && prompt ? raw.map((m: any) => ({ ...m, content: m.content.map((b: any) =>
        b.type === 'text' ? { ...b, text: String(b.text).replace(prompt, '') } : b) })) : raw
      const { messages, found, injected } = normalized(input, prompt)
      const first = messages.find((m: any) => m.role === 'user')
      await record($, { event: 'first-user', agentId: e.agentId, index: e.index, promptCaptured: Boolean(prompt),
        promptOriginallyPresent: found, promptInjected: injected,
        promptNowPresent: Boolean(prompt && first?.content.some((b: any) => b.type === 'text' && String(b.text).includes(prompt))),
        firstUserBlockTypes: first?.content.map((b: any) => b.type) })
      const run = (await $.env.get('GATE_CASE')) || 'unknown'
      const model = run === 'long' || run === 'item5' ? 'gpt-6-sol@high' : 'gpt-6-luna'
      const request = { model, max_tokens: run === 'long' || run === 'item5' ? 10000 : 1300, system: contract, messages,
        tools: schemas, stream: true }
      const started = Date.now()
      const child = $.process.spawn({ argv: ['bash', `${$.plugin.root}/../step.sh`], input: JSON.stringify(request) })
      let buffer = '', errors = '', answer = '', modelUsed = model, reason = 'end_turn'
      let counts = usage(model, null)
      const calls: { name: string; input: any }[] = []
      const pieces = new Map<number, { name: string; input: string }>()
      let observed = 0
      for await (const chunk of child) {
        if (chunk.stream === 'stderr') { errors += chunk.text.slice(0, 500); continue }
        buffer += chunk.text
        while (buffer.includes('\n')) {
          const pos = buffer.indexOf('\n')
          const line = buffer.slice(0, pos).trim()
          buffer = buffer.slice(pos + 1)
          if (!line) continue
          const item = JSON.parse(line)
          observed++
          if (item.type === 'message_start') {
            modelUsed = item.message?.model || model
            counts = usage(modelUsed, item.message?.usage)
          } else if (item.type === 'content_block_start') {
            if (item.content_block?.type === 'tool_use') {
              const block = item.content_block
              pieces.set(item.index, { name: block.name, input: '' })
              yield { kind: 'tool', index: item.index, id: block.id, name: block.name }
            }
            if (item.content_block?.type === 'text' && item.content_block.text) {
              answer += item.content_block.text
              yield { kind: 'text', index: item.index, text: item.content_block.text }
            }
          } else if (item.type === 'content_block_delta') {
            const delta = item.delta
            if (delta?.type === 'text_delta') {
              answer += delta.text
              await record($, { event: 'text-delta', agentId: e.agentId, index: e.index, msSinceStart: Date.now() - started, chars: delta.text.length })
              yield { kind: 'text', index: item.index, text: delta.text }
            } else if (delta?.type === 'input_json_delta') {
              const piece = pieces.get(item.index)
              if (piece) piece.input += delta.partial_json
              yield { kind: 'input', index: item.index, json: delta.partial_json }
            } else if (delta?.type === 'thinking_delta') {
              yield { kind: 'thinking', index: item.index, text: delta.thinking }
            }
          } else if (item.type === 'content_block_stop') {
            const piece = pieces.get(item.index)
            if (piece) calls.push({ name: piece.name, input: JSON.parse(piece.input || '{}') })
          } else if (item.type === 'message_delta') {
            reason = item.delta?.stop_reason || reason
            counts = usage(modelUsed, { ...counts, ...item.usage })
          }
        }
      }
      const exit = await child.result
      if (exit.code !== 0 || buffer.trim() || !observed) throw Error(`step exit ${exit.code}: ${errors.slice(0, 250)}`)
      await record($, { event: 'completed-step', agentId: e.agentId, index: e.index, elapsedMs: Date.now() - started,
        model: modelUsed, reason, toolNames: calls.map(c => c.name), answerChars: answer.length, events: observed, usage: counts })
      if (reason === 'end_turn') finals.set(e.agentId, answer)
      yield { kind: 'stop', stopReason: reason, usage: counts }
      return { turnId: e.turnId, index: e.index, answer, toolUses: calls, stopReason: reason, usage: counts }
    } catch (error) {
      const text = `gate step error: ${String(error).slice(0, 280)}`
      await record($, { event: 'step-error', agentId: e.agentId, index: e.index, reason: text })
      finals.set(e.agentId, text)
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  })
}
