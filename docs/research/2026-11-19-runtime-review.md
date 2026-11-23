# 现有运行时审查与自主监测的增量架构

核验日期：2026-11-19。范围：只读检查当前 `server/`、`start.mjs` 和已有验收记录，并访问下文官方文档；仅新增本报告。未读取凭据、调用付费模型、修改存档、安装依赖或重新执行测试。文档记录的既往测试通过，不作为本次重新验证的结果。

## 结论

当前新工作台是**用户准备问题和材料后，启动一个可恢复的单研究员材料研读任务**。它已有真实的模型工具协议、执行循环、权限交集、预算、SQLite 检查点、工具回执和提交后事件。它还没有主 Agent 自动规范问题、自动上网取证、按需派工、多人补查、持续监听和二元概率发布闭环。

旧版则已有固定五角色会议、特定案例的事件概率及 SEC/Polymarket 自动观察，但属于另一条运行路径。两者的能力不能直接相加后宣称新系统已完成。建议保留已验证的存储、worker 和界面事件契约，增量补主 Agent 与持久监测任务，不先重写整栈。所有技术只服务课程演示；下文框架调查是机制参考和备选，不是建设大型平台或新增 Python sidecar 的建议。

## 新工作台实际怎样完成一轮

| 环节 | 代码实际行为 | 当前边界 |
| --- | --- | --- |
| 建主题和题目 | HTTP 将用户输入交给领域存储；draft 可不完整，ready 校验二元题、窗口、时区、结算规则/来源及无法判断处理；版本不可变，更新有 expectedVersion 和持久幂等键 | 没有自然语言→结构化题目服务；字段由用户准备，Schema 也不验证问题在语义上是否唯一可结算 |
| 收集材料 | 用户提交标题、正文、可选 URL、发布时间和题目归属；服务端记录 firstSeenAt/retrievedAt/contentHash | 添加 URL 不会自动下载正文；新工作台无网页搜索/抓取处理器 |
| 创建 Run | 必须 ready、未过停止发布时间、不是旧回放题；选一个角色，默认 official；使用本题可见材料，最多 12 份，可显式选择，超过上限拒绝 | 一次 Run 只有一个 Assignment/agentSpec；没有主 Agent 判断需要哪些角色 |
| 封存输入 | 保存问题版本、角色及方法文本、材料原文/时间/哈希、模型身份与预算；同题活动 Run 互斥 | 本轮是 live 材料快照，未实现通用 fixed 截点研究；领域层有 cutoff 过滤，但该创建入口没有传入 cutoff |
| 执行研究 | `runWorker` 让模型通过原生 tool_calls 自选已授权工具；执行处理器，将相同 tool_call_id 的结果回填，再让模型继续，直至 submit_report 或预算/错误停止 | 真正可执行的研究工具只有 list_provided_sources、read_evidence；submit_report 是运行时收尾工具。没有外部检索能力 |
| 保存与呈现 | 保存消息、待执行调用、工具预算预留、执行结果和报告；事件在数据库提交后推送，公开 API 不返回私有 messages | 完成表示报告提交，不等于证据充分、问题已解决或预测已发布；最多 4 个并发 Run 不等于一题有 4 人协作 |
| 一轮结束 | 返回 support/counterevidence/missingEvidence/nextSuggestion 等报告；prediction.forecast 固定为 null | 不会自动执行 nextSuggestion、产生下一次派工、监听变化、发布 probabilityYes 或进入结算 |

代码入口：`server/domain/workbench-service.mjs:33,40,70,74,85`；`server/runtime/research-service.mjs:63,108,189,225,229`；`server/runtime/worker-loop.mjs:63,130,161,205`；`server/workbench-http.mjs:37`。

## 哪些是真实机制，哪些仍是角色方法文字

**真实运行机制。** Worker 对角色、Assignment、部署启用列表和实际注册表取工具权限交集；有入参/结果 Schema、引用范围检查、工具超时、模型重试和累计请求/工具/token 预算。模型返回的待执行调用先保存，再执行工具；恢复时按 runId/toolCallId 查持久回执，避免重复执行已记账的处理器。工具回执与 worker 检查点在服务中分步保存，恢复靠回执补齐，两者并非任何时刻都在同一次提交里。核心 store 的 commitStep 能在单事务中提交检查点、事件及回执；完成事件与证明它的 worker 状态一起提交。取消先持久化终态，再中止执行，迟到回执只能审计。SSE 按 epoch/seq 提供重连水位。

**仍是方法提示词的部分。** 十类 Agent 的 instructions 与 skillRefs 会实际拼入 worker 的系统消息，且版本被 Run 固定；但十类角色当前共享同样两个材料工具。行业分析、新闻去重、统计计算、图查询、历史检索、舆情搜索等专用能力只在 plannedTools 中，没有可执行处理器。这里的 skill 是 `kind: method, executable: false` 的方法文本，不是安装后的独立执行器。角色提示词本身可以成为合法的 role-based 分工基础；缺少的是同时发生的实质派工、受控通信、补查和最终决策。

**不能由提示词推出的保证。** M1 在 instructions 要求 probability 为 null，但通用 reportSchema 仍允许数值；submit_report 没有 M1 专用 null 守卫。工作台 forecast 始终为空，因此这些数值不会成为正式预测，但也不能把“禁止发布”的提示词当作发布验证器。此外，M1 将 inputEvidence 编号预先放入可引用集合，引用合法不证明模型已调用 read_evidence 阅读正文。后续应区分“可访问、已取回、已引用”，不把 tool UI 动画当作研究完成证明。

依据：`server/runtime/worker-loop.mjs:12,94,111,123,169,222,237`；`server/runtime/research-service.mjs:63,126,160,268`；`server/core/store.mjs:179,200,257,302,322`；`server/domain/agent-catalog.mjs:3,39,44,49`。

## 旧版能力应怎样看待

| 旧模块 | 已有能力 | 可借用与限制 |
| --- | --- | --- |
| harness.mjs + tools.mjs | 四个专席并行分析、主持人质疑、公司席复核、汇总；九种本地案例操作真的执行 | 工具计划和参与者由代码固定；模型只对预先取得的结果给 JSON，不能自行选下一项工具。适合复用报告/异议概念，不宜包装成动态 Supervisor |
| world.mjs | 历史时钟、基础分支首次概率封存、揭晓后的 Brier 评分、同模式历史残差有界校正 | 仅内置 GPU 出口案例及两道题；“学习”为已结算样本校正，并非训练模型或生成任意公司的世界。首次封存与最近展示结果并存，不是通用预测时序账本 |
| tools.mjs 中 roll_scenario | 明确区分真实观察与假设，生成两步状态变化和影响路径 | AMD 许可/替代关系由手写规则产生，没有可学习的通用世界状态、因果图更新或多主体环境模拟 |
| monitor.mjs + sources.mjs | 定时请求 SEC submissions 和 Polymarket 搜索接口，保存 known/基线/pending/retryAt；命中规则后启动会议 | 固定 NVDA/AMD、固定关键词与触发阈值；SEC 取得申报索引而非公告全文。会议固定席位，且不发布概率；未绑定新主题/题目/角色版本/证据账本 |

旧 monitor 的 pending 和重试时间保存在 JSON，不能说完全无持久性；但计时器与 nextCheckAt 是进程内状态，启动后重新安排轮询，没有通用 WatchPlan、分布式租约或逐题任务账本。新 runtime 的 jobs 也只是进程内 Map，pump 用于排队/恢复已有 Run，不是监听新闻的调度器；waiting 当前主要用于模型配置不匹配。服务默认具备 SQLite 时会启用新工作台，同时仍可运行旧观察器，因此 UI 中出现后台事件不代表新题已经被持续监测。

依据：`server/harness.mjs:20,99,137,166,194`；`server/world.mjs:11,16,116,145`；`server/tools.mjs:16,56,95`；`server/sources.mjs:3,12,61,172,240`；`server/monitor.mjs:69,130,204,248,316`；`start.mjs:31,43,123`。

新工作台 `/learning` 当前只投影导入的旧 settled-forecast，明确 scoringEligible:false；没有新题的结算、技能自改或跨 Run 反馈检索闭环。领域记录中的 scoringEligible 只是资格标志，不是已发布或已评分的证据。依据：`server/domain/domain-store.mjs:353`。

## 官方模块调查：能借什么，不能自动得到什么

以下 URL 均在本次实际打开核实。官方文档能力不等于本项目已安装、集成或验证。

| 官方模块 | 核实的机制 | 本项目建议边界 |
| --- | --- | --- |
| [LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Checkpointer 保存线程内执行状态；Store 保存跨线程应用数据；MemorySaver 在进程重启后丢失 | 借鉴执行状态与长期知识分层；原有证据、版本及预测账本继续由应用数据库负责，语义 Store 可作为检索索引 |
| [LangGraph Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) | super-step 保存状态；thread_id 定位上下文；错误恢复 invoke(null)，回答等待用 Command(resume)，历史重放是另一种动作 | 可将一次研究 Run 映射到隔离 thread，Assignment 用子命名空间；不把所有题目和每次更新混进一个无限对话。采用前验证 sync 持久化及断电恢复 |
| [LangGraph Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) | 可配置重试、超时和错误路由；重试重跑节点，外部副作用不是 exactly-once；稳定幂等键应在副作用前持久 | 保留已有回执和业务终态守卫；替换控制流也不能删除这些约束。框架恢复不代表允许恢复已取消业务 |
| [LangGraph Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) | 父子图可经适配函数转换状态，子 Agent 可保持独立消息历史 | 可只用于 Supervisor→Worker 的隔离调用和补查；原生 worker-loop 可暂留。不要让框架和现有 pump 同时拥有同一任务的执行权 |
| [LangGraph Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api) | entrypoint/task 可包装现有代码；恢复从边界重放，已完成 task 结果从检查点取回，未完成 task 仍可能重做 | 作为低侵入执行器候选，不能把整个无限轮询塞进一个 task 就认为每次搜索都可恢复；搜索、模型调用及持久写入需明确工作单元 |
| [LangSmith Agent Server cron](https://docs.langchain.com/langsmith/cron-jobs) | 服务端可按 UTC cron 启动后台任务，也能绑定指定线程 | 是 Agent Server 的能力，不是仅安装 OSS StateGraph 就自带的定时器；属于可选部署设施，不应为一个本地 demo 强制引入整套服务 |
| [Temporal TypeScript Timers](https://docs.temporal.io/develop/typescript/workflows/timers) | Timer 可持久化，服务/Worker 恢复后继续等待完成，不靠常驻 JS 计时器保持任务 | 若未来需要跨天、分布式监听，可只评估 Job/Timer 层。当前先以现有 SQLite 做持久 nextDueAt/任务租约，不为此重写模型、证据和前端 |

本次访问旧官方 `/oss/javascript/langgraph/durable-execution` 已重定向到 Persistence；恢复和幂等细节应引用上述现行 Checkpointers、Fault tolerance、Functional API 页面。项目既有 [M0_FRAMEWORK_DECISION.md](../M0_FRAMEWORK_DECISION.md) 记录了 LangGraph 内存探针通过，但 SqliteSaver 原生绑定未加载成功；本次没有重跑，不将其升级为磁盘恢复已验证。应用 package.json 目前只有 ajv，LangGraph 候选实验并未成为 server 的默认执行器。

取证适配可优先评估 [DeepSeek 官方 Search & Fetch](https://api-docs.deepseek.com/guides/search/)：独立 Search API 返回结构化结果，Fetch API 返回网页 Markdown，均用服务端 Bearer 认证；官方列出的接口是 `POST /v1/tools/search` 和 `POST /v1/tools/fetch`。它们可封装为 ToolGateway 的真实处理器，保留原始 URL、检索/取得时间、哈希和结果状态。搜索摘要不等于原文，提供商 date 也不能替代本系统 firstSeenAt；网页抓取仍可能失败。本次仅核实文档，未验证用户账户权限、API 连通或实际返回。

## 建议增量：把操作默认交给主 Agent

1. **自然语言入口与问题规范器。** 用户输入想研究的事件及可选材料，主 Agent 先检索对象和结果来源，再生成明确的 binary 合约、窗口、时区和结算规则草稿；已有 normalizePrediction/版本校验继续作提交守卫。自动填写有来源的默认值，将不可推断的关键歧义集中为一次补充，而非把整张技术表单交给用户。无法唯一界定的事件保留 draft，不能靠任意补一个期限/阈值制造“ready”。
2. **真实取证网关。** 扩展现有 ToolResult 和工具许可机制，首版接 search_web/fetch_page 等少数可靠处理器；旧 SEC/Polymarket 解析可抽成 topic-aware source adapter。结果进入原有不可变 Evidence，再由角色取用；大正文应保存原件并分段读取，不能静默截成 4000 字后声称阅读了全文。
3. **主 Agent 按需派工。** 先保留十个角色模板；主 Agent 为每个子问题选择 instructions、context、tools、model、预算与期限，生成真实 Assignment。报告返回后决定补查、质疑、改计划或结束，实际调用 worker-loop，而非在一句提示词中扮演十个人。每个 Assignment 独立上下文及检查点，Run 另外保存计划、任务状态和争议。复用现有单 worker 不等于无需增加这层状态机。
4. **独立二元预测发布器。** 模型/主持人只提交候选 probabilityYes 及公开证据解释，应用验证问题版本、时间窗口、模式、证据与终态后原子写入不可变 Forecast 和事件。保持“概率、证据充分度、意见分歧”分开；同一契约下的多个版本按 issuedAt 形成概率时序，规则改变则开新契约版本。报告 complete 或角色一致都不自动批准发布。
5. **持久 WatchPlan/Job。** 主 Agent 提议监测来源、查询、周期和变化条件，服务端持久化 nextDueAt、source cursor、内容哈希、冷却、失败重试、预算和截止条件。到期领取短任务，检查新证据；发现实质变化才通过 `trigger: watch` 创建新 Run，重复事件幂等去重，未变化则仅保存检查记录。课程首版只做单进程串行领取、重启补偿和暂停/取消守卫，不做分布式任务平台。**长期存在的是计划和任务，不是永远运行、反复花 token 的 LLM。**
6. **后接记忆、图和结算。** 将有出处的事实/反例、条件性关系与已结算反馈作为可检索版本数据；记忆检索受信息截点和模式隔离。先完成自动问题→实际取证→真实派工→一次二元发布，再扩展持续更新和结算，避免用无时间约束的“记忆”污染历史评估。

现有可直接保留：领域 ID/版本/幂等、证据与旧档案隔离、模型 transport、工具协议和权限、worker 预算/恢复、SQLite 回执/事件、SSE 与前端按 Run 投影。必须新增：意图规范服务、外部取证处理器、Supervisor 的真实控制流、多个 Assignment 状态、WatchPlan/Job、Forecast/Resolution 账本、后续记忆/图工具。框架候选只替换其中控制流或调度的一层，不能替代这些业务模块。

## 课程最小纵向闭环：建议下一批只做这些

**以下均为计划，不是当前已完成功能。** 保留现有 Node/SQLite、像素房间、十个角色模板，不迁移整栈 LangGraph，不增加 Python sidecar，不搭建通用分布式 Agent 平台。

| 演示环节 | 最小实现及复用点 |
| --- | --- |
| 一句话进入 | 主 Agent 将一句话规范成 binary 题；没有期限时使用界面明示的 48h 预设，自动填写对象、来源和规则，仅对确实无法定义事件的歧义提问。保留现有完整契约作为后端结构，不让用户逐项手填 |
| 三个真实 Worker | 官方资料、新闻时间线、反证核验三类；其余模板保留但不强制出场。主 Agent 针对子问题给不同目标、上下文和工具范围，调用真实 worker-loop，收独立报告，然后发生一次针对争议的补查 |
| 两类外部工具 | search 和 fetch 实际执行并回填模型；优先接已核实的官方接口，记录失败与来源，不扩展任意代码执行工具。沿用权限、Schema、预算和回执 |
| 最小证据关系 | 一张关系表保存 predictionId、claimId、evidenceId、supports/contradicts/updates、时间和版本；支持解释及反例展示，不先引入图数据库或通用知识图谱平台 |
| 一个持久 WatchJob | 仅为演示题保存查询、nextDueAt、已见来源/哈希、重试和截止；复用旧 monitor 的 baseline/known/冷却/重复抑制思路，但按 predictionId 接入新证据和 Run，不能直接复用旧全局 GPU 状态。到点短检查，实质变化才唤醒主 Agent |
| 二元结果与变化 | 独立发布器输出 probabilityYes、公开依据和缺口；以同一 predictionVersion 追加概率 history。是否发生的事实结果与概率分开；演示若用加速时间或注入消息须明确标注，不能伪装真实资讯或已发生结果 |
| 可观察的持续性 | 关闭网页后后端继续检查；重启一次服务，读取同一 WatchJob 和 Run/概率记录并继续。展示一次新证据→补查→概率更新，重复相同来源不再发布，取消后不发布 |

这条闭环足以展示角色分工、通信协调、真实工具、自己的 harness、持久记忆基础与持续更新。先把一题做通、可复现；长期记忆检索、自动结算扩展和更复杂的世界模拟留在后续，不将研究过的框架或画出的图算作实现。
