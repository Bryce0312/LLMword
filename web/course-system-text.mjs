import { uiContent, dataContent } from './workbench-core.js'

const triageText = new Set([
  '首次按题选择差异职责。',
  '首批新原文已取得，立即交主 Agent 分诊。',
  '内容重复、价格变化未达阈值或来源不可读，不新增概率。',
])
const closeoutText = new Set([
  '研究员的最终证据判断未完成；需保留本次额度和校验限制。',
  '根据已经保存的资料给出阶段性结果，明确缺口；不为收尾继续付费调查。',
  '未追加模型调用，按有效研究员报告作明确标记的程序汇集；保留独立核验和引用守卫。',
  '阶段性资料整理，不是正式概率预测；没有补造概率或追加模型调用。',
  '本轮已结束，尚无足够的有效独立报告；已读取材料与失败原因保留。',
  '本轮已结束：已汇集研究员的有据估计；主Agent最终裁决未完成，结果标记为程序汇集、需复核。',
  '本轮已达到总 token 预算。',
  '【程序失败回执，非研究报告】该席未完成有效报告，不能当作核验已经完成。',
  '该席没有通过本轮实质证据与模型概率检查；原报告已封存，此处不将访问失败、免责声明或程序回执作为预测依据。',
])
const memoryPattern = /^历史记忆：近\d+天\d+次实质研判、\d+份报告；近\d+天\d+条来源关系。旧概率和资料只作历史比较与检索线索，本轮引用必须重新读取；检索窗口不删除封存档案。$/u
const closeoutPatterns = [
  /^执行器预算收尾回执：本研究员已取得\d+项资料，但未在本次额度内完成有效判断。以下资料供主Agent整理，不代表完整研究报告或已验证概率。$/u,
  /^程序生成的预算回执：已读取\d+份原文，但研究员未完成内容核验；以下引用不表示认可原文主张。$/u,
  /^有界报告汇集：\d+个不同职责的研究员已提交带证据的概率估计，按候选概率中位数汇集为Yes \d+%。主Agent未完成有效最终裁决，程序仅整理已核验报告；该估计未校准，来源可能重叠。$/u,
]
const partialPrefix = /^(本轮已结束，保留\d+个不同职责的有效报告。)([\s\S]*)$/u

// Only canonical program text is UI. Model, user and source prose keep a data boundary.
export function courseSystemTextParts(value, kind) {
  const text = typeof value === 'string' ? value : ''
  const system = kind === 'triage' ? triageText.has(text)
    : kind === 'memory' ? memoryPattern.test(text)
      : kind === 'closeout' && (closeoutText.has(text) || closeoutPatterns.some(pattern => pattern.test(text)))
  if (system) return [{ text, system: true }]
  if (kind === 'closeout') {
    const match = text.match(partialPrefix)
    if (match) return [{ text: match[1], system: true }, ...(match[2] ? [{ text: match[2], system: false }] : [])]
  }
  return [{ text, system: false }]
}

export function courseSystemContent(tag, cls, value, kind) {
  const parts = courseSystemTextParts(value, kind)
  const partNode = (part, tagName = 'span', className = '') => (part.system ? uiContent : dataContent)(tagName, className, part.text)
  return parts.length === 1 ? partNode(parts[0], tag, cls) : uiContent(tag, cls, ...parts.map(part => partNode(part)))
}
