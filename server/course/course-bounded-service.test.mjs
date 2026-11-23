import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService } from './course-service.mjs'
import { createCourseStore } from './course-store.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { groundingPolicy, validateGroundedClaims } from '../domain/claim-grounding.mjs'

// Isolated protocol/fixture integration tests. No real model, network, credentials
// or user's database; none of these probabilities is a real validation result.
const NOW = '2026-11-22T08:00:00.000Z'
const QUESTION = '【协议测试】虚构城市科技展未来48小时会正式开幕吗？'
const contextOf = messages => JSON.parse(messages.find(message => message.role === 'user').content)
const scoreFor = role => ({ official: .35, timeline: .55, verification: .75 })[role] ?? .65
const usage = { total_tokens: 180, prompt_tokens: 120, completion_tokens: 60 }
const action = (name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{
  id: `bounded_fixture_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
}] }, finishReason: 'tool_calls', usage: { ...usage } })

async function fixture(t, { failSummary = false, scoreRoles = null, transformForecast, transformReport, fixturePages } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-bounded-protocol-'))
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => NOW })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => NOW, fixturePages })
  const protocol = createCourseMockProvider()
  const calls = []
  const provider = { ...protocol, configurationId: 'bounded-integration-fixture', async complete(input) {
    const context = contextOf(input.messages)
    calls.push({ kind: context.kind || 'worker', phase: context.phase, roleId: context.agentSpecId,
      tools: input.tools.map(tool => tool.function.name), maxTokens: input.maxTokens, context })
    if (context.kind === 'course-main' && context.phase === 'review') {
      if (failSummary) return { message: { role: 'assistant', content: '协议测试：故意不提交最终工具。' }, finishReason: 'stop', usage: { ...usage } }
      const reports = context.reports || []
      const candidate = { probabilityYes: .61, evidenceAdequacy: 'limited', outcomeKnown: false, outcome: null,
        summary: '协议测试汇总：比较三种职责已读原文后给出未校准示例概率，不代表现实预测。',
        evidenceIds: [...new Set(reports.flatMap(report => report.evidenceIds))],
        decisionNotes: reports.map(report => ({ assignmentId: report.assignmentId, disposition: report.reportQuality === 'unusable' ? 'rejected' : 'qualified',
          reason: '保留该席实际已读原文及未来未知的边界。', evidenceIds: report.evidenceIds })),
        sourceLimitations: ['静态虚构材料与注入协议不能证明真实预测能力。'], dissent: ['来源链可能重叠，概率没有校准。'] }
      const proposal = input.tools.find(tool => tool.function.name === 'propose_forecast')
      assert(!proposal.function.parameters.required.includes('reasoningClaims'), 'bounded main may omit already-validated report claims')
      return action('propose_forecast', transformForecast ? transformForecast(candidate, context) : candidate)
    }
    const response = await protocol.complete(input)
    for (const call of response.message.tool_calls || []) if (call.function.name === 'submit_report') {
      const args = JSON.parse(call.function.arguments)
      args.probability = scoreRoles === null || scoreRoles.includes(context.agentSpecId) ? scoreFor(context.agentSpecId) : null
      for (const claim of [...args.support, ...args.counterevidence]) claim.claim = context.agentSpecId + '席：' + claim.claim
      call.function.arguments = JSON.stringify(transformReport ? transformReport(args, context) : args)
    }
    return response
  } }
  const service = createCourseService({ path: join(folder, 'course.sqlite'), workbench, sourceTools, provider,
    modelMode: 'mock', harnessVersion: 3, now: () => NOW })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { service, calls }
}

function assertBoundedRoute(done, calls, { summaryCalls = 1, partialRoles = [] } = {}) {
  assert.equal(done.run.harnessVersion, 3)
  assert.equal(done.resolutionPolicy, undefined)
  assert.equal(done.budget.strategy, 'bounded-forecast-v1')
  assert.equal(done.run.budget.strategy, 'bounded-forecast-v1')
  assert.equal(done.run.budget.deliveryPolicy, 'exploratory-estimate-v1')
  assert.equal(done.run.budget.mainRequests, 10)
  assert.equal(done.run.budget.mainPhaseRequests, 3)
  assert.equal(done.run.budget.maxFollowUps, 2)
  assert.equal(done.run.orchestration.investigationSteps, 6)
  assert.equal(done.run.orchestration.reportStep, 7)
  assert.equal(done.run.orchestration.reportRepairRequests, 2)
  assert.equal(done.groundingPolicy, groundingPolicy, 'new presets enable quote validation without requiring a caller to remember it')
  const main = calls.filter(call => call.kind === 'course-main')
  assert.deepEqual(main.map(call => call.phase), ['intake', ...Array(summaryCalls).fill('review')])
  assert(main.length <= 10)
  assert(main.filter(call => call.phase === 'intake').length <= 3)
  assert(main.filter(call => call.phase === 'review').length <= 3)
  assert.equal(done.run.usage.modelRequests, calls.length, 'all coordinator and worker attempts must count toward the same run')
  assert.deepEqual(main[0].tools, ['draft_and_delegate'])
  assert(main.every(call => !call.tools.some(name => ['search_web', 'search_news', 'fetch_page', 'normalize_prediction'].includes(name))), 'coordinator cannot perform source research or model-based preparation')
  assert(done.run.events.some(event => event.type === 'contract.compiled'))
  const initial = done.run.assignments.filter(assignment => !assignment.followUp)
  assert.equal(initial.length, 3)
  assert.equal(new Set(initial.map(assignment => assignment.roleId)).size, 3)
  assert(initial.some(assignment => assignment.roleId === 'verification'))
  for (const assignment of initial) {
    assert.equal(assignment.status, 'completed', JSON.stringify(assignment.error))
    assert.equal(assignment.report.status, partialRoles.includes(assignment.roleId) ? 'insufficient' : 'complete')
    assert.equal(assignment.budget.maxModelRequests, 10)
    assert.equal(assignment.budget.maxInvestigationRequests, 6)
    assert.equal(assignment.budget.maxToolCalls, 8)
    assert(calls.filter(call => call.roleId === assignment.roleId).length <= 10)
    assert(assignment.usage.toolCalls <= 8)
    assert(assignment.report.evidenceIds.some(id => done.run.evidence.some(evidence => evidence.evidenceId === id && evidence.readBy.includes(assignment.assignmentId))), 'each seat must cite its own read')
  }
  assert(!done.run.events.some(event => event.type === 'tool.started' && event.payload.agentSpecId === 'main'))
  return initial
}

test('bounded protocol success delegates three different roles, compiles without a prepare model call, and monitoring is opt-in', async t => {
  for (const [label, input, expected] of [['default one-shot', {}, false], ['explicit monitoring', { watch: true }, true]]) {
    await t.test(label, async t => {
      const { service, calls } = await fixture(t)
      const created = service.createRequest({ question: QUESTION, ...input })
      await service.idle()
      const done = service.getRequest(created.requestId)
      assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
      const team = assertBoundedRoute(done, calls)
      assert.equal(done.watchEnabled, expected)
      assert.equal(done.watch.status, expected ? 'active' : 'off')
      assert.equal(Boolean(done.watch.nextDueAt), expected)
      assert.equal(done.forecasts.length, 1)
      assert.equal(done.forecast.probabilityYes, .61)
      assert.equal(done.forecast.scoringEligible, false, 'fixture records must never become real validation scores')
      assert.equal(done.forecast.publicationMode, undefined)
      assert.deepEqual(team.map(item => item.report.probability), team.map(item => scoreFor(item.roleId)))
      const review = calls.find(call => call.kind === 'course-main' && call.phase === 'review')
      assert.equal(review.context.scorecard.length, 3)
      assert.deepEqual(review.context.scorecard.map(item => item.probabilityYes), team.map(item => scoreFor(item.roleId)))
    })
  }
})

test('bounded summary protocol failure assembles only already-read role estimates and discloses that no main verdict completed', async t => {
  const { service, calls } = await fixture(t, { failSummary: true })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  const team = assertBoundedRoute(done, calls, { summaryCalls: 3 })
  assert.equal(done.forecasts.length, 1)
  assert.equal(done.forecast.publicationMode, 'bounded-report-aggregation')
  const scores = team.map(item => item.report.probability).sort((a, b) => a - b)
  assert.equal(done.forecast.probabilityYes, scores[1])
  assert.match(done.forecast.summary, /主Agent未完成有效最终裁决/u)
  assert(done.forecast.sourceLimitations.some(text => text.includes('不代表主Agent完成')))
  assert(done.forecast.decisionNotes.every(note => note.disposition === 'qualified'))
  assert(done.forecast.evidenceIds.every(id => done.run.evidence.some(source => source.evidenceId === id && source.text?.trim())))
  assert(done.run.events.some(event => event.type === 'budget.closeout'))
  assert.equal(done.forecast.scoringEligible, false)
})

test('fewer than two scored distinct roles end as insufficient with a null-probability partial delivery', async t => {
  const { service, calls } = await fixture(t, { failSummary: true, scoreRoles: ['verification'] })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'insufficient', JSON.stringify(done.run.error))
  const team = assertBoundedRoute(done, calls, { summaryCalls: 3 })
  assert.equal(team.filter(item => Number.isFinite(item.report.probability)).length, 1)
  assert.equal(done.forecasts.length, 0)
  assert.equal(done.forecast, null)
  assert.equal(done.run.delivery.kind, 'partial_research')
  assert.equal(done.run.delivery.generatedBy, 'harness')
  assert.equal(done.run.delivery.probabilityYes, null)
  assert.equal(done.run.delivery.roleScores.filter(item => Number.isFinite(item.probabilityYes)).length, 1)
  assert.match(done.run.delivery.notice, /不是正式概率预测/u)
})

test('a normal coordinator proposal cannot replace missing role probabilities with its own number', async t => {
  const { service, calls } = await fixture(t, { scoreRoles: [], transformForecast(candidate, context) {
    return { ...candidate, evidenceIds: context.evidence.map(source => source.evidenceId) }
  } })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'insufficient', JSON.stringify(done.run.error))
  const team = assertBoundedRoute(done, calls, { summaryCalls: 3 })
  assert(team.every(item => item.report.probability === null))
  assert(done.run.events.some(event => event.type === 'action.rejected' && event.payload.error?.code === 'CLAIM_GROUNDING'))
  assert.equal(done.forecasts.length, 0)
  assert.equal(done.forecast, null)
  assert.equal(done.run.delivery.probabilityYes, null)
})

for (const partial of [false, true]) test('one substantive ' + (partial ? 'partial' : 'complete') + ' role estimate supports a disclosed provisional Main decision', async t => {
  const { service, calls } = await fixture(t, { scoreRoles: ['verification'], transformReport(report, context) {
    return context.agentSpecId === 'verification' && partial ? { ...report, status: 'insufficient', missingEvidence: ['只找到一份有用原文，不能证明未来已实现结果。'] } : report
  } })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  const team = assertBoundedRoute(done, calls, { partialRoles: partial ? ['verification'] : [] })
  assert.equal(team.filter(item => Number.isFinite(item.report.probability)).length, 1)
  assert.equal(done.forecast.probabilityYes, .61, 'Main decides the number from the available model estimate; no artificial median or 50% is inserted')
  assert.equal(done.forecast.publicationMode, 'model-provisional-estimate')
  assert.equal(done.forecast.kind, 'conditional_estimate')
  assert.equal(done.forecast.reviewRequired, true)
  assert.equal(done.forecast.scoringEligible, false)
  assert.equal(done.forecast.evidenceAdequacy, 'limited')
  assert.equal(done.forecast.reportAdequacy.eligibleRoleCount, 1)
  assert.equal(done.forecast.reportAdequacy.partialRoleCount, partial ? 1 : 0)
  assert.equal(done.forecast.reportAdequacy.preliminary, true)
  const accepted = done.forecast.decisionNotes.filter(note => note.disposition !== 'rejected')
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].disposition, 'qualified')
  assert(done.forecast.reasoningClaims.length >= 1)
  assert.equal(done.result, null)
})

test('footer-only sources cannot support a probability even when every model report supplies a number', async t => {
  const fixturePages = ['official', 'news', 'verification'].map(role => ({ url: `https://example.com/course-lab/${role}`, title: '仅有来源页脚',
    text: '我們保留權利更改本免責聲明。更新日期為: 2026年2月9日。All rights reserved.' }))
  const { service } = await fixture(t, { fixturePages, transformForecast(candidate, context) {
    return { ...candidate, evidenceIds: context.evidence.map(source => source.evidenceId) }
  } })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'insufficient', JSON.stringify(done.run.error))
  assert(done.run.assignments.every(item => Number.isFinite(item.report.probability)))
  assert(done.run.evidence.length > 0)
  assert.equal(done.run.roleScores.length, 0)
  assert.equal(done.forecasts.length, 0)
  assert.equal(done.run.delivery.probabilityYes, null)
})

test('zero readable evidence ends without a fabricated contract or probability', async t => {
  const { service, calls } = await fixture(t, { fixturePages: [], transformReport(report) { return { ...report, probability: null } } })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'insufficient', JSON.stringify(done.run.error))
  assert.equal(done.run.evidence.length, 0)
  assert.equal(done.normalized, null)
  assert.equal(done.forecasts.length, 0)
  assert.equal(done.forecast, null)
  assert.equal(done.run.delivery.probabilityYes, null)
  assert.deepEqual(calls.filter(call => call.kind === 'course-main').map(call => call.phase), ['intake'])
})

test('omitting main claims preserves accepted original report claims verbatim and excludes a rejected report', async t => {
  const { service, calls } = await fixture(t, { transformForecast(candidate, context) {
    assert(!Object.hasOwn(candidate, 'reasoningClaims'))
    return { ...candidate, decisionNotes: candidate.decisionNotes.map(note => ({ ...note,
      disposition: context.reports.find(report => report.assignmentId === note.assignmentId).roleId === 'timeline' ? 'rejected'
        : context.reports.find(report => report.assignmentId === note.assignmentId).roleId === 'official' ? 'adopted' : 'qualified',
    })) }
  } })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  const team = assertBoundedRoute(done, calls)
  const notes = done.forecast.decisionNotes
  assert.equal(notes.filter(note => note.disposition === 'rejected').length, 1)
  assert(notes.some(note => note.disposition === 'adopted'))
  assert(notes.some(note => note.disposition === 'qualified'))
  const accepted = new Set(notes.filter(note => note.disposition !== 'rejected').map(note => note.assignmentId))
  const expected = team.filter(item => accepted.has(item.assignmentId)).flatMap(item => [...item.report.support, ...item.report.counterevidence])
  assert(expected.length >= 2)
  // The existing evidence validator normalizes excerpt punctuation/whitespace;
  // this is not permission for the coordinator to rewrite a claim or its scope.
  assert.deepEqual(done.forecast.reasoningClaims, validateGroundedClaims(expected, done.run.evidence, { asOf: NOW }))
  assert.deepEqual(done.forecast.reasoningClaims.map(({ claim, basis, evidenceIds }) => ({ claim, basis, evidenceIds })),
    expected.map(({ claim, basis, evidenceIds }) => ({ claim, basis, evidenceIds })))
  const rejected = team.find(item => !accepted.has(item.assignmentId))
  assert(rejected.report.support.every(claim => !done.forecast.reasoningClaims.some(final => final.claim === claim.claim)))
  assert.equal(done.forecast.probabilityYes, .61, 'probability remains the main model decision')
  assert.equal(done.forecast.summary, '协议测试汇总：比较三种职责已读原文后给出未校准示例概率，不代表现实预测。')
  assert.equal(done.forecast.publicationMode, undefined)
})

test('foreign references and empty decisions cannot inject claims through the omitted-claims path', async t => {
  const attempts = [
    ['foreign forecast evidence', candidate => ({ ...candidate, evidenceIds: [...candidate.evidenceIds, 'foreign_evidence'], summary: 'INJECT_FOREIGN_EVIDENCE' }), 'FORECAST_EVIDENCE'],
    ['foreign decision citation', candidate => ({ ...candidate, decisionNotes: candidate.decisionNotes.map((note, index) => index ? note : { ...note, evidenceIds: ['foreign_evidence'] }), summary: 'INJECT_FOREIGN_DECISION' }), 'DECISION_EVIDENCE'],
    ['empty decision list', candidate => ({ ...candidate, decisionNotes: [], summary: 'INJECT_EMPTY_DECISIONS' }), 'DECISION_EVIDENCE'],
    ['explicit foreign claim', candidate => ({ ...candidate, reasoningClaims: [{ claim: 'INJECT_FOREIGN_CLAIM', basis: 'inference', evidenceIds: ['foreign_evidence'], citations: [{ evidenceId: 'foreign_evidence', quote: '此原文并未由任何研究员取得。' }] }], summary: 'INJECT_FOREIGN_CLAIM' }), 'CLAIM_GROUNDING'],
  ]
  for (const [name, transformForecast, expectedCode] of attempts) await t.test(name, async t => {
    const { service, calls } = await fixture(t, { transformForecast })
    const created = service.createRequest({ question: QUESTION })
    await service.idle()
    const done = service.getRequest(created.requestId)
    assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
    assertBoundedRoute(done, calls, { summaryCalls: 3 })
    assert(done.run.events.some(event => event.type === 'action.rejected' && event.payload.error?.code === expectedCode), 'invalid main proposal must be visibly rejected')
    assert.equal(done.forecasts.length, 1)
    assert.equal(done.forecast.publicationMode, 'bounded-report-aggregation', 'only disclosed safe aggregation may recover a rejected coordinator proposal')
    assert(!JSON.stringify(done.forecast).includes('INJECT_'))
    assert(!JSON.stringify(done.forecast).includes('foreign_evidence'))
    const originals = validateGroundedClaims(done.run.assignments.flatMap(item => [...item.report.support, ...item.report.counterevidence]), done.run.evidence, { asOf: NOW })
    assert(done.forecast.reasoningClaims.every(claim => originals.some(original => JSON.stringify(original) === JSON.stringify(claim))))
  })
})

test('when reports contain no valid grounded claims neither main omission nor fallback may publish a probability', async t => {
  const { service } = await fixture(t, { transformForecast(candidate, context) {
    return { ...candidate, evidenceIds: context.evidence.map(source => source.evidenceId) }
  }, transformReport(report) {
    return { ...report, status: 'insufficient', support: [], counterevidence: [], missingEvidence: ['协议测试未提交有效可引用主张。'] }
  } })
  const created = service.createRequest({ question: QUESTION })
  await service.idle()
  const done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'insufficient', JSON.stringify(done.run.error))
  assert.equal(done.forecasts.length, 0)
  assert.equal(done.forecast, null)
  assert.equal(done.run.delivery.probabilityYes, null)
  assert.equal(done.run.roleScores.length, 0)
  assert(done.run.events.some(event => event.type === 'action.rejected' && event.payload.error?.code === 'CLAIM_GROUNDING'))
})

test('an upgrade preserves old directional records and prevents new live execution for them', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-directional-history-'))
  const file = join(folder, 'course.sqlite')
  const now = () => NOW
  const store = createCourseStore({ path: file, now })
  const saved = store.createRequest({ question: '旧股票方向', horizonTradingDays: 5, watch: true })
  const ongoing = store.createRequest({ question: '旧版未完任务', horizonTradingDays: 5, watch: true })
  const directionOutlook = { direction: 'down', summary: '已保存的暂定看跌判断。', evidenceIds: [], missingFields: ['报价'], issuedAt: NOW }
  try {
    for (const request of [saved, ongoing]) {
      store.updateRequest(request.requestId, { forecastType: 'price_direction' })
      store.saveWatch(request.requestId, { status: 'active', nextDueAt: NOW })
    }
    store.saveRun(saved.activeRunId, { status: 'completed', phase: 'finished', directionOutlook })
  } finally { store.close() }
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now })
  const mock = createCourseMockProvider()
  let modelCalls = 0
  const service = createCourseService({ path: file, workbench, now,
    sourceTools: createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now }),
    provider: { ...mock, async complete(input) { modelCalls++; return mock.complete(input) } } })
  t.after(async () => { await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  service.resume()
  await service.idle()
  assert.equal(modelCalls, 0)
  const restored = service.getRequest(saved.requestId)
  assert.deepEqual(restored.run.directionOutlook, directionOutlook)
  assert.equal(restored.run.status, 'completed')
  assert.equal(restored.watch.status, 'off')
  assert.equal(restored.watch.nextDueAt, null)
  const archived = service.getRequest(ongoing.requestId)
  assert.equal(archived.activeRunId, null)
  assert.equal(archived.run.status, 'insufficient')
  assert.match(archived.run.summary, /归档/)
  assert.throws(() => service.check(saved.requestId), { code: 'LEGACY_PRICE_DIRECTION' })
  assert.equal(service.getRequest(saved.requestId).runs.length, 1)
})
