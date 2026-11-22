import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorker, reportSchema } from './worker-loop.mjs'
import { validateGroundedClaims } from '../domain/claim-grounding.mjs'

const sourceText = 'Close: USD 125.53; the company has not confirmed a management change.'
const assignment = { topicId: 't', predictionId: 'p', runId: 'r', assignmentId: 'worker', agentInstanceId: 'instance',
  objective: 'Read and cite the public source.', inputEvidence: [], allowedTools: ['read_source'], timePolicy: 'live' }
const agentSpec = { agentSpecId: 'verification', specVersion: 1, instructions: 'Use real source excerpts.', allowedTools: ['read_source'] }
const call = (id, name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls', usage: { total_tokens: 50 } })
const report = quote => ({ status: 'complete', summary: '已读取并核验来源，概率仅为有限估计。', evidenceIds: ['source'],
  support: [{ claim: '来源列出的收盘价为USD 125.53。', basis: 'fact', evidenceIds: ['source'], citations: [{ evidenceId: 'source', quote }] }],
  counterevidence: [], missingEvidence: [], probability: .5, nextSuggestion: 'Wait for the future result.' })

test('malformed citation feedback identifies min8/max600 paths, redacts input, and allows one valid repair', async t => {
  assert.equal(reportSchema.properties.support.items.properties.citations.items.properties.quote.minLength, 8)
  assert.equal(reportSchema.properties.support.items.properties.citations.items.properties.quote.maxLength, 600)
  for (const [keyword, limit, invalidQuote] of [['minLength', 8, '125.53'], ['maxLength', 600, 'PRIVATE_QUOTE_VALUE'.repeat(40)]]) {
    await t.test(keyword, async () => {
      const events = []; let requests = 0, reads = 0
      const provider = { async complete({ messages, tools }) {
        requests++
        const submit = tools.find(tool => tool.function.name === 'submit_report')
        assert.match(submit.function.description, /8至600字符.*连续片段/)
        assert.match(submit.function.description, /125\.53.*短数字/)
        assert.match(submit.function.description, /日期翻译.*inference/)
        assert.match(submit.function.description, /每个evidenceId须有对应quote/)
        if (requests === 1) return call('read', 'read_source', {})
        if (requests === 2) return call('malformed', 'submit_report', { ...report(invalidQuote), 'sk-PRIVATE_PROPERTY': 'PRIVATE_EXTRA_VALUE' })
        assert.equal(requests, 3, 'A field-specific correction should complete on the next response')
        const feedback = JSON.parse(messages.at(-1).content)
        assert.equal(feedback.error.code, 'INVALID_REPORT')
        const detail = feedback.error.validationErrors.find(error => error.keyword === keyword)
        assert.equal(detail.instancePath, '/support/0/citations/0/quote')
        assert.deepEqual(detail.params, { limit })
        assert.match(feedback.summary, /\/support\/0\/citations\/0\/quote/)
        assert.match(feedback.summary, /8至600字符.*原文连续片段/)
        assert.doesNotMatch(JSON.stringify(feedback), /125\.53|PRIVATE_QUOTE_VALUE|sk-PRIVATE_PROPERTY|PRIVATE_EXTRA_VALUE/)
        return call('repaired', 'submit_report', report(sourceText))
      } }
      const output = await runWorker({ provider, assignment, agentSpec, tools: [{ toolId: 'read_source', version: 1,
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        execute() { reads++; return { status: 'ok', data: { text: sourceText }, evidenceIds: ['source'], summary: '已读取公开原文。',
          observedAt: '2026-11-22T00:00:00.000Z', error: null } } }],
        reportPolicy: { version: 'quoted-claims-v1', check(value) {
          try { validateGroundedClaims(value.support, [{ evidenceId: 'source', text: sourceText, readBy: [assignment.assignmentId] }], { readerId: assignment.assignmentId }); return null }
          catch (error) { return error.message }
        }, review: value => value }, onEvent: event => events.push(event) })
      assert.equal(requests, 3); assert.equal(reads, 1)
      assert.equal(output.report.status, 'complete')
      assert.equal(output.report.support[0].citations[0].quote, sourceText)
      assert.equal(output.usage.modelRequests, 3)
      const rejected = events.find(event => event.type === 'tool.failed')
      assert.match(rejected.payload.summary, /\/support\/0\/citations\/0\/quote/)
      assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_QUOTE_VALUE|sk-PRIVATE_PROPERTY|PRIVATE_EXTRA_VALUE/)
    })
  }
})
