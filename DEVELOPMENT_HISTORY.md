# 开发历史 / Development History

本文从原 README 分离版本更新、提交对应关系和历史验收记录。当前项目介绍与使用方法见 [README](README.md)；最新完成度以 [实现状态](docs/IMPLEMENTATION_STATUS.md) 为准，产品契约以 [PRD](docs/PRD.md) 为准。

This document separates version updates, commit mapping, and historical acceptance records from the original README. See [README](README.md) for the current project introduction and usage. [Implementation Status](docs/IMPLEMENTATION_STATUS.md) records the latest completion state, and the [PRD](docs/PRD.md) remains the product contract.

提交号对应当前 Git 历史；发布说明中的“当前”“未上传”“待验收”等措辞只代表各自编写时点。测试数量属于各自阶段，不能跨版本相加；模拟回归、真实模型执行和预测准确率是三件不同的事。

Commit hashes refer to the current Git history. Words such as “current,” “not uploaded,” and “pending acceptance” in release notes describe only their original writing time. Test totals belong to individual stages and must not be added across versions. Simulated regression, live-model execution, and forecast accuracy are three distinct claims.

## 版本与提交索引 / Version and Commit Index

| 版本／阶段 / Version or Stage | 日期 / Date | 代表提交 / Representative Commits | 主要内容 / Main Changes |
| --- | --- | --- | --- |
| V4.4 | 2026-11-23 | `92ea1bb`、`cf84998` | 欢迎页与教程收口、十席介绍、历史菜单与操作窗口堆叠修复<br>Welcome-page and tutorial consolidation, ten-role profiles, and history-menu/operation-window stacking fix |
| V4.3 | 2026-11-23 | `080fa73`、`a95e517` | 历史删除、Key 表单恢复、完整 English、任务报告语言、操作窗口上移<br>History deletion, Key-form recovery, complete English UI, task report language, and upward-shifted operation windows |
| 4.2 整合 / 4.2 Integration | 2026-11-22 | `839d410` | 有界二元预测、有限资料报告、窗口守卫、可选持续预测<br>Bounded binary forecasts, limited-evidence reports, window guards, and optional continuous prediction |
| V4.0 | 2026-11-22 | `b2dc1ca`、`dcbfbc8` | 金融预测工作台、全屏像素房间、模型与预算设置、交易日窗口<br>Financial forecasting workstation, full-screen pixel room, model and budget settings, and trading-day horizons |
| V3.0 | 2026-11-21 | `d3c95a5`、`72b35ac` | 有据多 Agent 研究、财报研究、固定规则结果核验、逐条引用<br>Evidence-backed multi-agent research, financial-statement research, fixed-rule outcome verification, and itemized citations |
| V2.0 | 2026-11-19 至 / to 2026-11-20 | `597cdf1`、`4f2ac62`、`6dd4fe8`、`049814a`、`9add50b` | 课程纵向协作、监听记忆、公开总结一致性、mock/live 隔离<br>Course-scale collaboration, monitoring memory, public-summary consistency, and mock/live isolation |
| main 基线 / main Baseline | 2026-11-18 前后 / around 2026-11-18 | `7043e0a` | 2025 芯片许可案例、固定五席、回放、预测封存与旧版监测<br>2025 chip-licensing case, five fixed roles, replay, sealed forecasts, and legacy monitoring |

## V4.4：公开欢迎页与研究室入口收口 / V4.4: Public Welcome Page and Research-Room Entry Consolidation

| 提交 / Commit | 改动 / Changes | 验证与边界 / Verification and Boundaries |
| --- | --- | --- |
| `92ea1bb` | 根地址与空 hash 进入 `#/welcome`；新增产品 Hero、四步流程、三条教程和主 Agent／十席介绍；删除公开 `start:mock` 与 `start-mock.mjs`，`npm start` 收口到 live；教程章节改为“导读 → 术语 → 研究员速览 → 默认折叠归档”，完成页示例可编辑并预填真实表单。<br>The root address and empty hash open `#/welcome`. Added a product hero, four-step workflow, three tutorials, and main-Agent/ten-role profiles. Removed public `start:mock` and `start-mock.mjs`, consolidating `npm start` on live. Tutorial chapters now use “overview → terminology → researcher summary → collapsed archive”; editable completion examples can prefill the live form. | 实现状态记录全量 **659/659** 通过；隔离浏览器检查欢迎页、桌面五列两行、390px 单列和预填文本。教程不调用模型、不创建任务、不写数据库。<br>Implementation status records **659/659 passing tests**. An isolated browser checked the welcome page, five-column/two-row desktop layout, single-column 390px layout, and prefilled text. Tutorials do not call models, create tasks, or write to databases. |
| `cf84998` | 展开预测历史记录时自动关闭已打开的工作区操作窗口，回到当前研究室，解决历史菜单与操作窗口的堆叠；关闭历史菜单及再次打开操作窗口的原有逻辑保留。<br>Opening prediction history now closes any open workspace operation window and returns to the current research room, resolving history-menu/operation-window stacking. Existing behavior for closing history and reopening operation windows remains unchanged. | 浏览器实测与全量测试通过；只调整交互归属，不改变任务、预测或历史档案。<br>Browser checks and the full test suite passed. This changes interaction ownership only, not tasks, forecasts, or history archives. |

V4.4 的入口细节由 D055–D059 逐步确定：`#/guide` 目录页已取消并转向欢迎页，章节深链接保留；研究室顶部不再放欢迎页或教程，右下角保留“回到欢迎页”；每轮仍只按题选择部分研究员，不是十席全部运行。

V4.4 entry behavior was refined through D055–D059: the `#/guide` directory was removed and redirects to the welcome page, while chapter deep links remain. The research-room header no longer contains welcome or tutorial links; “Back to Welcome” remains at the lower right. Each round still selects only the roles needed for the question rather than running all ten.

## V4.3：历史、语言和操作窗口 / V4.3: History, Language, and Operation Windows

### 2026-11-23 开发更新 / Development Updates on 2026-11-23

| 提交 / Commit | 改动 / Changes | 验证 / Verification | 边界与状态 / Boundaries and Status |
| --- | --- | --- | --- |
| `080fa73` | 已有判断、资料不足和调查失败记录增加“删除记录”与同主题二次确认；删除状态跨刷新和重启保持。<br>Added “Delete Record” and same-topic confirmation to entries with an existing judgment, insufficient evidence, or investigation failure. Removal persists across refreshes and restarts. | [历史删除与连接回归 608/608](docs/evidence/v43-history-key-regression.json)，覆盖取消、重复提交、过期状态与旧响应。<br>[History deletion and connection regression: 608/608](docs/evidence/v43-history-key-regression.json), covering cancellation, duplicate submissions, stale states, and old responses. | 活动运行、监听和结果核验拒绝删除；原始请求、运行、判断、证据和角色快照保留，独立旧 domain 记录只读。<br>Active runs, monitoring, and outcome verification reject deletion. Original requests, runs, judgments, evidence, and role snapshots remain; separate legacy domain records are read-only. |
| `080fa73` | 修复无状态、无待执行时间的旧监听元数据被误判为活动任务的问题，旧失败记录可正常删除。<br>Fixed legacy monitoring metadata without state or pending execution time being mistaken for an active task, allowing old failed entries to be removed. | [旧历史兼容回归 36/36](docs/evidence/v43-legacy-history-delete-regression.json)。<br>[Legacy-history compatibility regression: 36/36](docs/evidence/v43-legacy-history-delete-regression.json). | 活动、未知状态及待调度记录仍受保护；验证未直接删除用户真实记录。<br>Active, unknown-state, and scheduled records remain protected. Verification did not directly delete real user records. |
| `080fa73` | 连接成功后在当前文档的密码框中脱敏保留 Key；临时读取连接状态失败不再误清已验证输入。<br>After a successful connection, the current document retains the Key as a masked password value. A temporary connection-state read failure no longer clears a verified input. | [连接表单与完整回归](docs/evidence/v43-english-regression.json)。<br>[Connection form and full regression](docs/evidence/v43-english-regression.json). | 不写浏览器持久／会话存储或项目文件；整页刷新不回填，服务重启后网页会话 Key 需重填。<br>No browser persistent/session storage or project-file writes. Full refreshes do not refill the field, and a server restart requires re-entering a web-session Key. |
| `080fa73` | 开始预测页统一为“写下一个你想预测的股票”“预测多久”“持续预测”，同步中英切换。<br>Standardized the prediction form as “Write down a stock you want to predict,” “Prediction Horizon,” and “Continuous Prediction,” with synchronized Chinese/English switching. | 纳入 V4.3 全量回归。<br>Included in the V4.3 full regression. | 不改变交易日期限、预算或持续预测默认关闭的行为。<br>No change to trading-day horizons, budgets, or the default-off continuous-prediction behavior. |
| `080fa73` | English 覆盖当前工作台、辅助页面和旧案例入口；新任务保存 `outputLanguage`，主 Agent、研究员、补查、恢复及持续预测沿用任务语言。<br>English now covers the current workstation, supporting pages, and legacy case entry. New tasks store `outputLanguage`, which is retained by the main Agent, researchers, follow-up checks, recovery, and continuous prediction. | [全量回归 645/645](docs/evidence/v43-english-regression.json)；[隔离浏览器巡检 37 个页面／状态](docs/evidence/v43-english-browser-audit.json)，覆盖 1440／900／390px。<br>[Full regression: 645/645](docs/evidence/v43-english-regression.json); [isolated-browser audit of 37 pages/states](docs/evidence/v43-english-browser-audit.json) at 1440/900/390px. | 原问题、历史报告、自定义名称、配置、证据和引文保持原文；不新增翻译调用，未以模拟测试证明真实模型语言服从率。<br>Original questions, historical reports, custom names, settings, evidence, and quotations remain unchanged. No translation calls were added, and simulated tests do not establish live-model language compliance. |
| `a95e517` | 上移操作窗口并压缩顶栏，让主要信息靠近首屏；共享房间样式同时作用于当时共用静态资源的环境。<br>Shifted operation windows upward and compacted the header so key information appears nearer the top. Shared room styles applied to environments using the same static resources. | 浏览器检查及既有回归通过。<br>Browser checks and existing regression tests passed. | 纯布局调整，不改变预测、权限或数据行为。<br>A layout-only change with no effect on prediction, permissions, or data behavior. |

教程最初作为常驻顶部入口和 `#/guide` 目录引入，后续由 V4.4 的 D055 收口到欢迎页。旧说明只用于理解演进，不能作为当前导航指南。

Tutorials were initially introduced as a persistent header entry and a `#/guide` directory. V4.4's D055 later consolidated them into the welcome page. Old descriptions explain the evolution and must not be used as current navigation instructions.

## 4.2：有界预测、窗口守卫与真实验收 / 4.2: Bounded Forecasts, Window Guards, and Live Acceptance

当前分支通过 `839d410` 整合 4.2 的调查、核验与预算策略，同时保留股票主题界面、黑板进度和历史结果入口。原 4.2 分支的完整交付说明见 [V4.2 发布说明](docs/V4_2_RELEASE_NOTES.md)。

The current branch integrates 4.2's investigation, verification, and budget policies through `839d410`, while retaining the stock-themed interface, blackboard progress, and historical-results entry. See the [V4.2 Release Notes](docs/V4_2_RELEASE_NOTES.md) for the original branch's complete delivery description.

### 核心改动 / Core Changes

- 主 Agent 收紧为拆题、派工与最终裁决，首轮调查交给不同职责的子 Agent；普通新任务包含核验席。

  The main Agent was narrowed to question decomposition, assignment, and final adjudication. Initial investigation belongs to sub-agents with distinct responsibilities, and typical new tasks include a verification role.
- 有本人同轮已读原文、实质引用和模型概率的有限报告，可被明确采用为初步条件估计；需复核、不计分。没有实质资料时不补造概率。

  A limited report with source text read by the same role in the same round, substantive citations, and a model probability may be explicitly adopted as a preliminary conditional estimate. It requires review and is not scored. No probability is invented when substantive evidence is absent.
- 新任务默认只运行一次，显式开启持续预测后才安排后续检查；后续轮次沿用同题、同版本、固定期限和历史预算。

  New tasks run once by default. Follow-up checks are scheduled only when continuous prediction is explicitly enabled. Later rounds retain the same question, versions, fixed horizon, and historical budget.
- 新预设任务保存 `sealed-forecast-window-v1`，派工和最终摘要校验已封存期限；修复把 1 交易日错误解释为 24 个月的问题。

  New preset tasks store `sealed-forecast-window-v1`; assignment and final-summary contracts validate the sealed horizon. This fixed a case where one trading day was incorrectly interpreted as 24 months.
- 概率显示保留至多一位小数，Yes 量化后再计算 No 补数；程序汇集、主 Agent 正常裁决和维护恢复分别标识。

  Displayed probabilities retain at most one decimal place, and the No complement is calculated after quantizing Yes. Programmatic aggregation, normal main-Agent adjudication, and maintenance recovery are labeled separately.

### 真实运行记录 / Live Execution Record

原 4.2 验收通过真实 UI、DeepSeek 模型和联网来源完成 8 项案例、9 个运行，合计 155 次模型请求、129 次研究工具、1,739,030 模型 tokens。该数字包含语义失败与取消，不是成功样本数或最终账单。

The original 4.2 acceptance used the real UI, DeepSeek model, and online sources across 8 cases and 9 runs, totaling 155 model requests, 129 research-tool calls, and 1,739,030 model tokens. These totals include semantic failures and cancellations; they are neither a successful-sample count nor a final bill.

| 案例 / Case | 实际记录 / Actual Record | 验收含义 / Acceptance Meaning |
| --- | --- | --- |
| 新 AAPL 三交易日下跌<br>New AAPL three-trading-day decline | Yes 52%，目标固定为纽约 2026-11-25 16:00；自然监听后更新至 54%<br>Yes 52%, targeting 2026-11-25 16:00 New York time; natural monitoring later updated it to 54% | 关预览页、同数据重启、恢复会话 Key 后的自然唤醒已观察；原预测和证据哈希不变<br>Observed natural wake-up after closing the preview, restarting on the same data, and restoring the session Key; original forecast and evidence hashes remained unchanged |
| 腾讯手动检查<br>Tencent manual check | Yes 46% → 45% | 读取上一轮判断、4 份报告和 8 条关系，普通增量只派相关两席<br>Read the previous judgment, four reports, and eight relationships; a normal increment assigned only two relevant roles |
| 新“字节股票”<br>New “ByteDance stock” | 未核验公开可交易证券身份后澄清，无预测概率<br>Clarified the unverified publicly tradable security identity without producing a probability | 不再擅自改成 IPO 或代理标的题<br>No unauthorized rewrite into an IPO or proxy-security question |
| 原显式上市事件<br>Original explicit listing event | 曾把 1 交易日解释成 24 个月并发布 9%<br>Previously interpreted one trading day as 24 months and published 9% | 作为真实语义失败保留，不能计为成功<br>Preserved as a real semantic failure, not counted as success |
| 相同上市问法修复复验<br>Recheck of the same listing question after the fix | 新任务输出 0.5%，拆题、派工和摘要均围绕同一交易日<br>A new task produced 0.5%, with decomposition, assignment, and summary all using the same trading day | 只证明该修复案例，不证明任意自然语言期限都正确<br>Proves only the fixed case, not arbitrary natural-language horizon handling |
| NVDA 20 交易日<br>NVDA 20 trading days | 实际调查后取消，无概率<br>Cancelled after actual investigation; no probability | 只覆盖创建和活动取消，不是完整 20 日预测验收<br>Covers creation and active cancellation only, not complete 20-day forecast acceptance |
| 排队取消<br>Queued cancellation | 0 次模型调用<br>0 model calls | 取消路径已观察，不保证供应商侧永不计费<br>The cancellation path was observed; this does not guarantee that a provider will never charge |

当时仍保留 20 交易日完整概率发布、浏览器下载实际落地和学习页面真实结算 UI 等缺口；模型摘要也可能错误概括分歧。详细逐次用量、失败和限制见 [安全验收数据](docs/evidence/v42-live-regression.json)。

At that stage, gaps remained for complete 20-trading-day probability publication, actual browser-download landing, and a live-settled learning-page UI. Model summaries could also misrepresent disagreements. See the [Safety Acceptance Data](docs/evidence/v42-live-regression.json) for per-run usage, failures, and limitations.

## V4.0：金融工作台与研究室重构 / V4.0: Financial Workstation and Research-Room Reconstruction

| 日期 / Date | 改动 / Changes | 验证 / Verification | 边界与状态 / Boundaries and Status |
| --- | --- | --- | --- |
| 2026-11-22 | 主视图改为全屏像素研究室；开始预测、研究室设置、模型连接改为操作窗口；真实预测历史改为顶部下拉。<br>Changed the main view to a full-screen pixel room; moved Start Prediction, Room Settings, and Model Connection into operation windows; moved live prediction history into a top dropdown. | [研究室与弹窗回归](docs/evidence/v4-room-shell-regression.json)；后续 workflow 定向检查 8/8。<br>[Room and dialog regression](docs/evidence/v4-room-shell-regression.json); later targeted workflow checks: 8/8. | 房间与弹窗独立维护；详细周期和工具记录集中到“预测结果与进度”。<br>The room and dialogs are maintained independently; detailed cycle and tool records are consolidated under “Prediction Results and Progress.” |
| 2026-11-22 | DeepSeek Key、完整 URL 和 model 可编辑，提供官方／校园预设与 URL 自动匹配；成功后脱敏保留输入。<br>Made the DeepSeek Key, full URL, and model editable; added official/campus presets and URL auto-matching; retained the input as a masked value after success. | [模型配置回归](docs/evidence/v4-provider-configuration-regression.json)。<br>[Model configuration regression](docs/evidence/v4-provider-configuration-regression.json). | Key 仅存当前文档及服务会话内存；校园凭据不转发给官方资料服务。<br>The Key remains only in the current document and server-session memory; campus credentials are not forwarded to official source services. |
| 2026-11-22 | 新增有限／无限任务 Token 总预算、可编辑预设和公开模型价格展示。<br>Added finite/unlimited task Token budgets, editable presets, and public model-price display. | [预算与价格回归](docs/evidence/v4-research-settings-regression.json)。<br>[Budget and pricing regression](docs/evidence/v4-research-settings-regression.json). | 新预测默认有限 1,000,000 tokens；设置只作用于新任务，无可靠收费来源时显示未公开。<br>New forecasts default to a finite 1,000,000 tokens. Settings apply only to new tasks; pricing is shown as unavailable when no reliable source exists. |
| 2026-11-22 | 新增研究员席位删除和页面主题二次确认，保留历史角色版本、报告与运行快照。<br>Added researcher-role deletion and page-theme confirmation while preserving historical role versions, reports, and run snapshots. | [删除与主题确认回归](docs/evidence/v4-theme-confirmation-regression.json)。<br>[Deletion and theme-confirmation regression](docs/evidence/v4-theme-confirmation-regression.json). | 运行中或版本冲突拒绝删除；缺少所需角色会在模型调用前提示。<br>Deletion is rejected during active runs or version conflicts. Missing required roles produce an error before model invocation. |
| 2026-11-22 | 金融标的改为单输入，期限提供 1／3／5／20 个交易日，默认 5 日；创建时封存市场和目标收盘时间。<br>Changed financial symbols to one input; added 1/3/5/20-trading-day horizons with a default of 5; sealed the market and target close at creation. | [金融入口与交易日回归](docs/evidence/v4-financial-entry-regression.json)。<br>[Financial entry and trading-day regression](docs/evidence/v4-financial-entry-regression.json). | 使用已核验休市、半日市与时区；超出日历覆盖范围拒绝计算，不等于全市场行情能力。<br>Uses verified closures, half-days, and time zones. Dates beyond calendar coverage are rejected; this is not a universal market-data capability. |
| 2026-11-22 | 初版界面中英切换、弹窗生命周期和过期异步回调保护。<br>Added initial Chinese/English switching, dialog lifecycle handling, and stale asynchronous-callback protection. | [447/447 全量回归](docs/evidence/v4-locale-navigation-regression.json)。<br>[447/447 full regression](docs/evidence/v4-locale-navigation-regression.json). | 当时覆盖主要界面；完整 English 与按任务报告语言由 V4.3 继续补齐。<br>Covered the main interface at that stage; V4.3 later completed English coverage and per-task report language. |

V4.0 后续整合 4.2 时记录全量 **588/588** 通过。该数字属于整合时点，不与 447、588 或后续版本相加。

The later V4.0 integration with 4.2 recorded **588/588 passing tests**. This total belongs to that integration point and must not be added to 447, 588, or later totals.

## V3.0：证据、财报与固定规则闭环 / V3.0: Evidence, Financial Statements, and Fixed-Rule Closed Loops

代表提交为 `d3c95a5` 与文档整合提交 `72b35ac`。这一阶段在既有 mock/live 隔离、模型连接和像素界面上，补齐十类调查方法、市场基准、财报口径、多语言检索、逐条引用、报告裁决、预算恢复及固定规则结果核验。

The representative commits are `d3c95a5` and documentation-integration commit `72b35ac`. Building on mock/live isolation, model connection, and the pixel interface, this stage added ten investigation methods, market benchmarks, financial-statement conventions, multilingual retrieval, itemized citations, report adjudication, budget recovery, and fixed-rule outcome verification.

- 五种受控问题各实际执行三席，累计覆盖十类方法；这不等于十类均完成真实外部渠道验收。

  Five controlled questions each executed three roles, cumulatively covering ten methods. This does not mean all ten passed live external-channel acceptance.
- 财报研究使用独立 `purpose: research`，保存事实、来源、限制和逐报告裁决，不生成未来事件概率。

  Financial-statement research uses a separate `purpose: research` and stores facts, sources, limitations, and report-by-report adjudication without producing future-event probabilities.
- 严格 BTC-USDT 子集要求市场、统计、核验三席完整，保存固定基准、最新观察和目标后结果；原始 K 线与确定性统计归档，模型只读取统计摘要。

  The strict BTC-USDT subset requires complete market, statistics, and verification roles. It stores the fixed benchmark, latest observation, and post-target outcome. Raw candles and deterministic statistics are archived, while models read only statistical summaries.
- 完整阶段回归 **333/333** 通过，历史机器记录见 [协作回归摘要](docs/evidence/collaboration-regression-summary.json)。

  The complete stage regression passed **333/333**; see the historical [Collaboration Regression Summary](docs/evidence/collaboration-regression-summary.json).
- 真实金融样例发布 Yes 46%，到期按固定规则得到 No，单题 Brier 为 0.2116；原概率、证据和用量不变。该案例只证明执行闭环，不证明总体准确率或多 Agent 相对优势。

  The live financial example published Yes 46%; the fixed rule later produced No, giving a single-question Brier score of 0.2116. The original probability, evidence, and usage remained unchanged. This case demonstrates execution closure, not overall accuracy or a relative multi-agent advantage.

详细记录见 [V3.0 发布说明](docs/V3_RELEASE.md)、[金融预测报告](docs/FINANCIAL_PREDICTION_REPORT.md)、[财报复核](docs/FINANCE_RESEARCH_REPORT.md)与 [协作验证](docs/COLLABORATION_VALIDATION.md)。

See the [V3.0 Release Notes](docs/V3_RELEASE.md), [Financial Prediction Report](docs/FINANCIAL_PREDICTION_REPORT.md), [Financial Research Review](docs/FINANCE_RESEARCH_REPORT.md), and [Collaboration Validation](docs/COLLABORATION_VALIDATION.md) for detailed records.

## V2.0：课程纵向路径、记忆与环境隔离 / V2.0: Course-Scale Path, Memory, and Environment Isolation

### 主要提交 / Main Commits

| 提交 / Commit | 内容 / Content |
| --- | --- |
| `597cdf1` | 建立带监督派工的研究与记忆引擎。<br>Built a research and memory engine with supervised assignment. |
| `4f2ac62` | 发布可见的 live 多 Agent 研究过程，完成课程纵向路径。<br>Exposed the live multi-agent research process and completed the course-scale vertical path. |
| `6dd4fe8` | 补充 V2.0 改动、真实证据和剩余工作文档。<br>Documented V2.0 changes, live evidence, and remaining work. |
| `049814a` | 公开总结与结构化字段一致，标注条件估计、不计分及冲突。<br>Aligned public summaries with structured fields and labeled conditional estimates, non-scoring, and conflicts. |
| `9add50b` | 隔离 mock/live 入口、数据目录与 Key 生命周期。<br>Isolated mock/live entries, data directories, and Key lifecycles. |

### 已形成的课程主链路 / Established Course Workflow

- 主 Agent 先整理和分配任务，子 Agent 先取证，再核定预测契约；每位研究员的模型等待、工具和报告由真实执行事件驱动。

  The main Agent first normalizes and assigns the question. Sub-agents gather evidence before finalizing the forecast contract. Model waiting, tool use, and reports for every researcher are driven by actual execution events.
- 每位研究员的调查、报告与补查有明确上限；短期检索同题最近 7 天的有限研判，长期检索 90 天内的有限关系与证据索引。

  Investigation, reporting, and follow-up have explicit limits for each researcher. Short-term retrieval reads a bounded set of same-question judgments from the last 7 days; long-term retrieval reads bounded relationships and evidence indexes within 90 days.
- 重复内容不调用模型、不新增概率；普通更新由相关研究员与核验席局部复核，重大变化召回原团队。

  Duplicate content makes no model call and creates no new probability. Normal updates receive targeted review from relevant researchers and verification; material changes recall the original team.
- SQLite 保存任务、检查点、工具回执、证据、关系及概率；取消、重启、鉴权失败与恢复分别记录。

  SQLite stores tasks, checkpoints, tool receipts, evidence, relationships, and probabilities. Cancellation, restart, authentication failure, and recovery are recorded separately.
- 真实黄金题与后续无增量检查验证了历史读取和不重复发布，但不构成预测准确率证据。

  A live golden question and a later no-change check verified historical retrieval and non-duplication, but do not constitute forecast-accuracy evidence.

当时产品只开放 binary；自主监听频率、完整时序图、通用自动到期评分和大规模校准仍未完成。详细设计见 [V2.0 改动与开发清单](docs/V2_CHANGELOG_AND_ROADMAP.md)，真实记录见 [V2.0 交付](docs/V2_RELEASE.md)与 [可用性说明](docs/DEMO_USABILITY.md)。

The product exposed binary output only at that stage. Autonomous monitoring frequency, a complete temporal graph, general automatic expiry scoring, and large-scale calibration remained incomplete. See [V2.0 Changes and Development Roadmap](docs/V2_CHANGELOG_AND_ROADMAP.md) for the design and [V2.0 Delivery](docs/V2_RELEASE.md) and [Usability Notes](docs/DEMO_USABILITY.md) for live records.

## main 基线：旧版案例研究室 / main Baseline: Legacy Case Research Room

main 基线提交 `7043e0a` 的 README 采用“项目截图 → 本地运行 → 研究室 → 真实模型 → 演示 → Harness／工具／技能／学习 → 数据范围 → 目录与验证 → 设计参考”的结构。当前 README 沿用这一阅读顺序，但内容已更新到 V4.4。

The README at main baseline commit `7043e0a` used the sequence “screenshots → local setup → research room → live model → demo → Harness/tools/skills/learning → data scope → structure and verification → design references.” The current README retains this reading order while updating its content to V4.4.

旧版以 2025 年 AI 芯片出口许可为例，包含固定五席会议、NVIDIA／AMD 时间轴、SEC／Polymarket 监测、侧桌复核、情景推演、预测封存和基础 Brier 学习。旧版 Node 20、`node start.mjs`、默认 4173 等说明只属于该基线；当前要求、入口和端口以 [README](README.md) 为准。

The legacy version used the 2025 AI-chip export-license case and included a five-role meeting, NVIDIA/AMD timelines, SEC/Polymarket monitoring, side-table review, scenario exploration, sealed forecasts, and basic Brier learning. Its Node 20, `node start.mjs`, and default port 4173 instructions apply only to that baseline. See [README](README.md) for current requirements, entries, and ports.

旧案例仍可从 `/legacy.html` 及保留代码追溯，但不能与当前课程预测主路径混写为同一套运行契约。

Legacy cases remain traceable through `/legacy.html` and retained code, but must not be described as sharing the same runtime contract as the current course-prediction path.

## 历史材料索引 / Historical Material Index

- [交接入口](docs/DELIVERY_HANDOFF.md) 与 [交付质量报告](docs/DELIVERY_STATUS_REPORT.md)

  [Handoff Entry](docs/DELIVERY_HANDOFF.md) and [Delivery Quality Report](docs/DELIVERY_STATUS_REPORT.md)
- [课程验收](docs/COURSE_ACCEPTANCE.md) 与 [课程 MVP](docs/COURSE_MVP.md)

  [Course Acceptance](docs/COURSE_ACCEPTANCE.md) and [Course MVP](docs/COURSE_MVP.md)
- [M0 验收](docs/M0_ACCEPTANCE.md)、[M1 验收](docs/M1_ACCEPTANCE.md) 与 [M1 独立审查](docs/M1_INDEPENDENT_REVIEW.md)

  [M0 Acceptance](docs/M0_ACCEPTANCE.md), [M1 Acceptance](docs/M1_ACCEPTANCE.md), and [M1 Independent Review](docs/M1_INDEPENDENT_REVIEW.md)
- [协作交接](docs/COLLABORATION_HANDOFF.md) 与 [财报交接](docs/FINANCE_RESEARCH_HANDOFF.md)

  [Collaboration Handoff](docs/COLLABORATION_HANDOFF.md) and [Financial Research Handoff](docs/FINANCE_RESEARCH_HANDOFF.md)
- [预测可靠性](docs/FORECAST_RELIABILITY.md) 与 [有界预测验证](docs/BOUNDED_FORECAST_VALIDATION.md)

  [Forecast Reliability](docs/FORECAST_RELIABILITY.md) and [Bounded Forecast Validation](docs/BOUNDED_FORECAST_VALIDATION.md)
- [决策记录](docs/DECISION_LOG.md) 与 [实现状态](docs/IMPLEMENTATION_STATUS.md)

  [Decision Log](docs/DECISION_LOG.md) and [Implementation Status](docs/IMPLEMENTATION_STATUS.md)
- `docs/screenshots/`：各版本原始界面与真实运行截图，按文件名和对应文档日期理解

  `docs/screenshots/`: Original interface and live-run screenshots from each version, interpreted by filename and corresponding document date

## 文档口径与中英文审阅（2026-11-23）/ Documentation and Chinese-English Review (2026-11-23)

本次重写按“当前代码 + 最新决策 + 对应版本证据”核对文档，结果如下。

This revision checked the documentation against the current code, latest decisions, and evidence for each version. The results are as follows.

| 检查项 / Check | 发现 / Finding | 处理／当前口径 / Resolution or Current Position |
| --- | --- | --- |
| 当前版本<br>Current version | 原 README 顶部仍写“当前交付版本 4.2”，后文又混入 V4.3 与欢迎页改动；当前实际分支为 V4.4。<br>The original README header still said “current delivery version 4.2,” while later sections mixed in V4.3 and welcome-page changes. The actual branch is V4.4. | 新 README 改为 V4.4；4.2、V4.3 内容移入本文。`package.json` 的 `version` 仍为 `4.2.0`，属于尚未同步的包元数据，本次不把它当作产品分支版本，也未擅自做版本发布修改。<br>The new README uses V4.4, and 4.2/V4.3 material moved here. `package.json` still has `version: 4.2.0`; this unsynchronized package metadata is not treated as the product branch version, and no release-version change was made without authorization. |
| main 与当前运行方式<br>main versus current setup | main 的 Node 20、`node start.mjs`、4173 和默认 mock 已不适用于当前版本。<br>main's Node 20, `node start.mjs`, port 4173, and default mock setup no longer apply. | README 改为 Node ≥22.17、`npm ci && npm start`、4174、`.data/live/`；main 原文作为历史基线保留。<br>README now specifies Node ≥22.17, `npm ci && npm start`, port 4174, and `.data/live/`. The original main text remains a historical baseline. |
| 欢迎页与教程<br>Welcome page and tutorials | PRD D054 仍描述 `#/guide` 目录、研究室教程／欢迎页入口，和当前页面不同；D055–D059 已明确取代这些部分。<br>PRD D054 still describes a `#/guide` directory and research-room tutorial/welcome entries that differ from the current page. D055–D059 explicitly supersede those parts. | 当前 `#/guide` 转向欢迎页，章节深链接保留；教程只从欢迎页正文进入，研究室右下角保留“回到欢迎页”。属于有后续决策的历史时间切片，不再当作当前冲突。<br>`#/guide` now redirects to the welcome page, while chapter deep links remain. Tutorials are entered only from welcome-page content, and “Back to Welcome” remains at the room's lower right. This is a historical slice superseded by later decisions, not a current conflict. |
| Key 表单行为<br>Key-form behavior | 旧架构段落仍写“输入框不回显，刷新后需重新输入”，V4.3 已增加同文档脱敏保留。<br>The old architecture paragraph still said the input was not retained and required re-entry after refresh; V4.3 added same-document masked retention. | 当前行为以 V4.3 代码和回归为准：同文档可恢复，整页刷新不回填；架构说明同步修正。<br>Current behavior follows the V4.3 code and regression: the same document can retain the value, while a full refresh does not refill it. The architecture document was corrected accordingly. |
| 实现状态版本标签<br>Implementation-status version label | 最新汇总条目包含 V4.4 的教程与席位改动，但条目标题仍写 V4.3。<br>The latest summary included V4.4 tutorial and role-profile changes but was still labeled V4.3. | 汇总条目标签同步为 V4.4；单日各阶段原始记录仍在本文按提交区分。<br>The summary label was updated to V4.4. Original same-day stages remain separated by commit in this document. |
| 中英文文档<br>Chinese and English documentation | 此前仓库只有中文根 README，没有独立英文 README 或英文交付文档，无法逐段对照。<br>The repository previously had only a Chinese root README and no standalone English README or English delivery document to compare line by line. | 按参考截图改为同一文件内标题中英并排、正文逐段中文在上英文在下；不另建相互独立、容易失配的英文版本。<br>Following the reference screenshot, both documents now place Chinese and English side by side in headings and use Chinese above English for each paragraph. Separate English files were avoided to prevent divergence. |
| 历史发布说明<br>Historical release notes | 4.2／V3.0／V2.0 文档仍使用各自当时的“当前分支”“未上传”和旧测试数。<br>The 4.2/V3.0/V2.0 documents still use their original “current branch,” “not uploaded,” and historical test totals. | 作为历史材料保留，不回改旧验收事实；当前使用说明不再复制这些表述。<br>They remain historical material without rewriting old acceptance facts. Current usage instructions no longer repeat those statements. |
| 测试与真实效果<br>Tests versus live outcomes | 多份文档同时出现 333、447、608、645、653、659 等数字。<br>Different documents contain totals such as 333, 447, 608, 645, 653, and 659. | 它们是不同阶段的累计全量数，不能相加；当前记录为 659/659。真实模型运行、UI 自动化和预测准确率继续分别表述。<br>These are cumulative totals from different stages and must not be added. The current record is 659/659. Live-model execution, UI automation, and forecast accuracy remain separate claims. |

两份文档后续应同步维护版本、入口、Key 行为、教程边界和 binary 限制，保持每个中文段落下的英文含义一致，避免形成两套冲突的交付口径。

Both documents should be maintained together for future changes to versions, entries, Key behavior, tutorial boundaries, and binary limits. Each English paragraph must retain the meaning of the Chinese paragraph above it so that the two languages do not develop conflicting delivery claims.
