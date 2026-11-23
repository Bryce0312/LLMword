/** Output language belongs to a saved request, never to process-global or browser state. */
export const OUTPUT_LANGUAGES = Object.freeze(['zh-CN', 'en'])
const START = '[SAVED_REQUEST_OUTPUT_LANGUAGE]'
const END = '[/SAVED_REQUEST_OUTPUT_LANGUAGE]'
const existingPolicy = /\n*\[SAVED_REQUEST_OUTPUT_LANGUAGE\][\s\S]*?\[\/SAVED_REQUEST_OUTPUT_LANGUAGE\]/gu
const policies = Object.freeze({
  en: 'Output language: en (English). For this saved request, write all newly authored public narrative in English, including question explanations and assumptions, assignment objectives and selection reasons, worker summaries, support and counterevidence claims, missing-evidence descriptions, source limitations, dissent, decisionNotes reasons, and final forecast/report prose. This applies to every main-agent and worker call, corrections, follow-ups, resumed summaries and watch updates, and overrides default Chinese writing directions. Keep the original user question, fixed strict-contract fields, verbatim quotations, citations and evidence originals unchanged. Preserve URLs, identifiers, schema field names and enum values exactly. Proper names may remain in their original script. Search queries may use any language appropriate to the sources. Summarize source content in English while retaining verbatim quoted evidence in its original language. Do not rewrite saved historical reports or evidence. Use the existing budgeted call; do not request an additional translation call. Keep English concise when other instructions specify Chinese character targets.',
  'zh-CN': 'Output language: zh-CN (简体中文). 本任务所有新写的公开叙述使用简体中文，包括题意解释与假设、派工任务与入选理由、研究员摘要、支持与反证论述、资料缺口、来源限制、分歧、decisionNotes理由及最终预测或研报。适用于主Agent、所有研究员、修正、补查、恢复汇总和后续监听。原问题、固定strict契约字段、直接引文、引用和证据原文保持原样；URL、标识符、schema字段名与枚举值不得翻译。专名可保留原文，检索语言不限。不得改写历史报告或证据；在现有计费调用内完成，不另发翻译调用。',
})

/** Clone messages only: signals and other transport handles retain their original identity. */
export function withRequestOutputLanguage(input, outputLanguage) {
  if (outputLanguage === undefined) return input
  if (!OUTPUT_LANGUAGES.includes(outputLanguage)) throw Object.assign(new TypeError('输出语言须为en或zh-CN。'), { code: 'INVALID_OUTPUT_LANGUAGE', status: 400 })
  const messages = structuredClone(input.messages ?? [])
  const policy = START + '\n' + policies[outputLanguage] + '\n' + END
  const system = messages.find(message => message.role === 'system' && typeof message.content === 'string')
  if (system) system.content = system.content.replace(existingPolicy, '') + '\n\n' + policy
  else messages.unshift({ role: 'system', content: policy })
  return { ...input, messages }
}
