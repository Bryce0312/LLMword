# 本地交接入口（2026-11-21）

本轮按组长要求保留十类研究员，初始每题选择三类不同职责（含反证核验），允许按必要争议定向补查。成员姓名、学号和贡献表由小组后续填写。未经用户审阅通知，不更新GitHub；远端V2.0不是这批本地新功能的交付入口。

## 先运行

使用Node22.17或更高版本（本机验证22.17.1，版本提示见`.nvmrc`）。只需Node/npm；mock不需要API Key或本机Edge插件。

```powershell
npm.cmd ci
npm.cmd run cases
npm.cmd run cases:finance
npm.cmd run cases:warning
npm.cmd run cases:price
npm.cmd run start:mock
```

默认http://127.0.0.1:4173，顶部案例页包括原流程、财报和新增警告核验例子。mock模型、来源与分数均显著标记为模拟，不能作为真实准确率。真实存档可以在mock页面只读查看，标签仍是live存档，不转换成新实跑。

真实运行：`npm.cmd run start:live`，默认4174，在模型连接页保存临时Key；只在当前服务器会话内存中保存。运行数据分别放`.data/mock`和`.data/live`，不得混用。可设置`PORT`、`WORLD_DATA_DIR`启动隔离实例；本轮实际测试使用4195及`.data/delivery-closure-live`。

真实新案例脚本：`node scripts/live-warning-case.mjs --start`（自定义端口加`--base=http://127.0.0.1:4195`）。必须显式传`--start`才开始付费预测；中断后`--resume`继续同一requestId，不重复创建案例。新固定警告题上限80000tokens；研究员模型请求顺序执行而上下文仍独立，避免并发预算预留挤占报告修正。其他题保留通用并行调查。状态文件`.data/warning-live-driver.json`不含Key；此文件存在时`--start`也不会另开一题。下一批确需新题时先妥善归档原状态，不能误把旧题当新题。

## 十类角色与实际能力

| 角色 | 当前方法与能力 |
| --- | --- |
| official | 官方公告/数据、原始版本、指定域名；警告样例可直接读官方JSON |
| timeline | 首发/更正/转载与不同时间；任意语言查询、最多三路合并 |
| industry | 专业机制、条件与反例；机制推断区别于事实 |
| people | 当时身份、说话人、日期和原始场合；不沿用旧职位与旧引语 |
| statistics | 单位、口径、样本与可比期间；财务指标有受原文约束的计算工具 |
| market | 原BTC/ETH-USD现价与固定基准；严格BTC-USDT案例另接Binance现价/分钟桶，不混用口径；缺报价明确不足 |
| social | 公开社群线索及样本偏差；没有私有平台接口就不能冒称全量舆情 |
| analogy | 读取本题固定历史摘要，比较相似条件、差异和失败反例 |
| graph | 读取历史支持/反证关系，提出带出处的关系建议；不冒称完整图数据库推理 |
| verification | 检查逐条主张、原文片段、数字、时间、身份与来源独立性 |

十类方法版本为`investigation-methods-v2`，实际许可写入每次派工。五种受控问题各运行三席，累计覆盖十类，测试中均实际执行工具并完成带引用报告。真实测试记录只证明其中实际调用的团队；不声称十类均已完成真实渠道验收。

## 搜索可移植性

默认沿用DeepSeek搜索及正文读取；Agent可按主体原始语言/地区提交查询，`language`和`market`记录检索意图，不保证地理索引或来源独立。`search_news`支持`queries:[{query,language,market,engine}]`，最多三路；旧`queryZh/queryEn`仍兼容。搜索摘要永远不产生可引用证据。

Bing只作可选适配器：需要时设置`WORLD_BING_SEARCH=enabled`，再按查询选择`bing-domestic`、`bing-international`或`auto`。未启用、网络失败、验证码、非RSS或访问拒绝时记录原因并回退默认服务，不要求配置本机Edge或账户。实际跳转域名与路径记录在provenance，不把当前电脑的跳转写死，不声称两个入口就是两个独立索引；不同电脑可以得到不同可用性结果。

正文语言字段只是启发式提示；能提交某种语言的查询不等于已验证该语言全部站点。搜索引擎结果也不等于首发、独立采编或事实成立。

## 逐条证据与旧数据

应用新任务保存`groundingPolicy:quoted-claims-v1`。Worker支持/反证与主Agent发现/预测依据提供`basis:fact|inference`、`evidenceIds`及`citations:[{evidenceId,quote}]`。守卫校验本轮/本人已读、时间有效、原文确有片段及直接事实数字覆盖；单位换算/计算/未来判断标为推断。界面可展开原文片段。

该检查不是任意自然语言的语义蕴含证明，核验Agent仍须读懂片段与主张的关系。旧研究报告及预测不回写；旧request缺少新策略时保留旧验证与工具Schema，避免把旧历史冒称已做新核验。通用service构造器可显式启用新策略，应用入口已默认启用。

取得时间与正文数字分别核对。限定形式的UTC取得时间前缀可使用实际读取元数据（仅容忍不到1秒的显示舍入），不能用时间字段替收入等无关数字作证。同一正文去重时，首次取得时间保持不变，另存逐读者的实际读取时刻；旧记录不补造未知的读取时间。

## 新预测与核验规则

样例为香港天文台红色火灾危险警告。严格契约绑定固定URL、目标时点及规则：目标后5分钟内首次成功取得的完整警告JSON，WFIRE/code=WFIRER且actionCode非CANCEL即Yes；有效完整快照没有红色警告即No；读取失败、无效JSON、目标前或错过窗口均不能判No。

这是有界首次观察规则，不冒称精确秒级历史警告。新预测发布、旧证据与实际结果分开保存；结果证据不追加到原Run资料集，原概率与用量不回写。结果核验无需模型/Key，默认关闭付费监听。页面到期后提供核验按钮，或由已授权脚本在目标时点执行一次；网络失败只作有界免费重试。

上述警告规则及追加的严格BTC-USDT规则接入了结构化结果与逐份Brier。一个样本的Brier不证明总体准确率；mock分数标记为协议分数且不能计真实成绩。其他题型的通用自动结算、长期回测/校准、任意股票行情和完整时序图仍未宣称完成。

## 验证与下一位的起点

`npm.cmd run verify:collaboration`执行完整回归并更新`docs/evidence/collaboration-regression-summary.json`。最新真实结果见`docs/evidence/warning-live-validation.json`；此前财报原输出、人工复核与已知引文问题见`FINANCE_RESEARCH_REPORT.md`和`finance-live-validation.json`，新规则不替旧报告洗白。

本轮真实预测最终为85%，实际发布2026-11-21 14:34:12（上海），目标14:35:29，提前约77秒；到期完整快照为Yes，单题Brier0.0225。该条经维护重新校验原模型候选后封存，概率未改、无回填时间、无额外模型请求；三席中两份有效报告、一席失败回执。它不计为完整自动流程验收。原第一次111070tokens失败和第二次64880tokens的全部恢复过程保留；详情与内容限制见[质量收口报告](DELIVERY_STATUS_REPORT.md)。

交接时按顺序演示：一句问题与三席选择 → 实际工具与原文 → 推断/事实及补查 → 发布 → 到期结果与评分 → 失败/恢复及mock/live标识。正常三席金融样本及到期核验已由本次追加验收补齐，结论见[金融预测报告](FINANCIAL_PREDICTION_REPORT.md)；下一位优先做小规模同题对照、复核结果、演示录屏及提交材料。更复杂外部平台和全自动评分需各自明确样本与验收，不靠增加角色数量充当完成度。

源码入口：角色`investigation-profiles.mjs`，搜索`web-tools.mjs`/`news-search.mjs`，可选Bing`bing-search.mjs`，片段校验`domain/claim-grounding.mjs`，警告`weather-warning.mjs`，编排与存储`course-service.mjs`/`course-store.mjs`。

## 追加金融预测的运行与范围

`npm.cmd run cases:price`生成三席完整的mock价格闭环并保留首次真实失败与最新真实存档。真实服务中显式运行`node scripts/live-price-case.mjs --start --base=http://127.0.0.1:4196`，中断用`--resume`继续同一requestId；既有状态文件存在时不另建题。先在模型连接页保存Key；脚本本身不读取/持久化Key，不自动重开案例，不开启模型监听。新价格任务上限300000tokens，实际用量另记。当前已有案例，勿为查看存档执行--start。

严格契约选Binance BTC-USDT，USDT不是USD。原Coinbase BTC/ETH-USD工具仍保留，不能把本次交易对当其报价。固定主机公开读取无浏览器依赖；目标电脑应先检查来源可达性，来源失败保留缺口；不把本机可达误当所有网络可达，也不静默改结算来源。

三席独立初始报告后，汇总前刷新最新现价与已关闭分钟桶；基准固定，最新观察和目标后结果单列。分钟桶统计工具实际计算样本收益/波动，完整原始K线在公开证据JSON，模型只读统计摘要。到期核验不调用模型。最新状态、真实时间、Brier和用量见FINANCIAL_PREDICTION_REPORT.md。预算不是作业/Codex限制，提高上限须同时保留实际成本与失败记录。

2026-11-21 金融预测最终核验：三席完整且正常自动发布，目标后首次有效报价取得于2026-11-21T08:22:17.237Z，BTC-USDT为57718 USDT；固定基准58025.79 USDT，结果No，原Yes46%保持不变，单题Brier0.2116。六项真实流程检查全部通过；10模型/7工具/58727tokens，核验没有新增模型调用。源码哈希、原概率/证据/用量不变；桌面/手机及独立无Key副本已确认显示结果和评分。此结论属于该固定规则的流程验收，不是总体准确率或多Agent相对优势证明。未上传GitHub。
