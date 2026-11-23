# M0 独立校验记录

校验日期为 2026 年 11 月 18 日。依据为项目 `AGENTS.md`、PRD 0.2 和 `DEVELOPMENT_PLAN.md`。本轮覆盖 SQLite 存储、模型协议、Worker 恢复以及随后接入的研究服务。校验者没有修改上述主实现，没有读取本地凭据或环境配置。

## 当前结论

SQLite 与 Worker 的模块级验收通过 19 项组合复验，另有 4 项独立审计用例全部通过。审查发现的原始工具消息被修改、已完成工具回执因预算阻塞而无法恢复、恢复时更换固定模型三项缺陷，均已由实现负责人修复并复验。完成状态与完成事件的提交边界也通过独立进程验证。

研究服务的恢复、取消、多运行隔离与公开输出已独立复验，实际 HTTP 与 SSE 的 M0 端到端测试也已通过。模拟 HTTP 协议测试使用固定假凭据和本机服务；真实 DeepSeek 的 M0 原生工具循环须单独记录，旧版真实会议记录不能替代此项。

## 发现、处置与复验

| 编号 | 问题与影响 | 证据及处置 | 关联验收 |
| --- | --- | --- | --- |
| QA01 | `pendingToolCalls` 与原始 assistant 消息共用调用数组，逐次移除待执行动作会同时清空消息中的 `tool_calls`。后续请求包含工具结果，却缺少匹配的原始工具调用。 | 本机 HTTP 协议测试初次在 `worker-loop.test.mjs` 检查 `assistant.tool_calls[0].id` 时失败。负责人改为复制待执行数组，完整原始消息保留在历史中。升权复验通过。 | A04、A10 |
| QA02 | 工具已成功并写入 SQLite 回执，Worker 检查点仍停在待执行状态时发生中断。恢复在读取回执前再次扣工具预算，末次预算会直接报 `BUDGET_EXHAUSTED`。 | 新增独立 `server/runtime/audit.test.mjs`。测试使用实际 SQLite 回执和已保存检查点，初次复现失败。负责人持久化在途调用的预算预留后，恢复读取回执并保持处理器仅执行一次，测试通过。 | A04、A10、A14 |
| QA03 | 完成检查点提交与随后发送 `tool.completed`、`assignment.completed` 分离，存在完成状态已经落库而完成事件尚未写入的中断窗口。已完成 Worker 恢复时会直接返回报告。 | 集成负责人改为同事务保存检查点与派生完成事件，后续回调去重。独立子进程在完成事件回调中立即退出，另一数据库连接确认完成状态、三个工具完成事件与派工完成事件均已保存。重启后不调用模型，保留原完成事件 ID，只补出唯一运行结束记录。通过。 | A10、A12 |
| QA04 | 恢复保存的 mock 运行时直接使用启动后的新全局 provider，忽略已固定的模型模式与引用。旧运行会调用替换的 live 模型，却仍显示 mock。 | 独立 `audit.test.mjs` 第二项使用两个注入 provider 和真实临时数据库复现，替换 provider 曾被调用一次。负责人加入固定配置检查后，变更模型进入 waiting，重复唤醒不重复写等待事件；恢复原配置可继续完成并清除配置错误。通过。 | A02、A10、A14 |
| QA05 | 原工具协议校验只检查调用 ID 的真假值，数字、对象和纯空格等非法 ID 可进入执行阶段。 | 负责人补充字符串、非空和长度检查。独立重跑新增回归，数字、对象、空串、纯空格及超长 ID 均在处理器执行前返回 `MODEL_PROTOCOL`。通过。 | A04、A05、A14 |

## 已执行命令与结果

在项目根目录运行以下命令，Node 为 v23.5.0。

```powershell
node --test server/core/store.test.mjs
```

7 项通过。覆盖真实数据库重开、独立子进程恢复、幂等键冲突、事务回滚、另一连接取消、审计回执、版本冲突以及跨运行回执隔离。

```powershell
node --test server/runtime/audit.test.mjs
```

QA02 修复前 1 项失败，错误为 `BUDGET_EXHAUSTED`。修复后进入下列组合复验并通过。

```powershell
node --test server/core/store.test.mjs server/runtime/audit.test.mjs server/runtime/model-provider.test.mjs server/runtime/worker-loop.test.mjs
```

19 项通过。命令在允许本机回环连接的执行环境运行。原沙盒中的 HTTP 模拟协议测试因网络访问限制失败，升权后才显现 QA01，修复后完整通过。

随后补充 QA04 的服务级恢复回归，`node --test server/runtime/audit.test.mjs` 为 1 项通过、1 项失败。此项失败发生在本地注入 provider，没有调用真实模型服务。

修复和补充独立进程用例后，再次执行该审计文件，最终为 4 项通过、0 项失败。第四项使用合成凭据和私有协议标记，确认私有检查点实际保存模型字段，而公开运行、运行列表、权威快照、历史事件及实时事件均不导出 `messages`、`checkpoint`、`reasoning_content` 或合成凭据。

```powershell
node --test server/runtime/research-service.test.mjs server/runtime/audit.test.mjs
```

10 项通过，包含 6 项研究服务测试与 4 项独立审计。服务实际完成两种本地处理器并持久化，关闭后从同一数据库恢复，三个运行使用同名材料和工具调用编号时仍保持各自正文与事件归属，重复创建和同题并发按契约拒绝。取消后忽略 AbortSignal 的模型响应不能形成迟到报告。

```powershell
node --test runtime-http.test.mjs
```

1 项通过。在允许本机回环的执行环境中启动真实临时 Node 服务，子进程显式清空模型密钥。测试验证异步创建返回 202、正式概率为空的 M0 报告、公开快照、SSE 初次重置、持久 `serverEpoch:seq` 游标补收、唯一完成记录、外部 Origin 拒绝和幂等输入冲突。它验证本机网络协议，没有调用 DeepSeek。

```powershell
node --test --test-name-pattern='native tool call IDs' server/runtime/worker-loop.test.mjs
```

1 项通过，用于独立复验 QA05 的五种非法调用 ID。

权限测试验证角色、派工和运行工具集合的交集，越权处理器不会执行。工具错误不能引入证据，报告不能引用未取得的材料。取消测试中，忽略信号的处理器迟到返回不会更新 Worker 报告或证据。消息协议测试核对两种实际处理器、匹配的 `tool_call_id`、原始 assistant 消息和私有协议字段的隔离。

## 集成复验与范围边界

以下项目在完整服务验收中逐项补充结果。

- 完成检查点与完成事件具有同一持久提交边界，重启补收不遗漏完成投影。独立进程验证已通过。
- 取消后的迟到处理器结果只保留审计回执，业务状态与公开成功事件不变。存储与 Worker 层已通过，服务入口也验证了迟到模型响应不会提交报告；内置两种处理器为本地只读操作。
- 创建请求重试、三份不同材料运行并存、重新打开数据库和服务恢复，经实际研究服务入口验证通过。
- 模拟模式、真实模型模式、M0 技术报告和正式事件预测在 API 中准确标记。

`server/v1-http.mjs` 的静态审查确认运行查询使用公开投影，SSE 读取公开事件日志；没有原始模型消息或私有检查点导出路由。上述 HTTP 测试补充了实际连接与游标续传证据。

M0 为单 Worker 工具循环技术入口。Supervisor、通用题目 CRUD、十类角色实际派工、时序图、正式预测发布及结算继续由对应里程碑验收。研究服务已加入同一验证问题单活跃运行的检查。多 Worker 引入前还应为模型工具调用编号确定派工命名空间，当前回执主键以运行与工具调用编号构成。

SQLite 使用本机 `node:sqlite`，运行时仍给出 experimental 提示。此次证据只覆盖 Node v23.5.0。新入口须明确所需运行时或提供能力检查，旧入口的 Node 20 兼容性由隔离加载保持。

LangGraph 验证已交由另一开发包在 `work/m0-langgraph` 独立执行，结果以 `M0_FRAMEWORK_DECISION.md` 为准。内存检查点、磁盘持久恢复及取消分别记录。
