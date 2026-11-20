# 实现状态

最后更新为 2026 年 11 月 19 日，对应 PRD 0.6。输出只开放 binary（是／否）。用户授权实施后，本轮已接通课程纵向路径：一句输入、自动取证、主 Agent 加三 Worker、按争议补查、二元发布、来源关系及持久检查。口语、动态分工与监听记忆改进后完整测试 253/253，真实 DeepSeek 整轮已完成，详情及已知时间表述边界见 [课程验收](COURSE_ACCEPTANCE.md)。此前 99 项为 M1 历史批次，不能与本轮重复相加。文档编写不计功能完成，预测准确率与执行验收分别记录。

最新优先顺序见 [课程交付版](COURSE_MVP.md)：主 Agent 加三位研究员，一句话输入，真正搜索／读取、针对性复核、二元概率及一次持续更新。完整平台目标保留，但不全部成为课程前置。

天气故障追加：安全HTTP原因、暂停/重试、失败任务停止、“今天”本地日终及输出截断预算已修复；修正版原问法真实三席完成，Yes35%、资料有限。无结构化实况的预设天气题不自动结算。旧错误日期与失败保留，细节及限制见 [恢复验收](PROVIDER_RECOVERY.md)。

V2.0追加：先整理派工、子Agent模型等待可见、最多3协作周期、prompt预算、7天四次短期与90天长期检索、自己的API Key会话入口已交付。真实黄金三席完成（15模型/17工具/159288 tokens），条件估计不计分；真实后续检查带入历史后判无增量、不重发。详细原始记录、截图及范围见[V2.0交付](V2_RELEASE.md)。

完整改动和下一批验收见 [V2.0 详细改动与开发清单](V2_CHANGELOG_AND_ROADMAP.md)。真实 no_change 检查不等于已验证新证据导致概率更新。

P0-A（公开总结与结构化字段一致）已完成：新增 `server/course/forecast-facts.mjs`，发布时由受控字段生成事实段（基准／估计类型／计分／资料充分度／固定到期）与冲突标注，记忆侧注入"未核验／条件估计／不计分"状态标签，前端展示事实段、冲突警告与状态徽章。旧数据无需迁移：新字段只写新预测，记忆侧从既有结构化字段现场重推导，旧冲突摘要进记忆时同样被标注。回归新增 7 条，全套 260/260 通过。下一批优先补真实相关增量（P0-C）、最小核验／评估（P0-D）和最终课程材料（P0-E）。

运行隔离追加（2026-11-20）：新增 `npm run start:mock`（4173、`.data/mock/`、fixture、模型连接锁定）与 `npm run start:live`（4174、`.data/live/`、要求 `WORLD_API_KEY`、DeepSeek 来源）；两个入口拒绝使用对方数据目录，模拟入口不保留任何 Key，真实入口缺 Key 直接退出；顶栏新增“模拟环境 / 真实环境”徽章，数据库打开时检查是否已有相反模式的历史运行并拒绝启动；旧混合库不自动迁移。全套 268/268 通过。

入口收口追加（2026-11-20）：根目录 `start.mjs` 移为内部装配入口 `server/app.mjs`，删除 `npm start`；公开启动只剩 `npm run start:mock` / `npm run start:live` 与等价的 `node start-mock.mjs` / `node start-live.mjs`，两个包装入口均导入 `server/app.mjs`。`node server/app.mjs` 仍可运行自动模式，仅供测试、自定义端口/路径和旧版调试，不再作为文档入口。6 个进程级测试与冒烟测试的 spawn 路径已同步；全套 268/268 通过（2026-11-20 `node --test`）。

真实入口无 Key 启动追加（2026-11-20）：`start:live` 不再因缺少 `WORLD_API_KEY` 退出，允许先启动再到网页“模型连接”保存 Key。未配置时装配占位 provider，`POST /requests` 与 `check` 返回 409 `MODEL_NOT_CONFIGURED`，启动时跳过运行恢复，搜索能力显示 `unavailable`；保存 Key 后现有 `applyKey` 原子替换 provider 并恢复能力。新增 `live-http.test.mjs` 覆盖无 Key 启动、拒绝创建、保存会话 Key、来源从未配置变为 live；`environment.test.mjs` 的 live 断言同步改写；全套 269/269 通过（2026-11-20 `node --test`）。

环境徽章与模拟连接追加（2026-11-20）：顶栏徽章改为“模拟环境 · 未配置 / 真实环境 · 未配置 / 真实环境 · 已配置”，并加状态圆点（已配置绿色、未配置灰色）；徽章通过 `/api/v1/course/provider-connection` 读取连接状态，保存 Key 后自动刷新。模拟环境的连接表单允许输入与提交，但后端 `MODE_LOCKED` 拒绝保存，前端提示“模拟环境配置失败”，不接收 Key。更新 `course-capability.test.mjs` 与 `course-provider.test.mjs`；全套 269/269 通过（2026-11-20 `node --test`）。

连接校验追加（2026-11-20）：保存 Key 后自动调用 `GET {WORLD_BASE_URL}/models` 校验，8 秒超时，只读 HTTP 状态、不读正文、不回显 Key；状态区分 `connected` / `failed` / `unknown`，校验失败仍保存 Key。徽章扩展为绿点“已配置已连接”、琥珀点“已配置未连接/待校验”、灰点“未配置”。按用户确认，Key 不写入浏览器存储、不回显输入框，刷新后需重新输入。新增 `model-credentials.test.mjs`，更新连接与徽章测试；全套 272/272 通过（2026-11-20 `node --test`）。

首次 Key 死锁修复（2026-11-20）：真实库存在 1 条 active 监听时，连接接口错误地禁止首次保存，页面无法输入 Key。修复为 `configured=false` 时忽略活动任务与监听，允许首次保存，保存后旧计划按新凭据继续；`configured=true` 更换 Key 仍要求空闲。`applyKey` 首次配置跳过空闲检查并移除误唤醒的 `runtime.resume()`。更新 `provider-connection.test.mjs`、`course-provider.test.mjs`；全套 273/273 通过（2026-11-20 `node --test`）。

更换 Key 监听解锁（2026-11-20）：持续监听不再阻止更换 Key，`canUpdate` 只受正在执行或排队的任务限制；`update` 与 `applyKey` 同步移除监听检查，保存后旧监听按新凭据继续并在连接页提示。移除 `firstConfiguration` 分支，首次配置与更换使用同一规则。更新 `provider-connection.test.mjs`、`course-provider.test.mjs`；全套 273/273 通过（2026-11-20 `node --test`）。

Key 更换交互定稿（2026-11-20）：输入框与保存按钮始终可用，只有保存中/读取中禁用。已配置 Key 时，若存在活动运行或监听，保存返回 409 `PROVIDER_UPDATE_BUSY`，原 Key 不变，表单下方显示“原 API Key 保持不变”；首次配置仍允许，监听按新凭据继续。前端不再用 `canUpdate` 禁用输入，统一由服务端判定。更新连接与前端测试；全套 273/273 通过（2026-11-20 `node --test`）。

live 监测默认关闭（2026-11-20）：`server/app.mjs` 在 live 且未显式设置 `WORLD_MONITOR` 时使用 `off`，不再默认启动旧版公开监测；auto 仍默认 `public`。全套 273/273 通过（2026-11-20 `node --test`）。

多实例与旧归档（2026-11-20）：`PORT` 与 `WORLD_DATA_DIR` 可覆盖默认端口和数据目录，跨模式目录及 `.data` 根目录仍拒绝。新增 `scripts/legacy-data.mjs`，默认 dry-run，`--apply` 按课程运行模式迁移根目录 `world.json*` 到 `.data/mock/legacy/`、`.data/live/legacy/` 或 `.data/legacy/`。新增 `scripts/legacy-data.test.mjs` 与环境覆盖测试；全套 277/277 通过（2026-11-20 `node --test`）。当前根归档 dry-run 判定为 mock，因 4174 仍在运行尚未执行 `--apply`。

mock usage 明细（2026-11-20）：`course-mock-provider.mjs` 的合成 `usage` 补齐 `prompt_tokens`、`completion_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`，并保证总数与输入/输出、缓存命中/未命中一致，避免 `recordUsage` 只累计 `totalTokens`。新增 `course-mock-provider.test.mjs`；全套 278/278 通过（2026-11-20 `node --test`）。

连接校验正文消费（2026-11-20）：`verifyModelCredentials` 读取状态后调用 `response.text()` 并丢弃，避免未消费 body 占用连接；正文不解析、不记录、不回显。`model-credentials.test.mjs` 改为断言正文被消费但 `json()` 不被调用；全套 278/278 通过（2026-11-20 `node --test`）。

| 里程碑 | 状态 | 证据与下一步 |
| --- | --- | --- |
| 旧版基线 | 已有 | main 7043e0a；五个固定角色、九个案例工具、SSE 与后台监测。此前 17 项测试通过，DeepSeek 两场真实会议有运行记录 |
| M0 技术验证 | 原生协议真实调用已验 | 本轮 DeepSeek 连续调用两个材料工具并报告，3 模型请求、4039 tokens；早期离线过程见 M0_ACCEPTANCE.md，最新证据见 COURSE_ACCEPTANCE.md |
| M1 多预测任务 | 本轮 binary 范围已交付 | 主题／多题目 CRUD、草稿与就绪校验、不可变契约／角色版本、十类角色及自定义角色、证据隔离、旧案例只读导入；真实 API、持久事件与像素界面已接通。单研究员材料研读，不发布正式预测。全套 99/99，后端交叉审查 11 项，实际浏览器与进程重启验证见 M1_ACCEPTANCE.md |
| 课程纵向交付 | 已交付运行闭环 | 宽泛预设／partial strict、Search/Fetch/现价工具、Pro思考与按题派工，用户原题已真实发布；后续无变化检查0次模型调用且不新增点；不宣称准确率已证实 |
| M2 真实协作 | 课程子集通过，完整目标未完 | 十目录按题选三席、独立调用；V2.0 最多3协作周期，即初次加2次定向补查，不要求凑满。历史真实口语问题采用不同团队；任意插件扩展网络工具仍未完成 |
| M3 图与监听 | 最小子集通过 | 持久固定间隔检查、正文去重、局部两席／重大三席分流、历史判断与报告／关系摘要检索已验；自主频率及完整时序图推理未完成 |
| M4 预测与验证 | 发布已接，结算评估待完 | binary 不可变发布与边界、结果卡／轨迹已接；目标时点尚未到达；自动到期结算、评分 UI 与准确率对照仍待完成 |
| M5 扩展 | 待开始 | 更多来源与可选图服务，各自验收；其他输出头暂缓，需另行明确范围 |

每次完成更新填写日期、提交或文件、命令及运行结果、验收编号、失败与限制。此前测试记录作为旧版基线，重构后按改动重新运行。课程最小样例与完整 P0 分别记录完成度。

本轮分工与后续顺序见 [开发执行计划](DEVELOPMENT_PLAN.md)，当前验收以 [COURSE_ACCEPTANCE.md](COURSE_ACCEPTANCE.md)为准。[M1 验收](M1_ACCEPTANCE.md)、[M1 后端交叉审查](M1_INDEPENDENT_REVIEW.md)、M0 的 [验收](M0_ACCEPTANCE.md)和[独立审查](M0_INDEPENDENT_REVIEW.md)保留历史过程。LangGraph 核心候选另有 9 项实验通过，其 SqliteSaver 原生绑定环境尚未验证，按 PRD 允许路径采用显式状态机与原生 SQLite；详见[选型记录](M0_FRAMEWORK_DECISION.md)。
