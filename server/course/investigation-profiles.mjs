export const INVESTIGATION_METHODS = Object.freeze({
  official: '追到正式公告或原始数据，区分正式版本、草案与媒体转述；域名与发布日期不足以证明主张，逐条摘录支持片段。',
  timeline: '区分发生、发布、更新、抓取时间；按主体原始语言和问题相关地区检索，追首发、更正与转载链，不固定只用中英文。',
  industry: '解释机制、适用条件和反例；行业常识与已核实事实分开。公开来源不足时保留假设，不捏造专有资料。',
  people: '核对同名对象、发言当时职位、日期、场合及组织关系；优先公告或原始讲话，旧身份与旧引语不能移用于当前。',
  statistics: '注明样本、时段、单位与口径；有可用计算工具才声称执行，推导列方法，样本不足不能声称校准或准确率已验证。',
  market: '区分现货、合约概率与模型概率；引用实际取得的匹配报价；交易时段或对应资产工具未接通时保留缺口。',
  social: '只使用可公开读取的社群材料，记录平台、作者与时刻，区分声量和独立证据；无私有平台权限就明确不能代表全体用户。',
  analogy: '先列可比较条件、关键差异与失败反例；用inspect_research_memory查看适用历史线索，旧材料须本轮重读，不把后验结果倒灌。',
  graph: '用inspect_research_memory检查已有支持/反证关系；仅提出带来源和条件的关系，不冒称已执行数据库更新或得出统计因果。',
  verification: '逐条核对原文片段是否真正支持主张，检查数字、说话人、时段、语言版本和来源独立性；不要只检查引用编号存在。',
})
export const investigationProfile = (roleId) => ({ version: 'investigation-methods-v2', roleId, instructions: INVESTIGATION_METHODS[roleId] + ' 查询可用任意语言，按主体和地区选择必要检索；search_news可提交queries，search_web的language/market只是查询意图。默认服务不依赖本机浏览器；Bing可选且未启用时正常回退，不绕过验证码或登录。' })
