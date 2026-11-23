import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OUTPUT_LANGUAGES, withRequestOutputLanguage } from './output-language.mjs'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createCourseStore } from './course-store.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { estimateModelInputTokens } from '../runtime/model-budget.mjs'
import { assembleForecastCandidate, partialForecastSummary } from './bounded-forecast.mjs'
import { assembleResearchCandidate } from './research-assembly.mjs'

const NOW = '2026-11-19T07:20:30.000Z'
const MARKER = '[SAVED_REQUEST_OUTPUT_LANGUAGE]'
const firstContext = input => JSON.parse(input.messages.find(message => message.role === 'user').content)
const policyText = input => input.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
const hasLanguage = (input, language) => {
  const text = policyText(input)
  assert.equal(text.split(MARKER).length - 1, language === undefined ? 0 : 1)
  if (language) assert(text.includes('Output language: ' + language))
}
async function fixture(t, { harnessVersion = 2 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-output-language-'))
  let currentTime = NOW, revision = 1
  const workbench = createWorkbenchService({ path: join(folder, 'domain.sqlite'), now: () => currentTime })
  const sourceTools = createWebResearchGateway({ env: { WORLD_SEARCH_PROVIDER: 'fixture' }, now: () => currentTime,
    fixturePages: () => ['official', 'news', 'verification'].map(role => ({ url: 'https://example.com/course-lab/' + role, title: '【模拟】' + role, text: '【模拟原文】普通增量版本' + revision + '；未来结果未知，原始资料保留。' })) })
  const services = []
  t.after(async () => { for (const service of services) await service.close(); workbench.close(); await rm(folder, { recursive: true, force: true }) })
  return { folder, workbench, sourceTools, revise() { revision++ }, advance() { currentTime = new Date(Date.parse(currentTime) + 3_601_000).toISOString() },
    open(provider = createCourseMockProvider(), path = join(folder, 'course.sqlite')) {
      const service = createCourseService({ path, workbench, sourceTools, provider, modelMode: 'mock', now: () => currentTime, harnessVersion })
      services.push(service); return service
    } }
}

test('language instructions clone immutable histories, preserve transport handles and originals, and do not accumulate', () => {
  const signal = new AbortController().signal
  const messages = Object.freeze([Object.freeze({ role: 'system', content: 'Original system rule' }), Object.freeze({ role: 'user', content: '原问题 https://example.test/原文' })])
  const input = { messages, signal, tools: [], maxTokens: 100 }
  assert.equal(withRequestOutputLanguage(input, undefined), input, 'legacy requests retain their exact input')
  const english = withRequestOutputLanguage(input, 'en')
  assert.equal(english.signal, signal)
  assert.notEqual(english.messages, messages)
  assert.equal(english.messages[1].content, messages[1].content)
  assert.equal(messages[0].content, 'Original system rule')
  hasLanguage(english, 'en')
  assert.deepEqual(withRequestOutputLanguage(english, 'en').messages, english.messages)
  const chinese = withRequestOutputLanguage(english, 'zh-CN')
  hasLanguage(chinese, 'zh-CN')
  assert(!policyText(chinese).includes('Output language: en'))
  hasLanguage(english, 'en')
  assert(estimateModelInputTokens(english.messages, input.tools) > estimateModelInputTokens(messages, input.tools), 'the policy contributes to the exact messages used for budget estimation')
  for (const invalid of ['EN', 'zh', '', null, 1, {}]) assert.throws(() => withRequestOutputLanguage(input, invalid), { code: 'INVALID_OUTPUT_LANGUAGE' })
})

test('service validates optional language before creating records or making model calls', async t => {
  const f = await fixture(t)
  let calls = 0
  const protocol = createCourseMockProvider()
  const service = f.open({ ...protocol, async complete(input) { calls++; return protocol.complete(input) } })
  assert.deepEqual(service.capabilities.outputLanguages, OUTPUT_LANGUAGES)
  for (const value of [undefined, null, 'EN', 'zh', '', false, 5, {}]) assert.throws(() => service.createRequest({ question: '【模拟】语言校验', outputLanguage: value }), { code: 'INVALID_OUTPUT_LANGUAGE', status: 400 })
  assert.equal(service.listRequests().length, 0)
  assert.equal(calls, 0)
})

test('English, Chinese and legacy requests isolate every main/worker call and keep their language after restart, manual check and watch', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const protocol = createCourseMockProvider(), calls = []
  const provider = { ...protocol, async complete(input) {
    const all = JSON.stringify(input.messages)
    const tag = ['LANG_EN', 'LANG_ZH', 'LANG_OLD'].find(value => all.includes(value))
    assert(tag, 'the call belongs to one saved request')
    const language = { LANG_EN: 'en', LANG_ZH: 'zh-CN' }[tag]
    hasLanguage(input, language)
    calls.push({ tag, worker: Boolean(firstContext(input).agentSpecId), phase: firstContext(input).phase })
    return protocol.complete(input)
  } }
  const initial = f.open(provider)
  const inputs = [
    { question: '【模拟 LANG_EN】未来48小时虚构科技展会开幕吗？', outputLanguage: 'en', watch: true },
    { question: '【模拟 LANG_ZH】未来48小时虚构科技展会开幕吗？', outputLanguage: 'zh-CN', watch: false },
    { question: '【模拟 LANG_OLD】未来48小时虚构科技展会开幕吗？', watch: false },
  ]
  const created = inputs.map((input, i) => initial.createRequest(input, { idempotencyKey: 'language-' + i }))
  await initial.idle()
  for (const [index, request] of created.entries()) {
    const done = initial.getRequest(request.requestId)
    assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
    assert.equal(done.outputLanguage, inputs[index].outputLanguage)
    assert.equal(Object.hasOwn(done, 'outputLanguage'), index !== 2)
    const own = calls.filter(call => call.tag === ['LANG_EN', 'LANG_ZH', 'LANG_OLD'][index])
    assert(own.some(call => !call.worker))
    assert(own.filter(call => call.worker).length >= 3)
    assert.equal(done.run.usage.modelRequests, own.length, 'language instructions add no translation calls')
  }
  const legacyRetry = initial.createRequest(inputs[2], { idempotencyKey: 'language-2' })
  assert.equal(legacyRetry.requestId, created[2].requestId)
  assert.throws(() => initial.createRequest({ ...inputs[2], outputLanguage: 'en' }, { idempotencyKey: 'language-2' }), { code: 'IDEMPOTENCY_CONFLICT' })
  const historical = structuredClone(initial.getRequest(created[0].requestId).forecast)
  await initial.close()
  const resumed = f.open(provider)
  assert.equal(resumed.getRequest(created[0].requestId).outputLanguage, 'en')
  f.revise()
  const beforeCheck = calls.length
  resumed.check(created[0].requestId); await resumed.idle()
  assert(calls.length > beforeCheck)
  assert(calls.slice(beforeCheck).every(call => call.tag === 'LANG_EN'))
  assert.deepEqual(resumed.getRequest(created[0].requestId).forecasts[0], historical)
  f.revise(); f.advance(); resumed.resume()
  await delay(70); await resumed.idle()
  const latest = resumed.getRequest(created[0].requestId)
  assert.equal(latest.run.trigger, 'watch')
  assert.equal(latest.outputLanguage, 'en')
  assert.equal(latest.run.status, 'completed', JSON.stringify(latest.run.error))
})

test('recovered research summaries use the saved English policy on the actual retry call', async t => {
  const f = await fixture(t), protocol = createCourseMockProvider()
  let failed = false, resumedCalls = 0
  const provider = { ...protocol, async complete(input) {
    hasLanguage(input, 'en')
    if (input.tools.some(tool => tool.function.name === 'submit_research_report')) {
      if (!failed) { failed = true; throw Object.assign(new Error('fixture incomplete summary'), { code: 'MODEL_INCOMPLETE', usage: { total_tokens: 0 } }) }
      resumedCalls++
    }
    return protocol.complete(input)
  } }
  const service = f.open(provider)
  const created = service.createRequest({ question: '【模拟】核验虚构科技展财报', purpose: 'research', outputLanguage: 'en' })
  await service.idle()
  let done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'failed')
  assert.equal(done.run.phase, 'review')
  service.resumeResearchSummary(done.run.runId); await service.idle()
  done = service.getRequest(created.requestId)
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error))
  assert(resumedCalls > 0)
  assert.equal(done.outputLanguage, 'en')
})

async function checkReservationBoundary(t, { harnessVersion = 3, purpose = 'research' } = {}) {
  const f = await fixture(t, { harnessVersion }), protocol = createCourseMockProvider()
  let originalInput
  const stop = () => Object.assign(new Error('fixture stop after reservation'), { code: 'MODEL_AUTH_FAILED', usage: { total_tokens: 0 } })
  const probe = f.open({ ...protocol, async complete(input) {
    originalInput ??= { messages: structuredClone(input.messages), tools: structuredClone(input.tools), maxTokens: input.maxTokens }
    throw stop()
  } })
  const question = '【模拟】预算边界语言测试'
  const created = probe.createRequest({ question, purpose })
  await probe.idle()
  const budget = probe.getRequest(created.requestId).budget
  assert(originalInput)
  await probe.close()
  const originalCost = Buffer.byteLength(JSON.stringify(originalInput.messages), 'utf8') + Buffer.byteLength(JSON.stringify(originalInput.tools), 'utf8') + originalInput.maxTokens + 2048
  const maximum = originalCost + 100
  const english = withRequestOutputLanguage(originalInput, 'en')
  const englishCost = Buffer.byteLength(JSON.stringify(english.messages), 'utf8') + Buffer.byteLength(JSON.stringify(english.tools), 'utf8') + english.maxTokens + 2048
  assert(englishCost > maximum)
  for (const language of [undefined, 'en']) {
    const path = join(f.folder, language === 'en' ? 'english-budget.sqlite' : 'legacy-budget.sqlite')
    const store = createCourseStore({ path, now: () => NOW })
    const input = { purpose, question, horizonHours: 48, timezone: 'Asia/Shanghai', mode: 'preset', watch: false,
      modelMode: 'mock', sourceMode: 'replay', providerIdentity: protocol.configurationId || protocol.model,
      modelRef: protocol.model, budget: { ...budget, maxTotalTokens: maximum }, harnessVersion,
      ...(language ? { outputLanguage: language } : {}) }
    const saved = store.createRequest(input)
    store.close()
    let requests = 0
    const service = f.open({ ...protocol, async complete(call) { requests++; hasLanguage(call, language); throw stop() } }, path)
    service.resume(); await service.idle()
    assert.equal(requests, language === 'en' ? 0 : 1, 'only the policy pushes the English call over the same budget boundary: ' + JSON.stringify({ error: service.getRequest(saved.requestId).run.error, maximum, originalCost }))
    assert.equal(service.getRequest(saved.requestId).run.usage.modelRequests, language === 'en' ? 0 : 1)
  }
}

test('the added language policy participates in the actual pre-call reservation boundary', async t => checkReservationBoundary(t))

test('v2 forecast language requests reserve before the provider, while old requests retain legacy behavior', async t => checkReservationBoundary(t, { harnessVersion: 2, purpose: 'forecast' }))


test('English deterministic report labels preserve probabilities, claims, evidence and exact legacy output', () => {
  const assignments = ['market', 'verification'].map((roleId, index) => ({ roleId, name: roleId, assignmentId: roleId, status: 'completed',
    report: { status: 'complete', summary: 'The original source was reviewed.', probability: index ? 0.6 : 0.4, evidenceIds: ['e_' + roleId], missingEvidence: ['The future outcome remains uncertain.'],
      support: [{ claim: 'The source was read for this report.', basis: 'inference', evidenceIds: ['e_' + roleId], citations: [{ evidenceId: 'e_' + roleId, quote: '原始引文保持原样。' }] }], counterevidence: [] } }))
  const evidence = assignments.map(item => ({ evidenceId: item.report.evidenceIds[0], text: '原始引文保持原样。', readBy: [item.assignmentId] }))
  const original = structuredClone({ assignments, evidence })
  const legacy = assembleForecastCandidate(assignments, evidence)
  const english = assembleForecastCandidate(assignments, evidence, { outputLanguage: 'en' })
  assert.equal(english.probabilityYes, 0.5)
  assert.deepEqual(english.reasoningClaims, legacy.reasoningClaims)
  assert.deepEqual(english.evidenceIds, legacy.evidenceIds)
  assert.deepEqual(english.scorecard, legacy.scorecard)
  assert.deepEqual(english.dissent, legacy.dissent)
  assert(english.summary.startsWith('Bounded report aggregation: 2'))
  assert(english.sourceLimitations.every(text => !/[\u4e00-\u9fff]/u.test(text)))
  assert(english.decisionNotes.every(note => !/[\u4e00-\u9fff]/u.test(note.reason)))
  assert.deepEqual(assembleForecastCandidate(assignments, evidence, { outputLanguage: 'zh-CN' }), legacy)
  assert.equal(legacy.summary, '有界报告汇集：2个不同职责的研究员已提交带证据的概率估计，按候选概率中位数汇集为Yes 50%。主Agent未完成有效最终裁决，程序仅整理已核验报告；该估计未校准，来源可能重叠。')
  const partial = partialForecastSummary(assignments, evidence, '预算已用完', { outputLanguage: 'en' })
  assert.equal(partial.probabilityYes, null)
  assert(partial.summary.startsWith('This run has ended.'))
  assert(partial.summary.includes(assignments[0].report.summary))
  assert(!/[\u4e00-\u9fff]/u.test(partial.reason + partial.notice))
  assert.deepEqual(partialForecastSummary(assignments, evidence, '旧原因', { outputLanguage: 'zh-CN' }), partialForecastSummary(assignments, evidence, '旧原因'))
  const compiled = assembleResearchCandidate(assignments, evidence, { outputLanguage: 'en' })
  assert(compiled.summary.startsWith('Researcher report compilation: 2'))
  assert(compiled.findings.every(finding => finding.claim.endsWith('The source was read for this report.')))
  assert(compiled.limitations.every(text => !/[\u4e00-\u9fff]/u.test(text)))
  assert.deepEqual(assembleResearchCandidate(assignments, evidence, { outputLanguage: 'zh-CN' }), assembleResearchCandidate(assignments, evidence))
  assert.deepEqual({ assignments, evidence }, original, 'saved reports, original quotes and evidence are never translated or changed')
})

test('English assemble-report persists English system prose without new model calls or changed evidence', async t => {
  const f = await fixture(t), protocol = createCourseMockProvider()
  let calls = 0
  const provider = { ...protocol, async complete(input) {
    calls++; hasLanguage(input, 'en')
    const result = await protocol.complete(input)
    for (const call of result.message.tool_calls || []) {
      if (call.function.name === 'submit_research_report') throw Object.assign(new Error('fixture summary truncation'), { code: 'MODEL_INCOMPLETE', usage: { total_tokens: 0 } })
      if (call.function.name === 'submit_report') {
        const args = JSON.parse(call.function.arguments)
        args.summary = 'The researcher reviewed the original source.'
        args.missingEvidence = ['The available source has limited coverage.']
        for (const claim of [...(args.support || []), ...(args.counterevidence || [])]) { claim.claim = 'The cited original source was reviewed.'; claim.basis = 'inference' }
        call.function.arguments = JSON.stringify(args)
      }
    }
    return result
  } }
  const service = f.open(provider)
  const created = service.createRequest({ question: '【模拟】核验财报原文', purpose: 'research', outputLanguage: 'en' })
  await service.idle()
  const before = service.getRequest(created.requestId)
  assert.equal(before.run.status, 'failed')
  const count = calls
  const assembled = service.assembleResearchReport(before.run.runId)
  const after = service.getRequest(created.requestId)
  assert.equal(calls, count)
  assert.deepEqual(assembled.usage, before.run.usage)
  assert.deepEqual(after.evidence, before.evidence)
  assert(assembled.researchReport.summary.startsWith('Researcher report compilation:'))
  assert(assembled.researchReport.findings.every(finding => finding.claim.includes(' report: The cited original source was reviewed.')))
  assert(assembled.researchReport.decisionNotes.every(note => note.reason.startsWith('The program assembled')))
  assert(assembled.researchReport.limitations.every(text => !/[\u4e00-\u9fff]/u.test(text)))
})
