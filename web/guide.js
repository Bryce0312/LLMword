import { getLocale } from './locale.mjs'
import { h, header, button, link, dataContent } from './workbench-core.js'
import { renderCollaboration } from './course-collaboration.js'
import { goBack, requestTutorialFocus } from './route-history.mjs'
import { guidePaths, findGuidePath, guidePathState, firstUnfinishedStep, readGuideProgress, writeGuideProgress, markGuideStep, markGuideDone, guideRealTaskQuestion } from './guide-content.mjs'

const guideStorage = () => { try { return globalThis.localStorage ?? null } catch { return null } }

function guideLink(text, hash, cls = '') { return link(text, hash, cls) }

function guideBackRow(fallback) {
  return h('div', 'guide-back-row',
    button('← 返回上一页', () => {
      const target = goBack(fallback)
      if (target.startsWith('#/welcome')) requestTutorialFocus()
    }, 'wb-text-button guide-back'))
}

function guideWelcomeButton(label) {
  return button(label, () => { requestTutorialFocus(); location.hash = '#/welcome' }, 'wb-button')
}

const decisionLabels = { adopted: '采纳', qualified: '保留条件', rejected: '未采纳' }
const decisionReadings = {
  adopted: '主 Agent 采纳了这份报告，但它仍只是当前证据的一部分。',
  qualified: '材料能作为调查线索，但还不足以消除未来不确定性；这不是涨跌结论。',
  rejected: '这份报告没有被采纳，具体原因保留在原始记录里。',
}
const guideTerms = [
  ['保留条件', '材料可以作为调查线索，但还不能消除未来不确定性；它不是涨跌结论。'],
  ['未解决缺口', '这一轮没有拿到或没有验证的资料，会继续留在记录里。'],
  ['补查', '主 Agent 只重开受影响的部分，不是整轮重跑。'],
  ['证据充分度', '现有材料够不够支撑判断；它不等同于概率高低。'],
]

function memberCards(collaboration) {
  const team = collaboration?.team ?? []
  if (!team.length) return [h('p', 'guide-member-empty', '这一轮没有研究员提交可用报告。')]
  return team.map((member) => {
    const evidence = member.evidenceIds?.length ?? 0
    const support = member.support?.length ?? 0
    const counter = member.counterevidence?.length ?? 0
    const gaps = member.missingEvidence?.length ?? 0
    const disposition = member.decision?.disposition
    return h('article', 'guide-member',
      h('div', 'guide-member-head',
        h('strong', '', member.name || member.roleId || '研究员'),
        h('span', 'guide-member-verdict', decisionLabels[disposition] || '未裁决')),
      h('p', 'guide-member-counts', `读到的材料 ${evidence} 份 · 支持 ${support} · 反证 ${counter} · 未解决 ${gaps}`),
      h('p', 'guide-member-reading', decisionReadings[disposition] || '这份报告没有形成裁决，细节保留在原始记录里。'))
  })
}

function guideTermsSection() {
  return h('section', 'guide-terms wb-paper',
    h('h2', '', '读不懂这些词？'),
    h('div', 'guide-term-grid', ...guideTerms.map(([term, text]) => h('div', 'guide-term',
      h('strong', '', term),
      h('p', '', text)))))
}

function stateLabel(state) {
  if (state.status === 'done') return '已完成'
  if (state.status === 'active') return `进行中 ${state.visited} / ${state.total}`
  return '未开始'
}

export function guidePathCards() {
  const progress = readGuideProgress(guideStorage())
  return guidePaths.map((path) => {
    const state = guidePathState(path, progress)
    const badge = h('span', 'guide-path-state', stateLabel(state)); badge.dataset.state = state.status
    return h('article', 'guide-path-card',
      h('div', 'guide-path-top', h('span', 'guide-path-number', path.number), badge),
      h('h2', '', path.title),
      h('p', 'guide-path-summary', path.summary),
      h('p', 'guide-path-meta', h('span', '', path.kind), ' · ', h('span', '', state.total + ' 个章节')),
      guideLink(state.status === 'new' ? '开始学习' : state.status === 'done' ? '再看一遍' : '继续学习', '#/guide/' + encodeURIComponent(path.id), 'wb-button'))
  })
}

function stepIndex(path, raw) {
  if (raw === undefined || raw === null || raw === '') return firstUnfinishedStep(path, readGuideProgress(guideStorage()))
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 && index < path.steps.length ? index : 0
}

async function loadGuideCases() {
  const response = await fetch('/demo/cases.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('教程案例尚未生成，请在项目目录运行 npm run cases。')
  const data = await response.json()
  if (data.notAccuracyBenchmark !== true || !Array.isArray(data.cases)) throw new Error('案例文件标识无效。')
  return data
}

async function guideChapter(path, rawIndex) {
  const storage = guideStorage()
  const index = stepIndex(path, rawIndex)
  writeGuideProgress(storage, markGuideStep(readGuideProgress(storage), path.id, index))
  const step = path.steps[index]
  const data = await loadGuideCases()
  const item = data.cases.find(value => value.id === path.caseId)
  if (!item) throw new Error('教程对应的案例记录不存在。')
  const snapshot = item.snapshots[index] ?? item.snapshots[0]
  const trace = h('div', 'guide-trace cc-collaboration')
  renderCollaboration(trace, snapshot.collaboration)
  const archive = h('details', 'guide-archive',
    h('summary', '', '查看完整归档协作记录'),
    h('p', 'guide-note', '下面是原始字段与来源，供核对；先读上方速览即可理解流程。'),
    trace)
  const steps = h('nav', 'guide-step-nav')
  for (const [position, entry] of path.steps.entries()) {
    const anchor = h('a', 'guide-step-link', h('span', '', (position + 1) + '. '), h('span', '', entry.label))
    anchor.href = '#/guide/' + encodeURIComponent(path.id) + '/' + position
    if (position === index) anchor.setAttribute('aria-current', 'step')
    steps.append(anchor)
  }
  const actions = h('div', 'guide-actions wb-actions',
    index > 0 ? guideLink('上一章', '#/guide/' + encodeURIComponent(path.id) + '/' + (index - 1), 'wb-button') : null,
    index < path.steps.length - 1
      ? guideLink('下一章', '#/guide/' + encodeURIComponent(path.id) + '/' + (index + 1), 'wb-button wb-primary')
      : guideLink('完成本路径', '#/guide/' + encodeURIComponent(path.id) + '/done', 'wb-button wb-primary'))
  return [
    guideBackRow('#/welcome'),
    header(path.title, path.summary),
    h('div', 'guide-runbar',
      h('span', 'guide-badge', path.kind),
      h('span', '', `第 ${index + 1} 章 / 共 ${path.steps.length} 章`),
      dataContent('span', 'guide-case-title', item.title)),
    steps,
    h('section', 'guide-focus wb-paper',
      h('h2', '', '本章导读'),
      h('p', 'guide-step-title', step.title),
      h('ul', '', ...step.focus.map((line) => h('li', '', line))),
      h('p', 'guide-note', step.note)),
    guideTermsSection(),
    h('section', 'guide-case wb-paper',
      h('h2', '', '研究员速览'),
      h('p', 'guide-note', '先看每位研究员做了什么；需要核对原文时再展开完整归档。'),
      h('div', 'guide-member-grid', ...memberCards(snapshot.collaboration)),
      archive),
    actions,
  ]
}

function guideDone(ctx, path) {
  const storage = guideStorage()
  writeGuideProgress(storage, markGuideDone(readGuideProgress(storage), path.id))
  const example = h('input', 'guide-prefill-input')
  example.type = 'text'
  const builtInQuestion = locale => locale === 'en' ? 'Predict Tencent stock' : guideRealTaskQuestion
  let defaultQuestion = builtInQuestion(getLocale())
  let exampleEdited = false
  example.value = defaultQuestion
  example.setAttribute('data-i18n-language-control', 'true')
  example.addEventListener('input', () => { exampleEdited = true })
  example.addEventListener('world-lab:localechange', event => {
    // This owned sample input is the sole exception: never translate a user-edited draft.
    if (example.value !== defaultQuestion) exampleEdited = true
    defaultQuestion = builtInQuestion(event.detail?.locale ?? getLocale())
    if (!exampleEdited) example.value = defaultQuestion
  })
  example.maxLength = 2000
  example.autocomplete = 'off'
  example.setAttribute('aria-label', '示例预测问题，可修改')
  const start = button('开始一次真实预测', () => {
    ctx.courseRetryInput = { question: example.value.trim() || builtInQuestion(getLocale()), purpose: 'forecast', mode: 'preset' }
    location.hash = '#/course'
  }, 'wb-button wb-primary')
  return [
    guideBackRow('#/welcome'),
    header('教程完成', path.title),
    h('section', 'guide-done wb-paper',
      h('h2', '', '记住这三点'),
      h('ul', '', ...path.takeaways.map((line) => h('li', '', line))),
      h('p', 'guide-note', '教程使用模拟／回放案例，概率与来源状态只用于说明流程，不代表真实预测或准确率。')),
    h('section', 'guide-next wb-paper',
      h('h2', '', '下一步'),
      h('p', '', '真实预测需要你填写证券并点击开始；教程只会预填一个示例，不会自动提交。'),
      h('label', 'guide-prefill', h('span', '', '示例（可修改）：'), example),
      h('div', 'wb-actions', start, guideLink('返回研究室', '#/room', 'wb-button'), guideWelcomeButton('换一条路径'))),
  ]
}

export async function guideView(ctx, parts = []) {
  if (!parts[1]) return [
    header('教程已并入欢迎页', '教程目录不再单独显示，请在欢迎页选择学习路径。'),
    guideWelcomeButton('返回欢迎页'),
  ]
  const path = findGuidePath(parts[1])
  if (!path) return [
    header('找不到这条教程路径', '请返回欢迎页重新选择。'),
    guideWelcomeButton('返回欢迎页'),
  ]
  if (parts[2] === 'done') return guideDone(ctx, path)
  return guideChapter(path, parts[2])
}
