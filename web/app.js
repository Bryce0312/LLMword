import { createRoomScene } from './actors.js';
import { initLocaleUI } from './locale.mjs';
import { dateContent } from './workbench-core.js';
import { isLegacyBuiltinText } from './locale-zh-en-legacy.mjs';

initLocaleUI({ englishOnly: true });

const byId = (id) => document.getElementById(id);

function node(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined));
  return element;
}

function originalNode(tag, className, ...children) {
  const element = node(tag, className, ...children);
  element.setAttribute('data-i18n-skip', 'true');
  return element;
}
function metadataNode(kind, record, field = 'name', tag = 'span', className = '') {
  return (isLegacyBuiltinText(kind, record, field) ? node : originalNode)(tag, className, record?.[field]);
}

function list(className, values, item) {
  return node('ul', className, ...values.map(item));
}

function replace(element, ...children) {
  element.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined));
}

const branchLabels = { base: '历史主线', narrow: '限制范围较窄', broad: '限制范围较广' };
const roles = {
  policy: '政策范围与执行',
  supply: '产品与供应链',
  company: '公司敞口与影响',
  market: '市场预期',
  chair: '协调与查证',
};
const statusLabels = { confirmed: '已确认', watch: '待观察', unknown: '缺少证据' };
const directions = { up: '偏正向', down: '偏负向', neutral: '中性' };
const variableLabels = { amdLicenseExposure: 'AMD 许可敞口', substitutionCapacity: '替代供给空间' };
const stateLabels = { confirmed: '已确认', assumed: '假设受限', unresolved: '待核实', unknown: '未知', constrained: '空间收窄', conditional: '可能替代' };
const basisLabels = { observed: '已观察', assumption: '分支假设', unresolved: '待补证据', scenario: '情景推演' };
const traceLabels = { tool: '工具调用', harness: '引擎', proposal: '独立判断', challenge: '会议质疑', decision: '会议结论', agent: '角色判断', tool_call: '工具调用', tool_result: '工具返回' };
const stageLabels = { start: '准备', analysis: '独立判断', challenge: '会议质疑', decision: '会议结论', observation: '揭示事件', settle: '结算预测', review: '复核' };
const controls = { run: byId('run'), advance: byId('advance'), reset: byId('reset'), branch: byId('branch') };
let snapshot = null;
let busy = '';
let activePanel = 'world';
let speeches = [];
let speechIndex = 0;
let monitorState = null;
let monitorRefresh = 0;
let replayRefreshPending = false;
let autoHeadline = '';
let streamStatus = '连接中';
for (const id of ['case-title', 'live-speaker', 'live-message', 'speech-speaker', 'speech-message', 'branch-note']) byId(id).setAttribute('data-i18n-skip', 'true');
const notebook = byId('notebook');
const notebookScroll = notebook.querySelector('.notebook-scroll');
const roomScene = createRoomScene({
  layer: byId('room-floor'),
  speaker: byId('live-speech'),
  speakerName: byId('live-speaker'),
  speakerText: byId('live-message'),
  speakerKind: byId('live-speech-kind'),
  status: byId('room-phase'),
  onAgent: (id) => {
    const agent = snapshot?.agents.find((candidate) => candidate.id === id);
    if (agent && !byId('agent-dialog').open) openAgent(agent);
  },
  onActivity: (active) => {
    if (active) byId('speech').hidden = true;
    refreshControls();
  },
  onAnnouncement: (headline) => {
    autoHeadline = headline;
    updateMonitorNotice();
  },
});

function formatDate(raw, withTime = false) {
  if (!raw) return originalNode('span', '', '—');
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T12:00:00.000Z' : raw;
  const element = dateContent(value, 'America/New_York');
  if (!withTime) element.setAttribute('data-i18n-date-format', 'date');
  return element;
}

const pct = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';
const decimal = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const signedPoints = (value) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} 个百分点` : '—';
const empty = (content) => node('p', 'empty', content);

function heading(title, subtext) {
  return node('div', 'panel-heading', node('h3', '', title), subtext ? node('span', '', subtext) : null);
}

function sourceLink(item, title = '打开原文') {
  if (!item?.url) return null;
  let url;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const link = node('a', 'source-link', title);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (arguments.length > 1) link.setAttribute('data-i18n-skip', 'true');
  return link;
}

function sourceRefs(ids = []) {
  const refs = (ids ?? []).map((id) => snapshot.evidence.find((item) => item.id === id))
    .filter(Boolean)
    .map((item) => sourceLink(item, item.source ?? item.id) ?? originalNode('span', '', item.id));
  return refs.length ? node('div', 'evidence-meta', ...refs) : null;
}

function portrait(id) {
  const icon = node('span', 'portrait', node('span', 'figure', node('i')));
  if (Object.hasOwn(roles, id)) icon.classList.add(id);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function openAgent(agent) {
  const details = byId('agent-details');
  const skill = agent.skill;
  const skillText = typeof skill === 'string' ? skill : skill?.description || skill?.instructions || skill?.name;
  const tools = (agent.tools ?? []).map((id) => snapshot.tools.find((tool) => tool.id === id) ?? { id, name: id });
  const title = metadataNode('agent', agent, 'name', 'h2');
  title.id = 'agent-dialog-title';
  replace(details,
    node('div', 'dialog-heading', portrait(agent.id), node('div', '', title, metadataNode('agent', agent, 'role', 'p'))),
    node('section', 'dialog-block', node('h3', '', '研究技能'), typeof skill === 'string' && isLegacyBuiltinText('agent', agent, 'skill') ? metadataNode('agent', agent, 'skill', 'p') : skillText ? originalNode('p', '', Array.isArray(skillText) ? skillText.join('。') : skillText) : node('p', '', '该角色通过专属工具提供证据。')),
    agent.skillText ? node('details', 'dialog-block', node('summary', '', '查看技能指令'), originalNode('p', 'skill-text', agent.skillText)) : null,
    node('section', 'dialog-block', node('h3', '', '可用工具'), tools.length ? list('', tools, (tool) => metadataNode('tool', tool, 'name', 'li')) : node('p', '', '暂无已注册工具。')),
  );
  byId('agent-dialog').showModal();
}

function renderAgents() {
  byId('agents').replaceChildren(...snapshot.agents.map((agent) => {
    const role = roles[agent.id] ?? agent.role;
    const card = node('button', 'agent-card', portrait(agent.id), node('span', '', metadataNode('agent', agent, 'name', 'strong'), Object.hasOwn(roles, agent.id) ? node('small', '', role) : originalNode('small', '', role)));
    card.type = 'button';
    card.setAttribute('aria-haspopup', 'dialog');
    card.title = role;
    if (!Object.hasOwn(roles, agent.id)) card.setAttribute('data-i18n-skip-attributes', 'title');
    card.addEventListener('click', () => openAgent(agent));
    return card;
  }));
}

function renderStages() {
  const stages = snapshot.stages;
  const step = snapshot.step;
  byId('step-count').textContent = `${step + 1} / ${snapshot.totalSteps ?? stages.length}`;
  byId('stages').replaceChildren(...stages.map((stage, index) => {
    const future = index > step;
    const current = index === step;
    const dot = node('i', 'stage-dot');
    dot.setAttribute('aria-hidden', 'true');
    const content = node('div', '',
      (future ? node : originalNode)('div', 'stage-title', future ? `第 ${index + 1} 条事件 · 待揭示` : stage.title),
      future ? null : node('p', 'stage-meta', formatDate(stage.date, true)),
      current && stage.description ? originalNode('p', 'stage-desc', stage.description) : null,
    );
    const entry = node('li', `stage ${current ? 'current' : future ? 'future' : 'done'}`, dot, content);
    if (current) entry.setAttribute('aria-current', 'step');
    return entry;
  }));
}

function renderRelations(factors, companies) {
  const policy = factors.find((factor) => factor.id === 'policy' || /政策|许可/.test(factor.label));
  if (!policy || companies.length === 0) return null;
  const section = node('section', 'relations-section',
    heading('关系图', '共享因素与各公司的敞口'),
    node('div', 'relation-map',
      node('div', 'relation-root', originalNode('strong', '', policy.label), originalNode('p', '', policy.value), sourceRefs(policy.sourceIds)),
      node('div', 'relation-connector'),
      node('div', 'relation-children', ...companies.map((company) => {
        const signal = directions[company.signal] ?? company.signal;
        return node('div', 'relation-company',
          originalNode('strong', '', company.ticker),
          node('div', '', originalNode('p', '', company.exposure), signal ? (Object.hasOwn(directions, company.signal) ? node : originalNode)('span', '', signal) : null, sourceRefs(company.sourceIds)),
        );
      })),
    ),
  );
  section.id = 'relations';
  return section;
}

function renderWorld() {
  const { factors, companies, evidence, outcome, question } = snapshot;
  const factorItems = list('factor-list', factors, (factor) =>
    node('li', 'factor-item',
      node('div', '', originalNode('strong', '', factor.label), originalNode('p', '', factor.value), sourceRefs(factor.sourceIds)),
      node('span', `badge ${Object.hasOwn(statusLabels, factor.status) ? factor.status : 'unknown'}`, statusLabels[factor.status] ?? '观察中'),
    ),
  );
  const companyItems = list('company-list', companies, (company) =>
    node('li', 'company-item',
      node('div', '', originalNode('strong', '', node('span', '', company.ticker), company.name), originalNode('p', '', company.exposure)),
      company.signal ? (Object.hasOwn(directions, company.signal) ? node : originalNode)('span', `badge company-signal ${Object.hasOwn(directions, company.signal) ? company.signal : 'neutral'}`, directions[company.signal] ?? company.signal) : null,
    ),
  );
  const evidenceItems = list('evidence-list', evidence, (item) =>
    node('li', 'evidence-item',
      originalNode('h4', '', item.title),
      originalNode('p', '', item.summary),
      node('div', 'evidence-meta', originalNode('span', '', item.source), formatDate(item.publishedAt, true), sourceLink(item)),
    ),
  );
  replace(byId('panel-world'),
    question ? node('div', 'research-question', node('strong', '', '待预测'), originalNode('p', '', question)) : null,
    outcome ? node('div', 'outcome-note', node('strong', '', '已揭示结果'), originalNode('p', '', outcome.label), sourceRefs(outcome.sourceIds)) : null,
    node('div', 'world-summary',
      node('section', '', heading('共享因素', `${factors.length} 项`), factorItems),
      node('section', '', heading('公司与敞口', `${companies.length} 家`), companyItems),
    ),
    renderRelations(factors, companies),
    node('section', 'evidence-section', heading('已公开证据', `${evidence.length} 条`), evidenceItems),
  );
}

function renderForecast(forecast) {
  const probability = forecast.probability;
  const tracks = Number.isFinite(probability)
    ? node('div', 'forecast-top', node('strong', 'forecast-value', pct(probability)),
      node('div', '', originalNode('strong', '', forecast.target),
        node('p', '', node('small', '', node('span', '', '会前 ' + pct(forecast.prior)), ' · ', forecast.branchLabel ? originalNode('span', '', forecast.branchLabel) : node('span', '', branchLabels[forecast.branch] ?? '推演情景')))))
    : heading('情景判断', branchLabels[forecast.branch] ?? '推演情景');
  const market = [forecast.marketTarget ? originalNode('span', '', forecast.marketTarget) : node('span', '', Number.isFinite(forecast.marketProbability) ? '股价预测' : '股价预测 · 暂无可评分数据'), Number.isFinite(forecast.marketProbability) ? ' · ' + pct(forecast.marketProbability) : null];
  const lock = Number.isFinite(forecast.lockedProbability) ? `已封存预测 ${pct(forecast.lockedProbability)}，揭示结果后按此结算。` : forecast.branch !== 'base' ? '假设分支用于对比情景。' : null;
  const paths = (forecast.paths ?? []).length ? list('paths', forecast.paths, (path) =>
    node('li', '', node('div', '', originalNode('strong', '', path.label), originalNode('p', '', path.detail)),
      node('span', `badge ${Object.hasOwn(directions, path.direction) ? path.direction : 'neutral'}`, directions[path.direction] ?? '待核验')),
  ) : null;
  const transitions = (forecast.transitions ?? []).length ? node('section', 'transitions',
    node('h3', '', '状态推演'),
    node('ol', '', ...forecast.transitions.map((transition) => node('li', '',
      Object.hasOwn(variableLabels, transition.variable) ? node('strong', '', variableLabels[transition.variable]) : originalNode('strong', '', transition.variable),
      node('p', '', Object.hasOwn(stateLabels, transition.from) ? node('span', '', stateLabels[transition.from]) : originalNode('span', '', transition.from), ' → ', Object.hasOwn(stateLabels, transition.to) ? node('span', '', stateLabels[transition.to]) : originalNode('span', '', transition.to)),
      node('span', 'badge', basisLabels[transition.basis] ?? '推演'),
    ))),
  ) : null;
  return node('section', 'forecast', tracks, originalNode('p', '', forecast.summary),
    lock ? node('p', 'lock-note', lock) : null,
    node('p', 'market-note', market), paths, transitions, sourceRefs(forecast.sourceIds));
}

function renderMeeting() {
  const { trace, forecast } = snapshot;
  const entries = trace.length ? list('trace-list', trace, (event) => {
    const agent = snapshot.agents.find((candidate) => candidate.id === event.agentId);
    const tool = snapshot.tools.find((candidate) => candidate.id === event.tool);
    const label = stageLabels[event.stage] ?? traceLabels[event.kind] ?? '运行记录';
    const details = node('details', 'trace-item',
      node('summary', '', agent ? metadataNode('agent', agent, 'name', 'strong') : node('strong', '', '运行引擎'),
        node('span', 'trace-type', label),
        tool ? metadataNode('tool', tool, 'name', 'span', 'trace-type') : null),
      originalNode('p', 'trace-message', event.message),
      sourceRefs(event.sourceIds),
    );
    if (['challenge', 'decision'].includes(event.stage)) details.open = true;
    return node('li', '', details);
  }) : empty('召集一次 Agent 会议后，就能查看各研究员的判断、工具调用和证据。');
  replace(byId('panel-meeting'), forecast ? renderForecast(forecast) : null, heading('会议与工具记录', trace.length ? `${trace.length} 条` : ''), entries);
}

function renderLearning() {
  const { learning } = snapshot;
  const metric = (label, value) => node('div', 'metric', node('strong', '', value), label);
  const history = learning.history ?? [];
  byId('panel-learning').replaceChildren(
    node('div', 'learning-metrics',
      metric('已结算预测', String(learning.resolved ?? 0)),
      metric('平均 Brier 分数', decimal(learning.brier)),
      metric('当前概率校正', signedPoints(learning.adjustment)),
    ),
    node('p', 'learning-note', learning.description ? originalNode('span', '', learning.description) : node('span', '', '历史主线在结果揭示后更新之后的概率校准。'), node('span', '', ' Brier 分数越低，概率误差越小。')),
    history.length ? list('learning-history', history, (entry) =>
      node('li', '', node('div', '', originalNode('strong', '', entry.target),
        node('p', '', `预测 ${pct(entry.probability)} · 结果 ${entry.outcome ? '发生' : '未发生'}`)),
      node('span', 'badge', `Brier ${decimal(entry.brier)}`))) : empty('先在历史主线召集会议，再揭示后续事件，结果会进入学习档案。'),
  );
}

function renderTools() {
  byId('panel-tools').replaceChildren(
    heading('已注册工具', `${snapshot.tools.length} 项`),
    list('tool-list', snapshot.tools, (tool) => node('li', 'tool-item',
      metadataNode('tool', tool, 'name', 'h4'),
      metadataNode('tool', tool, 'description', 'p'),
      node('code', '', tool.id),
    )),
  );
}

function render() {
  byId('mode-label').textContent = snapshot.mode === 'live' ? '真实模型' : '模拟模型';
  byId('mode-label').parentElement.classList.remove('offline');
  byId('case-title').textContent = snapshot.case.title;
  byId('world-clock').replaceChildren(formatDate(snapshot.cutoff, true));
  byId('company-count').textContent = snapshot.companies.length;
  byId('agent-count').textContent = snapshot.agents.length;
  if (snapshot.branches?.length) {
    const selected = controls.branch.value;
    controls.branch.replaceChildren(...snapshot.branches.map((branch) => {
      const canonical = branch.label === branchLabels[branch.id];
      const option = (canonical ? node : originalNode)('option', '', branch.label);
      if (canonical) option.setAttribute('data-i18n-ui', 'true');
      option.value = branch.id;
      return option;
    }));
    controls.branch.value = snapshot.branches.some((branch) => branch.id === selected) ? selected : 'base';
  }
  renderBranchNote();
  renderStages();
  renderAgents();
  roomScene.setAgents(snapshot.agents);
  renderWorld();
  renderMeeting();
  renderLearning();
  renderTools();
}

const monitorModeLabels = { public: '公开信息监测', demo: '模拟监测', off: '监测关闭' };
const monitorDecisionLabels = { meeting: '召集会议', ignore: '略过', baseline: '更新基线' };
const sourceNames = { sec_edgar: 'SEC EDGAR', polymarket: 'Polymarket Gamma', demo: '模拟信号' };
const sourceStatuses = {
  live: { label: '已读到数据', style: 'confirmed' },
  no_match: { label: '无匹配', style: 'watch' },
  unavailable: { label: '暂不可用', style: 'down' },
};
const liquidityFormat = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function monitorSource(source) {
  const status = sourceStatuses[source.status];
  return node('li', 'evidence-item',
    node('div', 'monitor-source-head',
      Object.hasOwn(sourceNames, source.id) ? node('strong', '', sourceNames[source.id]) : originalNode('strong', '', source.name ?? source.id),
      status ? node('span', `badge ${status.style}`, status.label) : null,
    ),
    source.message ? originalNode('p', '', source.message) : node('p', '', '等待第一次检查。'),
    node('div', 'evidence-meta', ...(source.lastSuccessAt ? ['最近成功 ', formatDate(source.lastSuccessAt, true)] : ['尚无成功记录'])),
  );
}

function monitorItem(item) {
  const market = item.market;
  const pricing = market ? [
    Number.isFinite(market.yesPrice) ? `Yes ${pct(market.yesPrice)}` : null,
    Number.isFinite(market.bid) && Number.isFinite(market.ask) ? `价差 ${((market.ask - market.bid) * 100).toFixed(1)} 个百分点` : null,
    Number.isFinite(market.liquidity) ? `流动性 ${liquidityFormat.format(market.liquidity)}` : null,
  ].filter(Boolean) : [];
  return node('li', 'evidence-item',
    originalNode('h4', '', item.title),
    originalNode('p', '', item.summary),
    pricing.length ? node('div', 'monitor-pricing', ...pricing.map((value) => node('span', 'badge', value))) : null,
    market ? node('p', 'monitor-quote', ...(market.quoteTimestamp ? ['Gamma 报价 ', formatDate(market.quoteTimestamp, true)] : ['Gamma 报价时间未提供'])) : null,
    node('div', 'evidence-meta',
      Object.hasOwn(sourceNames, item.sourceId) ? node('span', '', sourceNames[item.sourceId]) : originalNode('span', '', item.sourceId),
      originalNode('span', '', item.symbols?.join(' / ')),
      item.publishedAt ? node('span', '', '发布 ', formatDate(item.publishedAt, true)) : '发布时间未提供',
      item.observedAt ? node('span', '', '观测 ', formatDate(item.observedAt, true)) : null,
      sourceLink(item)),
  );
}

function updateMonitorNotice() {
  const announcement = byId('monitor-announcement');
  const title = autoHeadline || monitorState?.latestMeeting?.headline;
  announcement.hidden = !title;
  announcement.replaceChildren(...(title ? [node('span', '', '最新监测会议 · '), originalNode('span', '', title)] : []));
  const button = byId('open-monitor');
  button.dataset.alert = String(Boolean(title));
  if (monitorState?.mode) button.title = monitorModeLabels[monitorState.mode] ?? '';
}

function renderMonitor() {
  const pane = byId('monitor-pane');
  if (!monitorState) {
    pane.replaceChildren(empty('正在读取监测档案。'));
    return;
  }
  const { mode, latestItems = [], decisions = [], latestMeeting, nextCheckAt, lastCheckAt, sources = [], error } = monitorState;
  const timing = [lastCheckAt ? node('span', '', '上次 ', formatDate(lastCheckAt, true)) : null, nextCheckAt ? node('span', '', '下次 ', formatDate(nextCheckAt, true)) : null].filter(Boolean);
  const meetingEvidence = latestMeeting?.evidence ?? [];
  const meeting = latestMeeting ? node('section', 'forecast',
    heading(latestMeeting.headline ? originalNode('span', '', latestMeeting.headline) : '最近一次自动会议', formatDate(latestMeeting.completedAt || latestMeeting.startedAt, true)),
    latestMeeting.summary ? originalNode('p', '', latestMeeting.summary) : null,
    list('trace-list monitor-meeting-list', latestMeeting.findings ?? [], (finding) =>
      node('li', 'trace-item',
        originalNode('strong', '', snapshot?.agents.find((agent) => agent.id === finding.agentId)?.name ?? roles[finding.agentId] ?? '研究员'),
        originalNode('p', '', finding.message),
        node('div', 'evidence-meta', ...(finding.sourceIds ?? []).map((id) => {
          const item = meetingEvidence.find((entry) => entry.id === id);
          return item ? sourceLink(item, item.title) : null;
        })),
      ),
    ),
  ) : empty('收到符合条件的新信息后，自动会议会出现在这里。');
  const items = latestItems.length ? list('evidence-list', latestItems, monitorItem) : empty('暂无监测资料。');
  const activity = decisions.length ? list('trace-list', decisions, (decision) =>
    node('li', 'trace-item',
      node('strong', '', monitorDecisionLabels[decision.action] ?? '记录'),
      originalNode('span', 'trace-type', decision.title),
      originalNode('p', '', decision.reason),
      node('div', 'evidence-meta', formatDate(decision.at, true)),
    ),
  ) : empty('暂无调度记录。');
  replace(pane,
    heading(monitorModeLabels[mode] ?? '监测状态', timing.flatMap((item, index) => index ? [' · ', item] : [item])),
    node('p', 'monitor-stream-state', '消息通道 · ', node('span', '', streamStatus)),
    sources.length ? list('evidence-list monitor-sources', sources, monitorSource) : null,
    error ? originalNode('p', 'empty', String(error)) : null,
    meeting, heading('最近资料', `${latestItems.length} 条`), items, heading('调度记录', `${decisions.length} 条`), activity,
  );
  updateMonitorNotice();
}

function setMonitor(state) {
  monitorRefresh += 1;
  monitorState = state;
  if (state.latestMeeting) autoHeadline = state.latestMeeting.headline || '';
  renderMonitor();
}

async function refreshMonitor() {
  const revision = ++monitorRefresh;
  try {
    const response = await fetch('/api/monitor');
    if (!response.ok) throw new Error(String(response.status));
    const state = await response.json();
    if (revision === monitorRefresh) setMonitor(state);
  } catch {
    if (!monitorState && revision === monitorRefresh) {
      byId('monitor-pane').replaceChildren(empty('暂时无法读取监测档案。关闭后重新打开即可重试。'));
    }
  }
}

function processEvent(event) {
  if (event.type === 'sync') {
    if (event.reset) {
      roomScene.resetStream();
    } else {
      for (const run of event.active ?? []) roomScene.push({ ...run, type: 'run-start' });
    }
    if (event.monitor) setMonitor(event.monitor);
    return;
  }
  if (event.type === 'monitor' && event.monitor) {
    setMonitor(event.monitor);
    return;
  }
  roomScene.push(event);
  if (event.type !== 'run-complete' && event.type !== 'run-error') return;
  if (event.scope === 'monitor') {
    void refreshMonitor();
  } else if (event.scope === 'replay' && busy !== 'run') {
    if (busy) replayRefreshPending = true;
    else void request('connect');
  }
}

function connectEvents() {
  if (typeof EventSource === 'undefined') {
    streamStatus = '当前浏览器不支持';
    void refreshMonitor();
    return;
  }
  const stream = new EventSource('/api/events');
  stream.onmessage = ({ data }) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    processEvent(event);
  };
  stream.onopen = () => {
    streamStatus = '已连接';
    void refreshMonitor();
  };
  stream.onerror = () => {
    streamStatus = '正在重新连接';
    if (byId('monitor').open && monitorState) renderMonitor();
  };
}

function renderBranchNote() {
  const branch = snapshot?.branches?.find((item) => item.id === controls.branch.value);
  const note = byId('branch-note');
  note.hidden = controls.branch.value === 'base' || !branch?.assumption;
  note.textContent = note.hidden ? '' : branch.assumption;
}

function setPanel(panel) {
  activePanel = panel;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const current = tab.dataset.panel === activePanel;
    tab.setAttribute('aria-selected', String(current));
    tab.tabIndex = current ? 0 : -1;
    byId(`panel-${tab.dataset.panel}`).hidden = !current;
  }
  notebookScroll.scrollTop = 0;
}

function openNotebook(panel, section) {
  setPanel(panel);
  if (!notebook.open) notebook.showModal();
  byId(`tab-${panel}`).focus({ preventScroll: true });
  const target = { evidence: '.evidence-section', relations: '#relations' }[section];
  if (target) {
    const element = notebook.querySelector(target);
    if (element) notebookScroll.scrollTop += element.getBoundingClientRect().top - notebookScroll.getBoundingClientRect().top;
  }
}

function syncSpeech() {
  speeches = snapshot.trace.filter((entry) => entry.agentId && entry.kind === 'message');
  speechIndex = 0;
  byId('speech').hidden = true;
  roomScene.endReplay(byId('speech'));
  byId('replay-speech').hidden = !speeches.length;
}

function showSpeech(index) {
  const entry = speeches[index];
  if (!entry) return;
  speechIndex = index;
  const agent = snapshot.agents.find((candidate) => candidate.id === entry.agentId);
  const speech = byId('speech');
  speech.dataset.agent = entry.agentId;
  byId('speech-speaker').textContent = agent?.name ?? '研究员';
  const message = byId('speech-message');
  message.textContent = entry.message;
  message.scrollTop = 0;
  byId('speech-position').textContent = `${index + 1} / ${speeches.length}`;
  byId('prev-speech').disabled = index === 0;
  byId('next-speech').disabled = index === speeches.length - 1;
  speech.hidden = false;
  roomScene.placeReplay(speech, entry);
}

function setBusy(action) {
  busy = action;
  refreshControls();
}

function refreshControls() {
  const working = busy === 'run' || roomScene.active();
  byId('room').classList.toggle('active', working);
  byId('room-status').lastElementChild.textContent = working ? '会议进行中' : snapshot ? (snapshot.forecast ? '会议已记录' : '准备就绪') : '等待连接';
  for (const card of byId('agents').children) card.classList.toggle('working', working);
  controls.run.disabled = !!busy || working || !snapshot;
  controls.advance.disabled = !!busy || working || !snapshot || snapshot.step >= snapshot.totalSteps - 1;
  controls.reset.disabled = !!busy || working || !snapshot;
  controls.branch.disabled = !!busy || working || !snapshot;
  byId('replay-speech').disabled = working;
  controls.run.lastChild.textContent = working ? ' 会议进行中…' : ' 召集 Agent 会议';
  controls.advance.firstChild.textContent = busy === 'advance' ? '揭示中… ' : snapshot && snapshot.step >= snapshot.totalSteps - 1 ? '已到最后事件 ' : '揭示下一事件 ';
  byId('room').setAttribute('aria-busy', String(working));
}

async function request(action, options) {
  if (busy) return;
  const startedAt = Date.now();
  byId('error').hidden = true;
  if (action === 'run') byId('speech').hidden = true;
  setBusy(action);
  try {
    const response = await fetch(action === 'connect' ? '/api/world' : `/api/${action}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    snapshot = data;
    if (action === 'reset') controls.branch.value = 'base';
    render();
    syncSpeech();
    if (action === 'run') {
      if (!roomScene.recentManual(startedAt)) {
        if (speeches.length) showSpeech(0);
        else openNotebook('meeting');
      }
      byId('notice').textContent = '会议已完成，可回放研究员发言。';
    }
    if (action === 'advance') {
      setPanel('world');
      byId('notice').textContent = '新事件已揭示，世界状态已更新。';
    }
    if (action === 'reset') {
      setPanel('world');
      byId('notice').textContent = '已回到第一个事件。';
    }
  } catch (error) {
    if (!snapshot) {
      byId('mode-label').textContent = '服务离线';
      byId('mode-label').parentElement.classList.add('offline');
    }
    byId('error-message').replaceChildren(node('span', '', action === 'connect' ? '研究室连接失败。' : '操作未完成。'), originalNode('span', '', error.message));
    byId('error').hidden = false;
  } finally {
    setBusy('');
    if (replayRefreshPending) {
      replayRefreshPending = false;
      void request('connect');
    }
  }
}

const post = (body = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

controls.run.addEventListener('click', () => request('run', post({ branch: controls.branch.value })));
controls.branch.addEventListener('change', renderBranchNote);
controls.advance.addEventListener('click', () => request('advance', post()));
controls.reset.addEventListener('click', () => request('reset', post()));
byId('retry').addEventListener('click', () => request('connect'));
byId('open-timeline').addEventListener('click', () => byId('timeline').showModal());
byId('open-monitor').addEventListener('click', () => {
  if (monitorState) renderMonitor();
  else byId('monitor-pane').replaceChildren(empty('正在读取监测档案。'));
  byId('monitor').showModal();
  void refreshMonitor();
});
byId('replay-speech').addEventListener('click', () => {
  showSpeech(0);
  byId('close-speech').focus();
});
byId('close-speech').addEventListener('click', () => {
  byId('speech').hidden = true;
  roomScene.endReplay(byId('speech'));
  byId('replay-speech').focus();
});
for (const [id, delta] of [['prev-speech', -1], ['next-speech', 1]]) {
  byId(id).addEventListener('click', () => {
    showSpeech(speechIndex + delta);
    if (byId(id).disabled) byId(delta === 1 ? 'prev-speech' : 'next-speech').focus();
  });
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => setPanel(tab.dataset.panel));
}

document.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  setPanel(tabs[next].dataset.panel);
  tabs[next].focus();
});

for (const button of document.querySelectorAll('[data-open-panel]')) {
  button.addEventListener('click', () => openNotebook(button.dataset.openPanel, button.dataset.section));
}

const roomImage = document.querySelector('.room-picture img');
function imageFallback() {
  roomImage.hidden = true;
  roomImage.closest('.room-picture').classList.add('no-image');
}
roomImage.addEventListener('error', imageFallback);
if (roomImage.complete && roomImage.naturalWidth === 0) imageFallback();

request('connect');
connectEvents();
