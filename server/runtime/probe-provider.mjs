import { setTimeout as delay } from 'node:timers/promises'

// Protocol fixture for offline development. This is not a live LLM response.
export function createProbeProvider({ pacingMs = 0 } = {}) {
  const action = (id, name, args) => ({
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls', usage: null,
  })
  return {
    model: 'offline-protocol-fixture', mode: 'mock',
    async complete({ messages, tools = [], signal }) {
      if (pacingMs > 0) await delay(pacingMs, undefined, { signal })
      const results = messages.filter((item) => item.role === 'tool')
      const allowed = new Set(tools.map((tool) => tool.function.name))
      const calls = messages.filter((item) => item.role === 'assistant').flatMap((item) => item.tool_calls || [])
      const namedResult = (name) => {
        const call = calls.find((item) => item.function.name === name)
        const result = call && results.find((item) => item.tool_call_id === call.id)
        return result ? JSON.parse(result.content) : null
      }
      const listed = namedResult('list_provided_sources')
      if (!listed && allowed.has('list_provided_sources')) return action('probe_list', 'list_provided_sources', {})
      const initial = messages.find((item) => item.role === 'user')
      const sourceId = listed?.data?.sources?.[0]?.evidenceId || (initial && JSON.parse(initial.content).inputEvidenceIds?.[0])
      const read = namedResult('read_evidence')
      if (!read && sourceId && allowed.has('read_evidence')) return action('probe_read', 'read_evidence', { evidenceId: sourceId })
      const evidence = read?.status === 'ok' ? read.data : null
      return action('probe_report', 'submit_report', {
        status: evidence ? 'complete' : 'insufficient',
        summary: evidence ? `协议模拟报告：已读取「${evidence.title}」。${evidence.text.slice(0, 100)}` : '协议模拟报告：未能取得材料正文，请补充资料或启用原文读取工具。',
        evidenceIds: evidence ? [evidence.evidenceId] : [], support: [], counterevidence: [], missingEvidence: evidence ? [] : ['可读取的材料正文'],
        probability: null, nextSuggestion: '此结果只验证调用与存储协议，事件预测由后续里程碑实现。',
      })
    },
  }
}
