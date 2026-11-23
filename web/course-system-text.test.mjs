import assert from 'node:assert/strict'
import { test } from 'node:test'
import { courseSystemTextParts } from './course-system-text.mjs'
import { translateUiText } from './locale.mjs'
import { buildMemorySnapshot } from '../server/course/memory-policy.mjs'

const translatedParts = (text, kind) => courseSystemTextParts(text, kind).map(part => part.system ? translateUiText(part.text, 'en') : part.text).join('')

test('canonical saved memory templates translate their recorded counts without changing the snapshot', () => {
  const memory = buildMemorySnapshot({ requestId: 'q', asOf: '2026-11-23T00:00:00Z' })
  const before = structuredClone(memory)
  assert.deepEqual(courseSystemTextParts(memory.summary, 'memory'), [{ text: memory.summary, system: true }])
  assert.doesNotMatch(translatedParts(memory.summary, 'memory'), /\p{Script=Han}/u)
  const historical = '历史记忆：近14天3次实质研判、12份报告；近120天9条来源关系。旧概率和资料只作历史比较与检索线索，本轮引用必须重新读取；检索窗口不删除封存档案。'
  assert.match(translatedParts(historical, 'memory'), /3 substantive judgments and 12 reports over 14 days; 9 source relationships over 120 days/u)
  assert.deepEqual(memory, before)
})

test('only exact triage templates and canonical numeric closeout forms become system UI', () => {
  for (const text of ['首次按题选择差异职责。', '首批新原文已取得，立即交主 Agent 分诊。', '内容重复、价格变化未达阈值或来源不可读，不新增概率。']) {
    assert.equal(courseSystemTextParts(text, 'triage')[0].system, true)
    assert.doesNotMatch(translatedParts(text, 'triage'), /\p{Script=Han}/u)
  }
  const receipt = '执行器预算收尾回执：本研究员已取得3项资料，但未在本次额度内完成有效判断。以下资料供主Agent整理，不代表完整研究报告或已验证概率。'
  assert.match(translatedParts(receipt, 'closeout'), /obtained 3 materials/u)
  assert.doesNotMatch(translatedParts(receipt, 'closeout'), /\p{Script=Han}/u)
  for (const kind of ['triage', 'memory', 'closeout']) for (const original of ['保存预算', '首次按题选择差异职责。这是用户的原文', '历史记忆：模型报告里提到的历史段落', '执行器预算收尾回执：这是一段原文引用']) {
    assert.deepEqual(courseSystemTextParts(original, kind), [{ text: original, system: false }])
    assert.equal(translatedParts(original, kind), original)
  }
})

test('partial closeout translates only its program header and preserves all embedded role and report prose', () => {
  const original = '本轮已结束，保留2个不同职责的有效报告。保存预算：模型连接；自定义研究员：原文第 2 轮 · 失败'
  const before = original
  const parts = courseSystemTextParts(original, 'closeout')
  assert.equal(parts.length, 2)
  assert.equal(parts[0].system, true)
  assert.equal(parts[1].system, false)
  assert.equal(parts[1].text, '保存预算：模型连接；自定义研究员：原文第 2 轮 · 失败')
  assert.equal(translatedParts(original, 'closeout'), 'This run has ended. Valid reports from 2 distinct roles were retained. 保存预算：模型连接；自定义研究员：原文第 2 轮 · 失败')
  assert.equal(original, before)
})
