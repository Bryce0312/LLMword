import { setTimeout as delay } from 'node:timers/promises'
import { checkCancelled } from '../runtime/model-provider.mjs'
import { digest } from '../domain/contracts.mjs'
import { roleCatalogue, suggestedRoles } from './course-context.mjs'

/** Explicit synthetic usage with the same split counters a real provider reports. */
const FIXTURE_USAGE = { total_tokens: 180, prompt_tokens: 120, completion_tokens: 60, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 80 }

import { marketPricePair } from './market-report.mjs'

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
        assignments: (context.defaultRoleIds || suggestedRoles(context.question, context.roleCatalogue)).map((roleId) => ({ roleId, objective: `${context.question}。${(context.roleCatalogue || roleCatalogue()).find((role) => role.roleId === roleId)?.focus}`, reason: `协议模拟按题选择${roleId}。` })),
      })
      if (available.has('normalize_prediction')) {
        if (context.draft && context.evidence?.length) {
          const source = context.evidence.find((item) => item.url === context.strict?.resolutionSourceUrl) || context.evidence.find((item) => !item.marketQuote) || context.evidence[0]
          return action('normalize_prediction', { question: context.question, object: context.draft.object, targetAt: context.strict?.targetAt || context.targetAt,
            forecastClosesAt: context.strict?.targetAt || context.targetAt, timezone: context.strict?.timezone || context.timezone,
            resolutionRule: context.strict?.resolutionRule || '协议模拟规则：根据目标窗口指定原文核验；无法取得结果时不结算。',
            resolutionSourceUrl: context.strict?.resolutionSourceUrl || source.url, unresolvablePolicy: '无法取得对应原文时不结算。', watchQuery: context.question.slice(0, 110) })
        }
        if (context.draft && !context.evidence?.length) return action('mark_insufficient', { message: '协议演示未取得可引用原文。', missingFields: ['sourceText'], directionUnavailable: true })
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
      if (available.has('delegate_work')) return action('delegate_work', { assignments: (context.selectedRoleIds || (context.defaultRoleIds || suggestedRoles(context.question, context.roleCatalogue))).map((roleId) => ({ roleId,
        objective: `${context.question}。${(context.roleCatalogue || roleCatalogue()).find((role) => role.roleId === roleId)?.focus}`,
        reason: `协议演示按题选择${roleId}的调查方法，不把所有题目交给相同团队。` })) })
      if (available.has('submit_research_report')) {
        const reports = (context.reports || []).filter((item) => item.evidenceIds?.length)
        if (!reports.length) return action('mark_insufficient', { message: '模拟研报未取得原文。', missingFields: ['researchEvidence'] })
        return action('submit_research_report', { summary: '协议模拟研报：核对财报事实、管理层表述与来源边界，不产生预测概率。',
          findings: reports.slice(0, 5).map((item) => ({ ...(item.support?.[0] || { claim: item.summary, evidenceIds: item.evidenceIds }), basis: 'inference' })),
          limitations: ['这是受控模拟，不能证明实际市场因果或预测准确率。'], decisionNotes: reports.map((item) => ({ assignmentId: item.assignmentId, disposition: 'qualified', reason: '采用实际已读资料，保留模拟与资料边界。', evidenceIds: item.evidenceIds })) })
      }
      if (available.has('request_followup') || available.has('propose_forecast') || available.has('propose_price_direction') || available.has('submit_direction_outlook')) {
        const evidenceIds = [...new Set((context.reports || []).flatMap((report) => report.evidenceIds))]
        if (evidenceIds.length && available.has('request_followup') && !context.followUpDone) return action('request_followup', {
          roleId: 'verification', objective: `复核协议示例新闻线索与正式来源的口径是否一致。问题：${context.question}`,
          reason: '协议示例中新闻线索与正式披露的证明范围不同，需要再读取并明确证据边界。', evidenceIds,
        })
        if (!evidenceIds.length) return action('mark_insufficient', { message: '协议演示没有研究员实际读取的原文。', missingFields: ['workerEvidence'], directionUnavailable: true })
        if (available.has('submit_direction_outlook') && !available.has('propose_price_direction')) {
          return action('submit_direction_outlook', { direction: 'up', summary: '协议模拟：已读样例中的利好线索支持暂定上涨。', evidenceIds,
            missingFields: ['缺少可核验的固定报价基准。'] })
        }
        const checksum = parseInt(digest(context.evidence.map((item) => item.contentHash)).slice(0, 4), 16)
        const directional = available.has('propose_price_direction')
        return action(directional ? 'propose_price_direction' : 'propose_forecast', {
          ...(directional ? { probabilityUp: 0.48, probabilityFlat: 0.12, probabilityDown: 0.4 } : { probabilityYes: 0.5 + (checksum % 20) / 100, outcomeKnown: false, outcome: null }),
          summary: directional ? '协议模拟：根据已有报告给出三个价格方向的演示概率。' : '协议模拟：已合并三份独立报告及针对性核验。此数值只演示完整流程，不是真实事件预测。',
          ...(context.groundingPolicy ? { reasoningClaims: (context.reports || []).flatMap((report) => report.support || []).slice(0, 5) } : {}),
          decisionNotes: (context.reports || []).map((report) => ({ assignmentId: report.assignmentId, disposition: 'qualified',
            reason: report.status === 'complete' ? '协议模拟：保留该报告实际已读材料作为调查依据，未消除未来结果的不确定性。' : '协议模拟：该报告资料不足，保留缺口，不将其候选概率作为已确认事实。', evidenceIds: report.evidenceIds })),
          evidenceIds, evidenceAdequacy: 'limited', dissent: ['模拟资料无法支持现实预测准确率主张。'] })
      }
      // Same native protocol as live workers, with independent per-assignment message histories.
      const workerContext = initial ? JSON.parse(initial.content) : {}
      const workerTask = workerContext.objective ? JSON.parse(workerContext.objective) : {}
      const quotePair = marketPricePair(workerTask.draft?.originalQuestion || workerTask.contract?.question || workerTask.task || '')
      const workerCalls = messages.filter((message) => message.role === 'assistant').flatMap((message) => message.tool_calls || [])
      const workerResult = (name) => {
        const call = workerCalls.findLast((item) => item.function.name === name)
        const result = call && messages.findLast((item) => item.role === 'tool' && item.tool_call_id === call.id)
        return result ? JSON.parse(result.content) : null
      }
      if (available.has('get_weather_warning') && !workerResult('get_weather_warning')) return action('get_weather_warning', {})
      if (available.has('get_market_quote') && quotePair && !workerResult('get_market_quote')) {
        return action('get_market_quote', { pair: available.has('get_market_history') ? 'BTC-USDT' : quotePair })
      }
      const warning = workerResult('get_weather_warning')
      if (available.has('get_market_history') && !workerResult('get_market_history')) return action('get_market_history', { pair: 'BTC-USDT' })
      const priceHistory = workerResult('get_market_history'), ownQuote = workerResult('get_market_quote')
      if (priceHistory && ownQuote) {
        const evidenceIds = [...new Set([...(ownQuote.evidenceIds || []), ...(priceHistory.evidenceIds || [])])]
        return action('submit_report', { status: ownQuote.status === 'ok' && priceHistory.status === 'ok' ? 'complete' : 'insufficient', summary: '协议模拟：本人读取现价及已关闭分钟桶，未来方向仍未知。', evidenceIds,
          support: ownQuote.data?.text ? [{ claim: '本轮已读取匹配现价，仅为当前观察。', basis:'inference', evidenceIds:ownQuote.evidenceIds, citations:[{evidenceId:ownQuote.evidenceIds[0],quote:ownQuote.data.text.slice(0,180)}] }, {claim:'已取得有限历史样本，不能当作未来已实现结果。',basis:'inference',evidenceIds:priceHistory.evidenceIds,citations:[{evidenceId:priceHistory.evidenceIds[0],quote:priceHistory.data.text.slice(0,180)}]}] : [],
          counterevidence: [],missingEvidence:['未来价格未知，未进行概率校准。'],probability:null,nextSuggestion:'到期按固定现价规则核验。' })
      }
      const search = workerResult('search_news') || workerResult('search_web') || (warning?.data ? { data: { results: [warning.data] } } : null)
      if (!search && available.has('search_news') && workerTask.purpose === 'research') return action('search_news', { queryZh: '虚构公司 财报 管理层 表述', queryEn: 'fictional company earnings management remarks' })
      if (!search) return action('search_web', { query: `${workerContext.agentSpecId} ${workerContext.objective}`.slice(0, 80) })
      const source = search.data?.results?.find((item) => item.url.includes(workerContext.agentSpecId === 'timeline' ? '/news' : workerContext.agentSpecId === 'verification' ? '/verification' : '/official')) || search.data?.results?.[0]
      const read = warning || workerResult('fetch_page')
      if (source && !read) return action('fetch_page', { url: source.url })
      const evidenceIds = [...new Set([...(['ok', 'partial'].includes(read?.status) ? read.evidenceIds : []), ...(workerResult('get_market_quote')?.evidenceIds || [])])]
      const citations = read?.evidenceIds?.length ? [{ evidenceId: read.evidenceIds[0], quote: read.data.text.slice(0, 180) }] : []
      return action('submit_report', { status: evidenceIds.length ? 'complete' : 'insufficient',
        summary: evidenceIds.length ? `协议模拟${workerContext.agentSpecId}报告：已读取「${read?.data?.title || '当前报价'}」。${citations.length && workerTask.forecastType === 'price_direction' ? '演示利好线索支持暂定上涨。' : '保留来源证明范围。'}` : '协议模拟未取得正文。',
        ...(citations.length && workerTask.forecastType === 'price_direction' ? { priceDirection: 'up' } : {}),
        evidenceIds, support: citations.length ? [{ claim: '该演示原文可用于核对本次子问题。', evidenceIds: [read.evidenceIds[0]], ...(workerTask.groundingPolicy ? { basis: 'inference', citations } : {}) }] : [],
        counterevidence: workerContext.agentSpecId === 'verification' && citations.length ? [{ claim: '演示线索不能自动证明事件已发生。', evidenceIds: [read.evidenceIds[0]], ...(workerTask.groundingPolicy ? { basis: 'inference', citations } : {}) }] : [],
        missingEvidence: ['现实前瞻结果尚未在此协议示例中验证。'], probability: null, nextSuggestion: '按指定来源后续变化继续核查。' })
    },
  }
}
