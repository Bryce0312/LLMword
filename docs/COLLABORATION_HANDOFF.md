# 市场 Agent 与协作追溯交接

日期：2026-11-20。课程里程碑 M2，关联 A04、A06、A08、A10、A11、A12、A14。本轮范围是市场报价约束、可追溯协作展示和代表性案例；自动结算与准确率评估仍是单独的 M4 工作。

## 运行

使用支持 `node:sqlite` 的 Node；本轮验证版本为 v22.17.1。

```powershell
npm.cmd ci
npm.cmd run cases
npm.cmd run start:mock
```

打开 http://127.0.0.1:4173 ，点击顶部「协作案例」。真实环境用 `npm.cmd run start:live`，默认 http://127.0.0.1:4174 。在「模型连接」输入临时 Key，Key 留在服务端进程内存。测试选 `watch:false`，避免后台持续消费。

本地工作副本已整合 GitHub V2.0 提交 `9add50bf4392ee2f921c6e23b6a9aa7e3cfff1e0` 的环境拆分，并保留原市场补丁；未推送 GitHub。`../tmp/before-integration.zip` 是集成前十个修改文件的备份，不含密钥或运行数据库。

## 已实现

1. 首轮 BTC/ETH 市场报告须引用本人本轮取得的匹配报价。v2 增加 USD、有限正数、有效观察时间和本轮时间范围检查。错配、失败或未引用时改为 `insufficient` 并清空候选概率。双资产歧义不自动选一个资产。后续复核保持原基准。
2. 补查派工保存问题、原因、证据、父报告及请求时间，并把争议来源摘要交给研究员。旧报告、旧检查点保留兼容行为。
3. 发布可附 `decisionNotes`：逐份报告说明采纳、保留条件或未采纳及其依据。服务端拒绝其他运行的报告、报告未引用的证据、重复裁决、未来资料及对不足报告的无条件采纳。旧模型未提供说明时如实显示缺失。
4. `publicRun.collaboration` 从持久记录生成，展示分工、独立发现、补查前后报告、新增引用和最终裁决。不读取模型内部消息，不把答复提交等同争议解决，不把概率变化等同准确率提高。
5. 任务页新增协作面板，跟随当前选中运行，支持来源链接和本轮 JSON 导出。后台检查与答案来源轮次继续独立显示。
6. `npm run cases` 实际执行离线工具和编排，生成 `web/demo/cases.json`，页面可直接审阅七个案例及其多阶段快照。所有案例显著标记为 mock/replay，合成 token 不是实际账单。

## 七个可复现案例

| 案例 | 核验重点 |
| --- | --- |
| BTC 下跌 | 固定 BTC-USD 基准、三人独立报告、补查、逐份裁决 |
| ETH 上涨 | 不能误取 BTC，报价引用归属正确 |
| 错资产报价 | BTC 题只取到 ETH 时市场报告降级、不能计分 |
| 报价失败 | 不伪造价格，保留条件估计及缺口 |
| 黄金 | 工具能力不足如实展示，不冒充已核验基准 |
| 新正文／重复正文 | 新证据唤醒两席并携带记忆；原基准不变；重复不发布 |
| 鉴权失败恢复 | 停止无效请求，同题恢复，原失败历史保留 |

每个案例还验证关闭并重开 SQLite 后记录一致。案例模型回复是可复现协议适配器，不证明真实模型自主推理或前瞻准确率。现实案例不能保证必然产生分歧或新消息。

## 下一位同学的入口

- 报价约束：`server/course/market-report.mjs`；报价来源：`market-quote.mjs`。
- 派工与协调：`server/course/course-service.mjs`；候选契约：`course-contracts.mjs`。
- 发布守卫：`server/course/course-store.mjs`；公开投影：`collaboration.mjs`。
- 界面：`web/course-collaboration.js`、`course-examples.js`。
- 案例：`scripts/course-cases.mjs`；回归：`server/course/collaboration.test.mjs`。

最终课堂演示建议：先用一条真实记录说明角色与来源，再用明确标注的离线案例展示补查、新证据、去重和恢复。保留一次真实失败及其资料限制，避免将离线案例混入准确率表。录像最长十分钟；成员贡献需由小组填写实际姓名。

## 验证记录

已运行定向回归及全量回归；本机 HTTP 测试需要允许回环访问，沙箱内的 `fetch failed` 属于运行环境限制，不能计作通过。实际 DeepSeek 记录与最终测试汇总见同目录的 `COLLABORATION_VALIDATION.md`。
