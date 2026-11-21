export const FINANCE_METHODS = {
  official: '财报官方核验：优先公司IR、SEC正式披露及公司官方中文站。先核对最近一期、财年/自然年、公布日、期末日及实际发言人。只把正式已读原文标为官方事实；中文翻译与英文稿属于同一来源链。明确哪些是实际业绩、管理层指引与前瞻声明。',
  timeline: '新闻痕迹：先用search_news分别提交中文和英文关键词，覆盖中外公开站点，再选择正文读取。区分事件发生、文章发布、更新与抓取时间；追到首发/公司原稿，转载和翻译不重复算独立确认。引用发言保留说话人、场合和财报季度。过期文章只能作背景，搜索摘要不是正文。',
  statistics: '财报统计：逐项标记金额单位(百万/十亿/亿)、USD或CNY、财年季度、GAAP/non-GAAP。优先读财报表；fetch_page可用focus定位表格。用compare_financial_metrics计算货币指标增长率，period写Q3 FY2027等格式，引用片段同时保留金额、币种及单位表头；工具不计算毛利率百分点。区分同比、环比、指引与已实现值，找不到可比数据就留缺口，不在脑中虚构计算器结果。',
  industry: '行业影响：把已确认的业务变化、管理层预期、传导机制和未验证假设分开；结合需求、产品切换、供给、毛利及政策。黄仁勋表述与季度业绩的相关性不等于已证实因果。若解释股价，需对应交易时段、市场基准和其他同时事件；缺少时只列可能机制及反证。',
  people: '管理层表述：核对发言时的职位、实际说话人、发言日期和场合；不同季度引语不可互换。优先核对公司公告及原始采访，媒体推测和管理层实际表述分开，不能把旧身份自动延续到新财报。',
  verification: '财报反证：核对不同语言是否同一公司稿、发言归属、季度/币种/GAAP差异、事实与指引。可用search_news双语检索，遇到矛盾读原始出处。公开报告指出哪些结论成立、哪些只是合理机制，不能将价格共振或领导人名气当因果证明。',
}
export const isFinanceResearch = (question = '') => /财报|营收|业绩|上市公司|英伟达|黄仁勋|earnings|revenue|NVIDIA|NVDA|GAAP|guidance/i.test(question)
export function researchProfile(roleId, question) {
  return isFinanceResearch(question) && FINANCE_METHODS[roleId] ? { version: 'finance-methods-v1', roleId, instructions: FINANCE_METHODS[roleId] } : null
}
