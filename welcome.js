import { h, link, button } from './workbench-core.js'
import { guidePathCards } from './guide.js'

const workflow = [
  ['01', '写下股票和期限', '比如“预测腾讯股票未来 5 个交易日”。系统按公开来源判断，不靠猜。'],
  ['02', '分头找资料', '主 Agent 按问题选研究员；每个人独立查，不互相抄结论。'],
  ['03', '把不同意见放在一起', '概率、证据够不够、研究员是否一致，分开记录，不凑成一个好看的数字。'],
  ['04', '保存这次判断', '来源、版本和失败记录都会留下。以后有新资料，只补查受影响的部分。'],
]

const lead = {
  tag: '主 Agent',
  name: '协调员',
  duty: '派工、比较、汇总',
  text: '按问题拆任务，决定谁去查；最后把几份报告合在一起。',
  not: '不替研究员补结论，也不把分歧抹平。',
}

const researchers = [
  {
    name: '官方资料研究员',
    duty: '公告与正式文件',
    text: '先找原始公告和正式文件；原文没拿到就说明，不拿转述顶替。',
    not: '不把二手转述当成原文。',
  },
  {
    name: '新闻时间线研究员',
    duty: '首发、更正、转载',
    text: '把首发、更正和转载分开，时间说不清就留成缺口。',
    not: '不把同一篇转载数成多份证据。',
  },
  {
    name: '行业与专业研究员',
    duty: '技术、行业、制度条件',
    text: '看技术、行业和制度条件，说明判断在什么范围内成立。',
    not: '不把经验之谈写成核实结论。',
  },
  {
    name: '人物与组织研究员',
    duty: '身份、履历、利益关系',
    text: '核对身份、履历和利益关系；同名对象与传闻要分开。',
    not: '不把传闻当成正式任命。',
  },
  {
    name: '统计与指标研究员',
    duty: '单位、样本、时段',
    text: '把单位、样本和时段对齐；对不上就标出来。',
    not: '不为了好看硬凑一个数字。',
  },
  {
    name: '预测市场研究员',
    duty: '价格、期限、结算条件',
    text: '先分清现价、盘口报价和事件概率，再看期限和结算条件。',
    not: '不把价格涨跌直接当成事件概率。',
  },
  {
    name: '社群与舆情研究员',
    duty: '传播路径、样本偏差',
    text: '看线索怎么传播、样本偏在哪里；传闻只当待核验线索。',
    not: '不按声量大小推断结果。',
  },
  {
    name: '历史类比研究员',
    duty: '相似条件、差异、反例',
    text: '找相似历史、关键差异和失败案例，并说明样本来源。',
    not: '不拿后来的结果回填当时判断。',
  },
  {
    name: '关系图研究员',
    duty: '实体、关系、影响假设',
    text: '把实体、关系和影响假设连起来，保留来源、时间和反例。',
    not: '不把未知关系当成零相关。',
  },
  {
    name: '反证与核验研究员',
    duty: '反面材料、来源独立性',
    text: '专门找反面材料，检查来源是否独立、时间是否对得上。',
    not: '不因为大家意见一致就认定事实正确。',
  },
]

function researcherCard(person, index) {
  const card = h('article', 'welcome-person',
    h('span', 'welcome-person-tag', `席位 ${String(index + 1).padStart(2, '0')}`),
    h('h3', '', person.name),
    h('p', 'welcome-person-duty', person.duty),
    h('p', 'welcome-person-text', person.text),
    h('p', 'welcome-person-not', person.not))
  card.dataset.index = String(index + 1).padStart(2, '0')
  return card
}

export function welcomeView() {
  const art = h('img', 'welcome-hero-image')
  art.src = 'assets/lab-play.png'
  art.alt = '像素风格的研究室'
  const tutorial = h('section', 'welcome-section welcome-tutorial',
    h('div', 'welcome-section-head',
      h('div', '',
        h('h2', '', '教程：从案例看懂研究室'),
        h('p', '', '三个回放：一次完整协作、一次新证据补查、一次失败后恢复。'))),
    h('div', 'guide-path-grid', ...guidePathCards()))
  tutorial.id = 'welcome-tutorial'
  const jump = button('先看教程', () => tutorial.scrollIntoView({ behavior: 'smooth', block: 'start' }), 'wb-button')
  return [
    h('section', 'welcome-hero',
      h('div', 'welcome-hero-copy',
        h('p', 'welcome-kicker', '股票预测事务所'),
        h('h1', '', '把一只股票，交给一支 AI 研究团队'),
        h('p', 'welcome-lede', '你写下股票和期限，主 Agent 分头找人查公开资料，再把支持、反对和没解决的问题一起写进报告。'),
        h('div', 'welcome-actions',
          link('进入研究室', '#/predictions', 'wb-button wb-primary'), jump)),
      h('div', 'welcome-hero-art', art)),
    h('section', 'welcome-section welcome-workflow',
      h('h2', '', '一次预测会经过这四步'),
      h('p', 'welcome-section-lede', '不用先学术语，按顺序看一遍就能明白。'),
      h('ol', 'welcome-step-grid', ...workflow.map(([number, title, text]) => h('li', 'welcome-step',
        h('span', 'welcome-step-number', number),
        h('h3', '', title),
        h('p', '', text))))),
    tutorial,
    h('section', 'welcome-section welcome-team wb-paper',
      h('h2', '', '研究室里都有谁'),
      h('p', 'welcome-section-lede', '主 Agent 负责派工和汇总；下面十个研究员席位，每轮只按问题选其中几位。'),
      h('article', 'welcome-lead',
        h('span', 'welcome-person-tag', lead.tag),
        h('div', '',
          h('h3', '', lead.name),
          h('p', 'welcome-person-duty', lead.duty),
          h('p', 'welcome-person-text', lead.text),
          h('p', 'welcome-person-not', lead.not))),
      h('div', 'welcome-team-grid', ...researchers.map(researcherCard))),
  ]
}
