import type { Register } from 'claude-code'

const agentPrompt = 'You are a GPT coding subagent. Follow the task literally; use only Read, Glob, Grep, Bash, Edit, Write. Report what succeeded and any tool errors.'
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
const str = { type: 'string' }
// Captured verbatim schemas, including descriptions, are in tool-schemas-2.1.288.json.
// This static table preserves the JSON Schema fields relevant to tool arguments.
const schemas: Record<string, unknown> = {
  Bash: obj({ command: str, timeout: { type: 'number' }, description: str, run_in_background: { type: 'boolean' }, dangerouslyDisableSandbox: { type: 'boolean' } }, ['command']),
  Edit: obj({ file_path: str, old_string: str, new_string: str, replace_all: { type: 'boolean', default: false } }, ['file_path', 'old_string', 'new_string']),
  Glob: obj({ pattern: str, path: str }, ['pattern']),
  Grep: obj({ pattern: str, path: str, glob: str, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, '-A': { type: 'number' }, '-B': { type: 'number' }, '-C': { type: 'number' }, context: { type: 'number' }, '-n': { type: 'boolean' }, '-i': { type: 'boolean' }, '-o': { type: 'boolean' }, type: str, head_limit: { type: 'number' }, offset: { type: 'number' }, multiline: { type: 'boolean' } }, ['pattern']),
  Read: obj({ file_path: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', exclusiveMinimum: 0 }, pages: str }, ['file_path']),
  Write: obj({ file_path: str, content: str }, ['file_path', 'content']),
}
const tools = Object.entries(schemas).map(([name, input_schema]) => ({ name, description: `Use the ${name} tool.`, input_schema }))
let logfile = ''
let previous = ''
async function record($: any, entry: Record<string, unknown>) {
  if (!logfile) return
  previous += JSON.stringify(entry) + '\n'
  await $.fs.write(logfile, previous)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const dir = await $.env.get('SPIKEA_DIR')
    const root = await $.env.get('SPIKEA_ROOT')
    const ui = await $.env.get('SPIKEA_UI')
    logfile = root ? `${root}/captures/a-${ui ? 'ui' : 'run'}-events.txt` : ''
    previous = ''
    await $.agent.register({ name: 'gpt', description: 'Native GPT tool loop spike', prompt: agentPrompt, tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'], model: 'gpt-6-luna' })
    await record($, { event: 'start', dir, plugin: 'spikea', ui: Boolean(ui) })
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType === 'spikea:gpt') {
      await record($, { event: 'agent.spawn', backgroundWas: e.background, prompt: e.prompt })
      return next({ ...e, background: false })
    }
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const agents = await $.agent.list()
      const agent = agents.find(a => a.id === e.agentId)
      if (agent?.type === 'spikea:gpt') {
        const dir = await $.env.get('SPIKEA_DIR')
        const input = e as Record<string, unknown>
        await record($, { event: 'tool.call', tool: e.tool, agentId: e.agentId, file_path: input.file_path, command: e.tool === 'Bash' ? input.command : undefined })
        if (e.tool === 'Edit' && typeof input.file_path === 'string' && !(input.file_path as string).startsWith(`${dir}/`)) {
          await record($, { event: 'tool.deny', reason: 'Edit outside spike directory' })
          return { deny: 'SPIKE A policy: Edit outside spike directory denied' }
        }
      }
    }
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    const dir = await $.env.get('SPIKEA_DIR')
    const scenario = await $.env.get('SPIKEA_CASE')
    if (!e.agentId) {
      if (e.index === 0) {
        await record($, { event: 'main-pass-through', index: e.index })
        return yield* next(e)
      } else {
        const messages = await $.session.messages({ as: 'api' })
        const last = messages.at(-1)
        await record($, { event: 'main-followup', index: e.index, lastRole: last?.role, lastContents: last?.content?.map((b: any) => ({ type: b.type, text: String(b.content || b.text || '').slice(0, 1200) })) })
        yield { kind: 'text', index: 0, text: 'Spike A parent finished.' }
        const usage = { model: 'gpt-6-luna', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        yield { kind: 'stop', stopReason: 'end_turn', usage }
        return { turnId: e.turnId, index: e.index, answer: 'Spike A parent finished.', toolUses: [], stopReason: 'end_turn', usage }
      }
    }
    const agents = await $.agent.list()
    if (agents.find(a => a.id === e.agentId)?.type !== 'spikea:gpt') return yield* next(e)
    const messages = await $.session.messages({ agentId: e.agentId, as: 'api' })
    if (!Array.isArray(messages)) throw Error(`session.messages denied: ${messages.deny}`)
    await record($, { event: 'agent-step', agentId: e.agentId, index: e.index, model: e.model, messages: messages.map((m: any) => ({ role: m.role, content: m.content.map((b: any) => ({ type: b.type, text: b.type === 'text' ? String(b.text).slice(0, 800) : undefined, name: b.name, tool_use_id: b.tool_use_id, signature: b.type === 'thinking' ? Boolean(b.signature) : undefined, is_error: b.is_error, result: b.type === 'tool_result' ? String(b.content).slice(0, 900) : undefined })) })) })
    if (scenario === 'ui') {
      await $.clock.sleep(1500, { signal: next.signal })
      const step = [
        { name: 'Read', input: { file_path: `${dir}/sample.txt` } },
        { name: 'Bash', input: { command: 'pwd', description: 'Show current directory' } },
        { name: 'Edit', input: { file_path: `${dir}/sample.txt`, old_string: 'before: original', new_string: 'after: gpt' } },
        { name: 'SubagentHandback', input: { message: 'Read succeeded (before: original); Bash pwd returned the spike directory; Edit changed sample.txt to after: gpt.' } },
      ][e.index]
      const usage = { model: 'gpt-6-luna', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (step) {
        yield { kind: 'tool', index: 0, id: `toolu_spikea_ui_${e.index}_00001`, name: step.name }
        yield { kind: 'input', index: 0, json: JSON.stringify(step.input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [step], stopReason: 'tool_use', usage }
      }
      const answer = 'UI test complete.'
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage }
    }
    if (scenario === 'invalid' && e.index === 0) {
      yield { kind: 'tool', index: 0, id: 'toolu_spikea_invalid_0001', name: 'Read' }
      yield { kind: 'input', index: 0, json: JSON.stringify({ file_path: 42 }) }
      const usage = { model: 'gpt-6-luna', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      yield { kind: 'stop', stopReason: 'tool_use', usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Read', input: { file_path: 42 } }], stopReason: 'tool_use', usage }
    }
    if (scenario === 'deny' && e.index === 0) {
      yield { kind: 'tool', index: 0, id: 'toolu_spikea_denied_00001', name: 'Edit' }
      const input = { file_path: '/tmp/claudex-spike-a-outside.txt', old_string: 'old', new_string: 'new' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      const usage = { model: 'gpt-6-luna', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      yield { kind: 'stop', stopReason: 'tool_use', usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Edit', input }], stopReason: 'tool_use', usage }
    }
    if ((scenario === 'invalid' || scenario === 'deny') && e.index > 0) {
      const answer = 'Spike case completed; see recorded tool results.'
      const usage = { model: 'gpt-6-luna', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage }
    }
    const body = {
      model: scenario === 'thinking' ? 'gpt-6-luna@high' : 'gpt-6-luna', max_tokens: 1600, system: agentPrompt, messages,
      tools, stream: false, metadata: { user_id: 'spike-a-local' },
    }
    const start = Date.now()
    const response = await $.http.fetch('http://127.0.0.1:18765/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const elapsed = Date.now() - start
    if (!response.ok) {
      await record($, { event: 'fetch-error', status: response.status, elapsedMs: elapsed, body: response.text.slice(0, 300) })
      throw Error(`proxy HTTP ${response.status}`)
    }
    const reply = JSON.parse(response.text)
    await record($, { event: 'fetch', index: e.index, elapsedMs: elapsed, bytes: response.text.length, stopReason: reply.stop_reason, blocks: reply.content?.map((b: any) => ({ type: b.type, name: b.name, signature: b.type === 'thinking' ? Boolean(b.signature) : undefined })), usage: reply.usage })
    const offset = scenario === 'thinking' && e.index === 0 ? 1 : 0
    if (offset) yield { kind: 'thinking', index: 0, text: 'spike synthetic reasoning sentinel' }
    for (const [position, block] of (reply.content || []).entries()) {
      const index = position + offset
      if (block.type === 'text') yield { kind: 'text', index, text: block.text }
      if (block.type === 'thinking') yield { kind: 'thinking', index, text: block.thinking }
      if (block.type === 'tool_use') {
        yield { kind: 'tool', index, id: block.id, name: block.name }
        yield { kind: 'input', index, json: JSON.stringify(block.input) }
      }
    }
    const usage = { ...reply.usage, model: reply.model || 'gpt-6-luna' }
    yield { kind: 'stop', stopReason: reply.stop_reason, usage }
    return { turnId: e.turnId, index: e.index, answer: reply.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '', toolUses: reply.content?.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ name: b.name, input: b.input })) || [], stopReason: reply.stop_reason, usage }
  })
}
