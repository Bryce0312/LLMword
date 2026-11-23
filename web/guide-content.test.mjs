import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guidePaths, findGuidePath, guideProgressKey, readGuideProgress, writeGuideProgress, markGuideStep, markGuideDone, guidePathState, firstUnfinishedStep } from './guide-content.mjs'
import { translateUiText } from './locale.mjs'

function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }
}

test('tutorial paths mirror the archived demo snapshots without creating new cases', () => {
  assert.equal(guidePaths.length, 3)
  assert.deepEqual(guidePaths.map(path => path.id), ['collaboration', 'update', 'recovery'])
  assert.deepEqual(guidePaths.map(path => [path.caseId, path.steps.length]), [['btc', 1], ['update', 3], ['recovery', 2]])
  assert.equal(findGuidePath('update')?.title, '新证据局部复核：只重开需要重开的部分')
  assert.equal(findGuidePath('missing'), null)
  for (const path of guidePaths) {
    assert.equal(path.kind, '模拟／回放案例')
    assert.ok(path.takeaways.length >= 3)
    for (const step of path.steps) {
      assert.ok(step.label)
      assert.ok(step.focus.length >= 2)
      assert.ok(step.note)
    }
  }
})

test('local progress is sanitized, deduplicated and never mutates the input record', () => {
  const storage = memoryStorage()
  assert.deepEqual(readGuideProgress(storage), { version: 1, paths: {} })
  storage.setItem(guideProgressKey, '{broken json')
  assert.deepEqual(readGuideProgress(storage), { version: 1, paths: {} })
  storage.setItem(guideProgressKey, JSON.stringify({ version: 1, paths: { update: { steps: [1, 'x', -1, 1, 0], done: 'yes' } } }))
  assert.deepEqual(readGuideProgress(storage).paths.update, { steps: [0, 1], done: false })

  const empty = readGuideProgress(memoryStorage())
  const once = markGuideStep(empty, 'update', 1)
  const twice = markGuideStep(once, 'update', 1)
  assert.deepEqual(empty.paths, {}, 'marking a step must not mutate the previous record')
  assert.equal(once, twice, 'a repeated visit is a no-op')
  assert.deepEqual(once.paths.update.steps, [1])

  const path = findGuidePath('update')
  assert.equal(guidePathState(path, empty).status, 'new')
  assert.equal(guidePathState(path, once).status, 'active')
  assert.equal(guidePathState(path, once).visited, 1)
  assert.equal(firstUnfinishedStep(path, once), 0)
  const later = markGuideStep(markGuideStep(empty, 'update', 2), 'update', 0)
  assert.equal(firstUnfinishedStep(path, later), 1)
  const done = markGuideDone(later, 'update')
  assert.equal(guidePathState(path, done).status, 'done')
  writeGuideProgress(storage, done)
  assert.deepEqual(readGuideProgress(storage), done)
})

test('missing or throwing storage degrades to an empty progress record', () => {
  assert.deepEqual(readGuideProgress(null), { version: 1, paths: {} })
  const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.deepEqual(readGuideProgress(throwing), { version: 1, paths: {} })
  assert.doesNotThrow(() => writeGuideProgress(throwing, { version: 1, paths: {} }))
})

test('every tutorial string has English coverage while the prefilled security stays original', () => {
  const localized = text => assert.doesNotMatch(translateUiText(text, 'en'), /[\p{Script=Han}]/u, text)
  for (const path of guidePaths) {
    for (const text of [path.title, path.summary, path.kind]) localized(text)
    for (const step of path.steps) {
      localized(step.label); localized(step.title); localized(step.note)
      step.focus.forEach(localized)
    }
    path.takeaways.forEach(localized)
  }
  for (const text of [
    '教程', '教程：从案例看懂研究室', '未开始', '开始学习', '继续学习', '再看一遍',
    '已完成', '进行中 1 / 3', '3 个章节', '第 2 章 / 共 3 章', '本章导读', '读不懂这些词？',
    '研究员速览', '查看完整归档协作记录', '上一章', '下一章', '完成本路径', '教程完成', '记住这三点',
    '下一步', '示例（可修改）：', '开始一次真实预测', '返回研究室', '换一条路径', '找不到这条教程路径',
    '返回欢迎页', '教程已并入欢迎页', '教程目录不再单独显示，请在欢迎页选择学习路径。', '请返回欢迎页重新选择。',
    '教程案例尚未生成，请在项目目录运行 npm run cases。', '教程对应的案例记录不存在。',
  ]) localized(text)
  assert.equal(translateUiText('预测腾讯股票', 'en'), '预测腾讯股票')
})
