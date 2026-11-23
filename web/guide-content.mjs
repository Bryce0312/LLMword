// Read-only tutorial content. It never creates tasks, calls models or writes live data.
export const guideProgressKey = 'world-lab.guide.progress'
export const guideRealTaskQuestion = '预测腾讯股票'

export const guidePaths = Object.freeze([
  Object.freeze({
    id: 'collaboration',
    number: '01',
    title: '完整协作：从派工到判断',
    summary: '从 BTC 的 24 小时判断开始，看主 Agent 怎么分工、研究员怎么找资料，最后怎么把支持和反对写进结论。',
    caseId: 'btc',
    kind: '模拟／回放案例',
    steps: Object.freeze([
      Object.freeze({
        label: '初次协作',
        title: '一次完整的分工与判断',
        focus: Object.freeze([
          '先看主 Agent 怎样把问题拆成调查任务，而不是只给一句结论。',
          '再看每位研究员提交了什么、引用了哪些来源，以及哪些资料没有解决。',
          '最后看结论里哪些意见被采纳、哪些保留为缺口或异议。',
        ]),
        note: '这是模拟回复与历史快照，用来说明分工；里面的概率不代表真实预测成绩。',
      }),
    ]),
    takeaways: Object.freeze([
      '研究员的调查互相独立，主 Agent 负责选人、比较和记录采纳理由。',
      '概率、证据充分度和协作一致性分开记录，缺资料不会补成 50%。',
      '房间与记录都由已保存的运行事件驱动，不是事后编的剧情。',
    ]),
  }),
  Object.freeze({
    id: 'update',
    number: '02',
    title: '新证据局部复核：只重开需要重开的部分',
    summary: '同一个 BTC 题目来了新资料，看系统只让相关研究员补查，以及概率为什么从 54% 变成 66%。',
    caseId: 'update',
    kind: '模拟／回放案例',
    steps: Object.freeze([
      Object.freeze({
        label: '初次协作',
        title: '先建立基线',
        focus: Object.freeze([
          '先确认上一轮已经发布的判断和证据范围。',
          '注意哪些结论依赖旧资料，后续可能被新证据修正。',
        ]),
        note: '基线不变，后续比较才有意义。',
      }),
      Object.freeze({
        label: '新证据局部复核',
        title: '只补查受影响的部分',
        focus: Object.freeze([
          '看主 Agent 为什么选择这位研究员补查。',
          '看补查返回了什么新证据，以及概率是否因此变化。',
        ]),
        note: '补查答复提交不等于争议已经解决。',
      }),
      Object.freeze({
        label: '重复资料检查',
        title: '重复资料不重复计数',
        focus: Object.freeze([
          '看重复来源是否被识别，而不是当作第二份独立证据。',
          '看仍未解决的缺口是否被明确保留。',
        ]),
        note: '资料变多不等于证据变强。',
      }),
    ]),
    takeaways: Object.freeze([
      '新证据先判断影响范围，再决定局部复核，避免整轮重跑。',
      '重复资料不会自动增加证据权重。',
      '概率变化只说明判断更新，不代表准确率提高。',
    ]),
  }),
  Object.freeze({
    id: 'recovery',
    number: '03',
    title: '失败与恢复：先留下失败记录，再重新协作',
    summary: '模型鉴权失败时先留下失败记录；恢复后重新跑一轮，旧记录不删。',
    caseId: 'recovery',
    kind: '模拟／回放案例',
    steps: Object.freeze([
      Object.freeze({
        label: '失败记录',
        title: '失败也要留下可追溯记录',
        focus: Object.freeze([
          '先看失败发生在哪一步，以及错误是否被明确显示。',
          '注意失败记录没有伪造概率，也没有把等待状态写成结论。',
        ]),
        note: '失败记录是后续恢复和审计的依据。',
      }),
      Object.freeze({
        label: '初次协作',
        title: '恢复后从新运行开始',
        focus: Object.freeze([
          '看恢复后的运行是否重新派工和取证。',
          '确认旧失败记录仍然保留，没有被新结果覆盖。',
        ]),
        note: '新运行成功不代表旧失败可以删除。',
      }),
    ]),
    takeaways: Object.freeze([
      '失败先如实记录，再谈恢复。',
      '恢复创建新的运行，旧记录继续保留供追溯。',
      '没有成功取得的工具结果，不会被标成成功。',
    ]),
  }),
])

export function findGuidePath(id) {
  return guidePaths.find(path => path.id === id) ?? null
}

const emptyProgress = () => ({ version: 1, paths: {} })

export function readGuideProgress(storage) {
  try {
    const raw = storage?.getItem?.(guideProgressKey)
    if (!raw) return emptyProgress()
    const value = JSON.parse(raw)
    if (!value || value.version !== 1 || !value.paths || typeof value.paths !== 'object') return emptyProgress()
    const paths = {}
    for (const [id, record] of Object.entries(value.paths)) {
      const steps = Array.isArray(record?.steps)
        ? [...new Set(record.steps.filter(Number.isInteger).filter(step => step >= 0))].sort((a, b) => a - b)
        : []
      paths[id] = { steps, done: record?.done === true }
    }
    return { version: 1, paths }
  } catch {
    return emptyProgress()
  }
}

export function writeGuideProgress(storage, progress) {
  try { storage?.setItem?.(guideProgressKey, JSON.stringify(progress)) } catch {}
  return progress
}

export function markGuideStep(progress, pathId, stepIndex) {
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return progress
  const record = progress.paths[pathId] ?? { steps: [], done: false }
  if (record.steps.includes(stepIndex)) return progress
  return { version: 1, paths: { ...progress.paths, [pathId]: { ...record, steps: [...record.steps, stepIndex].sort((a, b) => a - b) } } }
}

export function markGuideDone(progress, pathId) {
  const record = progress.paths[pathId] ?? { steps: [], done: false }
  return { version: 1, paths: { ...progress.paths, [pathId]: { ...record, done: true } } }
}

export function guidePathState(path, progress) {
  const record = progress.paths[path.id]
  const visited = (record?.steps ?? []).filter(step => step < path.steps.length).length
  if (record?.done) return { status: 'done', visited, total: path.steps.length }
  if (visited) return { status: 'active', visited, total: path.steps.length }
  return { status: 'new', visited: 0, total: path.steps.length }
}

export function firstUnfinishedStep(path, progress) {
  const visited = new Set(progress.paths[path.id]?.steps ?? [])
  for (let index = 0; index < path.steps.length; index++) if (!visited.has(index)) return index
  return 0
}
