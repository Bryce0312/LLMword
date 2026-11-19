# M0 候选框架验证与选型

核验日期为 2026 年 11 月 18 日，依据 PRD 0.2 第 10、12、13 节和 DEVELOPMENT_PLAN B0。此项为独立框架实验，关联 A04、A09、A10、A14 的技术前提。应用验收仍需由实际运行服务、真实模型和持久业务存储的集成记录证明。

## 本轮决策

**建议本阶段使用正在集成的 Node 显式状态机与原生 SQLite，LangGraph JS 保留为候选。** LangGraph 的工具节点、内存等待与恢复、错误恢复、协作取消均已有本机运行证据。候选 SqliteSaver 在初始化时遇到原生模块缺失，本轮磁盘恢复验证尚未执行。

采用候选框架还需接通业务终态守卫、持久工具回执及恢复后的事件投影。实际实验显示，节点恢复会重放 interrupt 之前的代码，AbortSignal 也不能撤回工具已经产生的外部副作用。现阶段替换执行器会增加一组尚未验收的检查点适配工作。PRD 第 12 节允许按相同领域契约推进显式状态机，因此先完成可验证的业务闭环，再比较执行器替换收益。

这次环境结果只证明当前安装方式下 SqliteSaver 未初始化成功。LangGraph 官方提供 SqliteSaver 磁盘检查点能力，后续可在原生绑定可用的环境中重新运行同一探针。[官方持久化说明](https://docs.langchain.com/oss/javascript/langgraph/persistence)

## 环境与可复现入口

实验目录为工作区根目录下的 `work/m0-langgraph`，独立于应用的 package.json。主 Agent 从官方 npm 源安装固定版本并使用 `--ignore-scripts`。本次实验读取已安装包，未执行安装脚本、远程工具或模型调用。

| 项目 | 实测值 |
| --- | --- |
| Node / 平台 | v23.5.0 / win32-x64 |
| @langchain/langgraph | 1.7.5，MIT，包声明 Node ≥18 |
| @langchain/langgraph-checkpoint-sqlite | 1.1.1，MIT，包声明 Node ≥18 |
| @langchain/langgraph-checkpoint | 实际解析为 1.2.3 |
| @langchain/core | 实际解析为 1.4.1，包声明 Node ≥20 |
| better-sqlite3 | 实际解析为 12.11.1，MIT |

安装快照保存在实验目录的 `package.json` 与 `package-lock.json`，许可证保留在安装包中。复现时在该目录运行下列命令。已有依赖时可从第二行开始。

```powershell
npm.cmd ci --ignore-scripts --registry=https://registry.npmjs.org
node --test --test-reporter=tap spike.test.mjs
node disk-spike.mjs
```

实验文件为 [核心断言](../../../work/m0-langgraph/spike.test.mjs)、[核心 TAP 记录](../../../work/m0-langgraph/core-test.tap)、[磁盘探针](../../../work/m0-langgraph/disk-spike.mjs)、[磁盘结果](../../../work/m0-langgraph/disk-result.json)。磁盘探针遇到当前环境缺口时输出 `environment_unverified` 并设置退出码 2；测试运行器可能对外统一显示为非零失败码，判读以结果 JSON 和错误阶段为准。

## 实际结果

核心实验 **9 项断言通过，0 失败**，运行约 1.65 秒。部分断言用于复现能力边界，断言通过不能直接换算为相应应用验收全部通过。

| 场景 | 观测与断言 |
| --- | --- |
| 两种工具处理器 | ToolNode 实际执行本地证据处理器及计算处理器，两份 ToolMessage 分别匹配原 tool_call_id，计算结果为 0.7。工具请求由测试构造 |
| 等待及恢复 | interrupt 返回等待载荷，getState 显示待执行节点。使用同一个 MemorySaver 重建编译图后，通过 Command resume 完成报告，已完成 collect 节点只运行一次 |
| 线程隔离 | 两个 thread_id 分别等待，第二个运行没有继承第一个报告 |
| 内存边界 | 换成全新的 MemorySaver 后旧状态消失。该项只验证 RAM 检查点逻辑 |
| 协作取消 | 节点收到 AbortSignal，计时器拒绝后下游发布次数为零，取消后本地修改次数为零 |
| 不配合取消的工具 | 工具忽略 signal，延迟完成的外部修改仍发生一次，下游节点未发布。取消调用者无法撤回该修改 |
| 取消后恢复 | 用新调用且不带已中止 signal 恢复同一检查点，执行可以继续并发布。业务 cancelled 终态需另行持久化和校验 |
| interrupt 节点重放 | interrupt 前的副作用从一次增加为两次；加应用拥有的幂等键后保持一次。示例回执使用 Map，仅验证键逻辑 |
| 节点失败恢复 | 第二节点首次抛出注入异常，invoke null 后重试成功。已完成第一节点保持一次，失败节点共运行两次 |

官方文档明确，回答 interrupt 时节点从头重新执行；错误恢复使用 null 输入，回答等待使用 Command resume。示例测试依此构造。[官方 interrupt 规则](https://docs.langchain.com/oss/javascript/langgraph/interrupts) · [官方检查点与继续执行规则](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)

磁盘探针原计划启动两个独立 Node 进程，第一进程保存等待检查点后退出，第二进程重新打开数据库并恢复，同时检查 SQLite 文件头、进程 ID 和 collect 的执行次数。本次在第一进程创建 `SqliteSaver.fromConnString` 时报告 `Could not locate the bindings file`，搜索目标为 `better_sqlite3.node`。错误发生于 better-sqlite3 原生绑定加载阶段，与忽略安装脚本后尚未生成绑定的状态一致。尚未进入图运行及数据库恢复阶段，后续可复用探针继续验证。

## 最小替换边界

保留应用拥有的主题、预测题、运行、派工、证据、图、工具账本、预测发布和事件日志。LangGraph 仅接管某个 assignment 或一次 Supervisor 循环的控制流，经过一个执行器适配层接入。

| 适配动作 | 应用需提供的约束 |
| --- | --- |
| start | 输入 runId、assignmentId、固定模型与工具配置、输入快照及预算，建立唯一检查点映射 |
| resume | 从业务状态核验可恢复性，再加载对应检查点；等待回答和错误重试采用不同调用方式 |
| cancel | 先写业务取消状态，传递 AbortSignal；下次恢复及任何写入再次检查终态和版本 |
| run node/tool | 通过现有工具网关执行，沿用权限、超时、预算与稳定 tool_call_id，保存原始模型响应及匹配结果 |
| persist progress | 业务事务生成权威事件，SSE 在提交后发送；框架进度事件可作为投影输入 |

图中的 thread_id 必须对应隔离的执行上下文，映射记录由应用保存。补查派工、同主题的其他预测题及新一轮研判分别分配范围，避免复用会话状态。图检查点保存执行位置，业务数据及事件日志决定已提交结果。

副作用提交以稳定执行键和输入摘要查重。模型响应及其 tool_call_id 应在执行前记账，恢复重用该响应或回执。对于本地数据库写入，将业务修改、工具回执和事件置于同一事务。远程写操作另需供应商幂等键或结果核对，重放策略按工具属性定义。

## 后续验收门槛

替换前需在可加载原生绑定的环境中，完成独立进程磁盘等待/恢复，再验证崩溃发生在工具执行及回执写入之间的恢复。随后以应用的持久取消标记拦截迟到结果与取消后恢复，校验重连事件只出现一次、运行上下文隔离和领域预算累计。

A04 的本地处理器适配已有证据，真实 DeepSeek 自主选择工具及协议消息回填仍由模型与集成验证负责。A09 的 LangGraph 磁盘重启能力当前为环境待验证。A10、A14 的框架级边界已复现，应用级通过结论依赖持久账本、提交守卫和故障集成测试。本报告未修改 server、web 或主 package。
