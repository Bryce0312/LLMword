import { setTimeout as delay } from 'node:timers/promises'
import { checkCancelled } from '../runtime/model-provider.mjs'
import { digest } from '../domain/contracts.mjs'
import { roleCatalogue, suggestedRoles } from './course-context.mjs'

/** Explicit synthetic usage with the same split counters a real provider reports. */
const FIXTURE_USAGE = { total_tokens: 180, prompt_tokens: 120, completion_tokens: 60, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 80 }

/** Explicit, reproducible protocol fixture. It never presents its values as live forecasts. */
export function createCourseMockProvider({ pacingMs = 0 } = {}) {
  return {
    model: 'course-protocol-fixture-v1', configurationId: 'course-protocol-fixture-v1', mode: 'mock',
    async complete({ messages, tools = [], signal }) {
      if (pacingMs) await delay(pacingMs, undefined, { signal })
      checkCancelled(signal)
      const available = new Set(tools.map((tool) => tool.function.name))
      const initial = messages.find((message) => message.role === 'user')
      const lastUser = messages.findLastIndex((message) => message.role === 'user')
      let context = {}; try { context = JSON.parse(messages[lastUser].content) } catch {}
      const recent = messages.slice(lastUser + 1)
      const calls = recent.filter((message) => message.role === 'assistant').flatMap((message) => message.tool_calls || [])
      const results = recent.filter((message) => message.role === 'tool').map((message) => {
        const call = calls.find((item) => item.id === message.tool_call_id)
        try { return { name: call?.function.name, value: JSON.parse(message.content) } } catch { return null }
      }).filter(Boolean)
      const found = (name) => results.findLast((item) => item.name === name)?.value
      const action = (name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{
        id: `fixture_${messages.filter((message) => message.role === 'assistant').length}_${name}`,
        type: 'function', function: { name, arguments: JSON.stringify(args) },
      }] }, finishReason: 'tool_calls', usage: { ...FIXTURE_USAGE } })
      if (available.has('draft_and_delegate')) return action('draft_and_delegate', {
        question: context.question, object: '用户提出的事件（协议模拟草稿）', interpretation: '待研究员实际取证的题意草稿，不是预测。',
        assignments: suggestedRoles(context.question).map((roleId) => ({ roleId, objective: `${context.question}。${roleCatalogue().find((role) => role.roleId === roleId)?.focus}`, reason: `协议模拟按题选择${roleId}。` })),
      })
      if (available.has('normalize_prediction')) {
        if (context.draft && context.evidence?.length) {
          const source = context.evidence.find((item) => item.url === context.strict?.resolutionSourceUrl) || context.evidence.find((item) => !item.marketQuote) || context.evidence[0]
          return action('normalize_prediction', { question: context.question, object: context.draft.object, targetAt: context.strict?.targetAt || context.targetAt,
            forecastClosesAt: context.strict?.targetAt || context.targetAt, timezone: context.strict?.timezone || context.timezone,
            resolutionRule: context.strict?.resolutionRule || '协议模拟规则：根据目标窗口指定原文核验；无法取得结果时不结算。',
            resolutionSourceUrl: context.strict?.resolutionSourceUrl || source.url, unresolvablePolicy: '无法取得对应原文时不结算。', watchQuery: context.question.slice(0, 110) })
        }
        if (available.has('get_market_quote') && /比特币|BTC|bitcoin|以太|ETH/i.test(context.question) && !found('get_market_quote')) return action('get_market_quote', { pair: /ETH|以太/i.test(context.question) ? 'ETH-USD' : 'BTC-USD' })
        if (!found('search_web')) return action('search_web', { query: context.question.slice(0, 110) })
        const source = found('search_web')?.data?.results?.find((item) => item.url.includes('/official')) || found('search_web')?.data?.results?.[0]
        if (!source) return action('mark_insufficient', { message: '协议演示未取得可用的来源候选。', missingFields: ['resolutionSource'] })
        if (!found('fetch_page')) return action('fetch_page', { url: context.strict?.resolutionSourceUrl || source.url })
        const fetched = found('fetch_page')
        if (!['ok', 'partial'].includes(fetched?.status) || !fetched.evidenceIds.length) return action('mark_insufficient', { message: '协议演示原文读取失败。', missingFields: ['sourceText'] })
        return action('normalize_prediction', {
          question: context.question, object: '用户提出的事件（协议模拟）', targetAt: context.targetAt,
          forecastClosesAt: context.targetAt, timezone: context.timezone,
          resolutionRule: context.strict?.resolutionRule || '协议模拟规则：以目标时点指定来源对原问题的明确披露为准；缺少有效披露则人工核验，不把抓取失败判为否。',
          resolutionSourceUrl: fetched.data.url, unresolvablePolicy: '来源不明或失联时不结算，保留人工核验。', watchQuery: context.question.slice(0, 110),
        })
      }
      if (available.has('triage_update')) return action('triage_update', { kind: context.changeHints?.major ? 'team' : 'local',
        roleIds: context.changeHints?.major ? context.previousTeam : [context.previousTeam.find((role) => role !== 'verification'), 'verification'],
        reason: context.changeHints?.major ? '协议模拟：新原文含重大变化或冲突，召回本题团队。' : '协议模拟：普通增量只安排相关研究员和核验席。' })
      if (available.has('delegate_work')) return action('delegate_work', { assignments: (context.selectedRoleIds || suggestedRoles(context.question)).map((roleId) => ({ roleId,
        objective: `${context.question}。${roleCatalogue().find((role) => role.roleId === roleId)?.focus}`,
        reason: `协议演示按题选择${roleId}的调查方法，不把所有题目交给相同团队。` })) })
      if (available.has('request_followup') || available.has('propose_forecast')) {
        const evidenceIds = [...new Set((context.reports || []).flatMap((report) => report.evidenceIds))]
        if (available.has('request_followup') && !context.followUpDone) return action('request_followup', {
          roleId: 'verification', objective: `复核协议示例新闻线索与正式来源的口径是否一致。问题：${context.question}`,
          reason: '协议示例中新闻线索与正式披露的证明范围不同，需要再读取并明确证据边界。', evidenceIds,
        })
        if (!evidenceIds.length) return action('mark_insufficient', { message: '协议演示没有研究员实际读取的原文。', missingFields: ['workerEvidence'] })
        const checksum = parseInt(digest(context.evidence.map((item) => item.contentHash)).slice(0, 4), 16)
        return action('propose_forecast', { probabilityYes: 0.5 + (checksum % 20) / 100, summary: '协议模拟：已合并三份独立报告及针对性核验。此数值只演示完整流程，不是真实事件预测。',
          evidenceIds, evidenceAdequacy: 'limited', dissent: ['模拟资料无法支持现实预测准确率主张。'], outcomeKnown: false, outcome: null })
      }
      // Same native protocol as live workers, with independent per-assignment message histories.
      const workerContext = initial ? JSON.parse(initial.content) : {}
      const workerCalls = messages.filter((message) => message.role === 'assistant').flatMap((message) => message.tool_calls || [])
      const workerResult = (name) => {
        const call = workerCalls.findLast((item) => item.function.name === name)
        const result = call && messages.findLast((item) => item.role === 'tool' && item.tool_call_id === call.id)
        return result ? JSON.parse(result.content) : null
      }
      if (available.has('get_market_quote') && /比特币|BTC|bitcoin|以太|ETH/i.test(workerContext.objective) && !workerResult('get_market_quote')) {
        return action('get_market_quote', { pair: /ETH|以太/i.test(workerContext.objective) ? 'ETH-USD' : 'BTC-USD' })
      }
      const search = workerResult('search_web')
      if (!search) return action('search_web', { query: `${workerContext.agentSpecId} ${workerContext.objective}`.slice(0, 80) })
      const source = search.data?.results?.find((item) => item.url.includes(workerContext.agentSpecId === 'timeline' ? '/news' : workerContext.agentSpecId === 'verification' ? '/verification' : '/official')) || search.data?.results?.[0]
      const read = workerResult('fetch_page')
      if (source && !read) return action('fetch_page', { url: source.url })
      const evidenceIds = ['ok', 'partial'].includes(read?.status) ? read.evidenceIds : []
      return action('submit_report', { status: evidenceIds.length ? 'complete' : 'insufficient',
        summary: evidenceIds.length ? `协议模拟${workerContext.agentSpecId}报告：已读取「${read.data.title}」，保留来源证明范围。` : '协议模拟未取得正文。',
        evidenceIds, support: evidenceIds.length ? [{ claim: '该演示原文可用于核对本次子问题。', evidenceIds }] : [],
        counterevidence: workerContext.agentSpecId === 'verification' && evidenceIds.length ? [{ claim: '演示线索不能自动证明事件已发生。', evidenceIds }] : [],
        missingEvidence: ['现实前瞻结果尚未在此协议示例中验证。'], probability: null, nextSuggestion: '按指定来源后续变化继续核查。' })
    },
  }
}
