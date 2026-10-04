import type { Register } from 'claude-code'

const output = (root: string, name: string) => `${root}/../captures/b-${name}.txt`

export const register: Register = on => {
  let dispatched = false
  const completed = new Map<string, string>()
  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'shell',
      description: 'Run a synthetic streaming process and report its complete output.',
      prompt: 'Return exactly the streamed synthetic output.',
      tools: [],
      model: 'gpt-6-luna',
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const config = JSON.parse(await $.fs.read(`${$.plugin.root}/mode.json`) as string)
    const root = $.plugin.root
    await $.fs.write(output(root, `step-${e.turnId}-${e.index}`), JSON.stringify({ agentId: e.agentId ?? null, turnId: e.turnId, index: e.index, model: e.model, dispatched }))
    if (!e.agentId) {
      if (!dispatched) {
        dispatched = true
        const input = {
          description: 'Spike B streaming shell',
          prompt: 'Stream synthetic progress and report all lines.',
          subagent_type: 'spikeb:shell',
          run_in_background: Boolean(config.background),
        }
        yield { kind: 'tool', index: 0, id: 'toolu_spike_b_01', name: 'Agent' }
        yield { kind: 'input', index: 0, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Agent', input }], stopReason: 'tool_use', usage: null }
      }
      if (config.cancel && e.index === 1) {
        await $.process.run(['sleep', '30'], { timeoutMs: 45000 })
        const target = (await $.agent.list()).find(a => a.type === 'spikeb:shell' && a.status === 'running')
        if (target) {
          const input = { task_id: target.id }
          yield { kind: 'tool', index: 0, id: 'toolu_spike_b_stop', name: 'TaskStop' }
          yield { kind: 'input', index: 0, json: JSON.stringify(input) }
          yield { kind: 'stop', stopReason: 'tool_use', usage: null }
          return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'TaskStop', input }], stopReason: 'tool_use', usage: null }
        }
      }
      const agents = await $.agent.list()
      await $.fs.write(output(root, 'main-transcript'), JSON.stringify(await $.session.messages({ as: 'api' }), null, 2))
      await $.fs.write(output(root, 'agents'), JSON.stringify(agents, null, 2))
      for (const agent of agents.filter(a => a.type === 'spikeb:shell')) {
        try {
          const messages = await $.session.messages({ agentId: agent.id, as: 'api' })
          await $.fs.write(output(root, 'transcript'), JSON.stringify(messages, null, 2))
        } catch (error) {
          await $.fs.write(output(root, 'transcript-error'), String(error))
        }
      }
      const answer = `SPIKEB-MAIN-DONE mode=${config.background ? 'background' : 'foreground'} agents=${JSON.stringify(agents)}\n`
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    const agents = await $.agent.list()
    if (!agents.some(a => a.id === e.agentId && a.type === 'spikeb:shell')) {
      yield* next(e)
      return
    }
    if (completed.has(e.agentId)) {
      await $.fs.write(output(root, 'transcript'), JSON.stringify(await $.session.messages({ agentId: e.agentId, as: 'api' }), null, 2))
      const input = { message: completed.get(e.agentId) }
      yield { kind: 'tool', index: 0, id: 'toolu_spike_b_handback', name: 'SubagentHandback' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SubagentHandback', input }], stopReason: 'tool_use', usage: null }
    }
    const pidfile = output(root, 'pid')
    await $.fs.write(output(root, 'started'), JSON.stringify({ agentId: e.agentId, timestamp: await $.clock.now() }))
    try {
      let answer = ''
      const child = $.process.spawn({ argv: ['bash', `${root}/hooks/ticker.sh`, config.short ? 'short' : 'full', pidfile] })
      for await (const chunk of child) {
        const text = chunk.stream === 'stdout' ? chunk.text : `STDERR: ${chunk.text}`
        answer += text
        yield { kind: 'text', index: 0, text }
      }
      completed.set(e.agentId, answer)
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    } finally {
      await $.fs.write(output(root, 'finally'), JSON.stringify({ agentId: e.agentId, timestamp: await $.clock.now() }))
    }
  })
}
