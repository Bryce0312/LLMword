# 前端交付与接入顺序

**2026-11-18 M1 更新：** 默认事件工作台已接入真实 API 与 V1 持久事件，目前仅开放 binary（是／否）题和单研究员材料研读。正式概率发布、多 Agent 会议与其他题型尚未开放。主题／题目、材料收报、角色版本、独立学习档案及实时头顶气泡已接通；实际浏览器验收见 [M1_ACCEPTANCE.md](M1_ACCEPTANCE.md)。

以下为 M0 历史交付记录，其中 categorical 等旧规划以当前 binary 范围为准。

本批对应 PRD 0.2 的 M0 契约准备，遵循 AGENTS.md。新增纯事件投影器和针对性测试；**尚未导入现有 app.js，也没有新增可见页面或人物功能**。现有像素研究室、CSS、人物动画和 V0 SSE 保持原状。M0 全体验收仍需后端工具循环、存储及真实运行集成，不能用本模块测试替代。

## 已交付模块

`web/run-projection.mjs` 无 DOM、网络、定时器或第三方依赖；输入与状态均不原地修改，返回 JSON 可序列化状态与展示指令。公开接口：

| 接口 | 返回／作用 |
| --- | --- |
| `createProjectionState({selectedRunId?})` | 创建空投影；默认不选运行，不允许自动抢房间 |
| `projectEvent(state, envelope)` | `{state,effects,ignored}`；消费 V1 事件，重复／过时事件无展示 effect |
| `selectRun(state, runId或null)` | 相同返回结构；清除旧瞬态，恢复新运行状态并清空其未读，不重播旧气泡 |
| `parseCursor(cursor)` | 解析 `serverEpoch:seq`，非法值返回 null |

状态包括 serverEpoch、cursor、highWaterSeq、coveredThroughCursor、snapshotVersion、selectedRunId、roomGeneration，以及按 runId 隔离的运行、派工、工具、公开记录、结果去重键与未读数。公开记录只留最近 200 条，eventId 缓存最多 2048 条；完整审计和报告仍读取服务端。

## 输入与展示指令

V1 envelope 使用 PRD 的 schemaVersion=1、serverEpoch、eventId、seq、emittedAt、topicId、predictionId、runId、scope、trigger、type、payload。scope 为 live／replay，trigger 为 manual／watch。`assignment.*` 使用 assignmentId、agentInstanceId、status、resultId、summary、evidenceIds；工具使用 toolCallId（兼容 callId）、toolId、status、summary、脱敏 argumentsSummary、durationMs。

后端公开快照支持 `{runId,topicId,predictionId,status,version,scope,trigger,assignment,report?}`，也预留 assignments 数组。sync 的 payload 为 `{reset:true,snapshotVersion,coveredThroughCursor,runs,activeRuns}`；activeRuns 只有 ID 而缺 run 快照时，投影器要求补查，绝不猜测人物工作。

| effect | 接入者必须做什么 |
| --- | --- |
| `room.reset` | 按 generation 作废旧动画、气泡队列与定时器；不是修改业务状态 |
| `room.restore` | 按 run 快照显示当前席位和状态；终态／waiting 不恢复工作帧，不重播报告 |
| `actor.work`／`actor.stop` | 只驱动指定 agentInstanceId；preserveBubble=true 时不得覆盖刚完成的提示 |
| `bubble` | 使用后端公开 message／label；展示 tone 和 evidenceIds，完成提示至少可读 minVisibleMs（1700ms） |
| `tool` | 展示真实调用及返回，只有 status=ok 的 success 为 true；开始调查本身不产生工具动画 |
| `meeting`／`plan` | 根据参与实例与房间投影会议；显示公开计划摘要 |
| `forecast`／`graph`／`watch`／`resolution` | 读取对应公开版本与证据；不得据动画结束自行发布或结算 |
| `run.status`／`unread` | 更新运行状态／后台未读；后台运行不会收到人物、工具动画和气泡指令 |
| `resync.required`／`run.snapshot.required` | 请求权威同步／缺失运行快照；不补造状态 |

展示型 effect 带 runId、generation；渲染器在执行和异步回调时均校验当前房间与 generation。工具、角色、标题和长文本仍须用 textContent 等安全方式渲染。投影器只保留公开摘要字段，不转发原始模型 messages、checkpoint 或 reasoning_content；公开摘要的生成与脱敏由后端负责。

assignment.completed 的 complete 才显示成功；insufficient、blocked、failed、cancelled 使用不同非成功提示，缺失状态也不显示成功。完成报告按 assignmentId/resultId 去重，会议原文回显须携带相同 resultId；真正的新讨论用独立 messageId，可用 relatedResultId 引用旧报告。同一实例仍有其他运行中派工时，完成一项不会停止其工作。

## 流恢复与边界

消费器要求服务端在同一持久数据库内按全局 seq 顺序交付，允许序号有间隔。eventId 去重，seq 不高于已消费水位的不再进入实时投影；迟到事件的完整审计以服务端为准。有效 reset 先替换快照，将 coveredThroughCursor 设为水位，再接受后续事件。旧水位／旧快照不能覆盖当前状态；同库终态不能被快照恢复为运行中。

serverEpoch 是持久数据库身份，正常进程重启不变；身份变化要求 full reset，在此之前停止展示新动作。取消／失败使房间 generation 递增，旧 success 回调必须失效；已结束运行不接受迟到的派工成功或预测发布。完成运行保留报告的可读提示；后续 resolution.recorded 可更新结算记录。切换页面仅改变所选运行，不能取消后端任务。

V0 adapter 由后续集成实现：旧 monitor→live、auto→watch、taskId→assignmentId，并转换旧生命周期／工具／会议事件及实例 ID。旧数字 cursor 不直接使用，迁移时强制同步。本模块直接消费 V1，不兼做 V0 猜测适配。

## 后续页面开发顺序与验收

1. **M0 接真实事件**：先以真实公开快照和 SSE 接入投影器，再连接现有人物渲染。验证取消、断线、重复和旧回调失效（A04/A05/A10 的前端部分）。本批只提供纯模块测试，浏览器接入未完成。
2. **M1 任务公告栏与路由**：`/predictions`、新建题目、`/predictions/:predictionId`、`/topics/:topicId`。首页常驻目标、题型、概率／候选、期限、证据截止、最近发布和结算状态；切换三道题不串用（A01/A02/A11）。保持夜景像素房间和清晰文字导航。
3. **M2 Agent 与会议**：`/agents/:agentSpecId` 定义和版本；`/predictions/:predictionId/runs/:runId` 公开计划、工具和争议。失败不冒成功气泡，补查返回同一争议；隐藏思维链不进入页面（A03–A06/A12）。
4. **M3 收报台与黑板**：`/topics/:topicId/inbox` 展示原始新资料、来源状态、采纳与关联；`/predictions/:predictionId/world` 展示带时间、证据和反例的图。黑板不是收件箱，收件箱不冒充已核验事实（A07–A10）。
5. **M4 学习档案与预测卡**：`/learning` 展示已封存预测、真实结果、误差和经验修订，可回到具体运行与证据；与收报台具有独立标题、URL 和主操作。binary/categorical 打通发布至结算；numeric/ranked_list 仅预留，不显示可运行状态（A11/A13/A14）。
6. **各步共同验证**：深链接、返回、空任务、无资料、来源失败、认证错误、冲突重试；390px、键盘、焦点恢复、读屏与减少动态偏好（A12/A14）。像素风和真实事件绑定均属于不可省略的验收要求。

## 验证证据与尚未完成

执行 `node --test web/run-projection.test.mjs`：21 项纯模块测试覆盖房间归属、去重、水位、终态、同步、epoch 更换、运行归属冲突、工具失败、结果语义和公开字段隔离。题目契约 predictionVersion 与预测发布修订分别处理；缺少独立修订号时用事件 seq，不能因题目版本相同而漏掉新预测。它们证明客户端规则，不证明实际后端连接或界面已完成。后续还需真实 SSE／HTTP 集成、V0 adapter、浏览器动画回调检查及端到端验收；暂未修改现有应用入口或 PRD 完成状态。
