import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { makeTimeContext } from './course-context.mjs'
import { createCourseStore } from './course-store.mjs'

// Independent acceptance checks: this author did not implement the course orchestrator.
const NOW='2026-11-19T17:00:00.000Z'
async function setup(t, { mismatchQuotePair = false } = {}) {
  const folder=await mkdtemp(join(tmpdir(),'llmword-usability-audit-'))
  let revision=1, major=false
  const messages=[]
  const mock=createCourseMockProvider()
  const provider={...mock,async complete(input){
    messages.push(structuredClone(input.messages))
    const response=await mock.complete(input)
    if(mismatchQuotePair) for(const call of response.message?.tool_calls||[]) if(call.function.name==='get_market_quote') call.function.arguments=JSON.stringify({pair:'ETH-USD'})
    return response
  }}
  const workbench=createWorkbenchService({path:join(folder,'domain.sqlite'),now:()=>NOW})
  const sourceTools=createWebResearchGateway({env:{WORLD_SEARCH_PROVIDER:'fixture'},now:()=>NOW,fixturePages:()=>[
    {url:'https://example.com/course-lab/official',title:'虚构公开状态',text:`【虚构测试资料】BTC市场与@elonmusk账号目前无异常。${major?'重大冲突 major contradiction：旧说法被新公告推翻。':'普通更新：没有正式异常公告。'}版本${revision}。`},
    {url:'https://example.com/course-lab/news',title:'虚构新闻线索',text:`【虚构测试资料】独立描述仍待核验，版本${revision}。`},
    {url:'https://example.com/course-lab/verification',title:'虚构反证',text:`【虚构测试资料】没有充分证据保证未来结果，版本${revision}。`},
  ]})
  const service=createCourseService({path:join(folder,'course.sqlite'),workbench,sourceTools,provider,modelMode:'mock',now:()=>NOW})
  t.after(async()=>{await service.close();workbench.close();await rm(folder,{recursive:true,force:true})})
  return {service,messages,change(large=false){revision++;major=large}}
}
async function run(service,question,extra={}) {
  const created=service.createRequest({question,horizonHours:24,watch:false,...extra})
  await service.idle()
  const result=service.getRequest(created.requestId)
  assert.equal(result.run.status,'completed',JSON.stringify({error:result.run.error,message:result.message}))
  assert(result.forecast,'a vague but interpretable prompt should reach a bounded estimate')
  return result
}

test('casual social and price questions complete with explicit assumptions and different actual research teams',async t=>{
  const {service}=await setup(t)
  const social=await run(service,'马斯克会不会发推特')
  const crypto=await run(service,'比特币回升')
  const team=x=>x.run.assignments.filter(a=>!a.followUp).map(a=>a.agentSpecId).sort()
  assert.equal(team(social).length,3);assert.equal(team(crypto).length,3)
  assert.notDeepEqual(team(social),team(crypto))
  assert(team(social).includes('social'));assert(team(crypto).includes('statistics'))
  for(const result of [social,crypto]) {
    assert(result.normalized.defaultAssumptions.length>0)
    assert.equal(Date.parse(result.normalized.targetAt),Date.parse(NOW)+24*3600000)
    assert.equal(result.forecast.scoringEligible,false,'synthetic evidence is never a real scored forecast')
    assert(!JSON.stringify(result).includes('reasoning_content'))
  }
  assert(social.normalized.defaultAssumptions.some(s=>s.includes('@elonmusk')))
  assert.equal(crypto.normalized.baseline.value,100)
  assert.equal(crypto.normalized.baseline.currency??crypto.normalized.baseline.unit,'USD')
  assert(crypto.normalized.baseline.evidenceId)
  const marketReport=crypto.run.assignments.find(a=>a.roleId==='market'&&!a.followUp)?.report
  assert.equal(marketReport?.status,'complete')
  assert(marketReport.evidenceIds.includes(crypto.normalized.baseline.evidenceId))
})

test('an available quote for another asset cannot become a verified price baseline',async t=>{
  const {service}=await setup(t,{mismatchQuotePair:true})
  const result=await run(service,'比特币回升')
  assert.notEqual(result.normalized.baseline?.value,20,'ETH quote must never become a BTC baseline')
  assert.equal(result.normalized.conditionalOnly,true,'without a matching price, only a clearly conditional estimate is allowed')
  assert.equal(result.forecast.scoringEligible,false)
  const marketReport=result.run.assignments.find(a=>a.roleId==='market'&&!a.followUp)?.report
  assert.equal(marketReport?.status,'insufficient','market research must not certify a BTC baseline from an ETH quote')
  assert.match(marketReport.missingEvidence.join(' '),/BTC-USD/)
})

test('gold and silver direction questions stay conditional without a supported structured price baseline',async t=>{
  const {service}=await setup(t)
  for(const question of ['黄金会跌吗','金价会涨吗','白银会下跌吗','Will gold fall?','Will silver rise?']) {
    const result=await run(service,question)
    assert.equal(result.normalized.conditionalOnly,true,question)
    assert.equal(result.normalized.baseline?.value,null,question)
    assert.equal(result.normalized.baseline?.verified,false,question)
    assert.equal(result.normalized.researchBasis.mode,'conditional')
    assert.equal(result.forecast.kind,'conditional_estimate')
    assert.equal(result.forecast.scoringEligible,false)
    assert.match(result.normalized.resolutionRule,/没有可核实的数值基准/)
    assert.match(result.normalized.resolutionRule,/不作为可计分/)
  }
})

test('a supported verified price decline uses below the fixed baseline while a rise still uses above',async t=>{
  const {service}=await setup(t)
  for(const [question,pair,comparison] of [['比特币会跌吗','BTC-USD','低于'],['Will ETH drop?','ETH-USD','低于'],['比特币会上涨吗','BTC-USD','高于']]) {
    const result=await run(service,question)
    assert.equal(result.normalized.baseline.pair,pair)
    assert.equal(result.normalized.baseline.verified,true)
    assert.equal(result.normalized.conditionalOnly,false)
    assert(result.normalized.resolutionRule.includes(comparison+'固定基准'),question)
    assert(!result.normalized.resolutionRule.includes((comparison==='低于'?'高于':'低于')+'固定基准'),question)
  }
})

test('UTC midnight crossing has a server-generated local label and strict user rules remain fixed',async t=>{
  const time=makeTimeContext({now:NOW,createdAt:NOW,targetAt:'2026-11-20T17:00:00.000Z',timezone:'Asia/Shanghai'})
  assert.match(time.targetAtLocalLabel,/2026-11-21 01:00:00/)
  assert.match(time.targetAtLocalLabel,/UTC\+08:00/)
  const {service}=await setup(t)
  const rule='【测试规则】只以指定官方页面的明确公告为准，转载不算。'
  const target='2026-11-20T17:10:00.000Z'
  const result=await run(service,'严格测试：科技展会开幕吗',{mode:'strict',strict:{targetAt:target,resolutionRule:rule,resolutionSourceUrl:'https://example.com/course-lab/official',timezone:'Asia/Shanghai'}})
  assert.equal(Date.parse(result.normalized.targetAt),Date.parse(target));assert.equal(result.normalized.resolutionRule,rule)
})

test('ordinary news wakes a smaller team and actually supplies historical memory without changing the fixed baseline',async t=>{
  const {service,change,messages}=await setup(t)
  const first=await run(service,'比特币回升')
  const baseline=structuredClone(first.normalized.baseline)
  const after=messages.length;change()
  service.check(first.requestId);await service.idle()
  const next=service.getRequest(first.requestId)
  assert.equal(next.run.status,'completed',JSON.stringify(next.run.error))
  assert.equal(next.run.triage.kind,'local')
  assert.equal(next.run.assignments.filter(a=>!a.followUp).length,2)
  assert.equal(next.run.memory.previousForecast.forecastId,first.forecast.forecastId)
  assert(next.run.memory.reportCount>=3)
  const newInputs=messages.slice(after)
  const supervisor=newInputs.filter(history=>history.some(m=>m.role==='user'&&m.content.includes('course-main')))
  const workers=newInputs.filter(history=>history.some(m=>m.role==='user'&&m.content.includes('agentSpecId')))
  assert(supervisor.some(input=>JSON.stringify(input).includes(first.forecast.forecastId)),'supervisor must actually receive memory')
  assert(workers.some(input=>JSON.stringify(input).includes(first.forecast.forecastId)),'at least one delegated worker must receive memory')
  assert.deepEqual(next.normalized.baseline,baseline)
  assert.equal(next.forecasts[0].forecastId,first.forecast.forecastId)
})

test('material conflict convenes the saved team; a duplicate check cannot add a fake probability point',async t=>{
  const {service,change}=await setup(t)
  const first=await run(service,'马斯克会不会发推特')
  change(true);service.check(first.requestId);await service.idle()
  const major=service.getRequest(first.requestId)
  assert.equal(major.run.status,'completed',JSON.stringify(major.run.error))
  assert.equal(major.run.triage.kind,'team')
  assert.equal(major.run.assignments.filter(a=>!a.followUp).length,3)
  const count=major.forecasts.length
  service.check(first.requestId);await service.idle()
  const duplicate=service.getRequest(first.requestId)
  assert.equal(duplicate.run.triage.kind,'no_change')
  assert.equal(duplicate.forecasts.length,count)
  assert.equal(duplicate.run.assignments.length,0)
})

test('live follow-up evidence cannot turn an unscoreable question or synthetic baseline into a scored forecast',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'llmword-eligibility-audit-'))
  const store=createCourseStore({path:join(folder,'course.sqlite'),now:()=>NOW})
  t.after(async()=>{store.close();await rm(folder,{recursive:true,force:true})})
  for(const [index,baseline] of [null,{value:100,synthetic:true}].entries()) {
    const request=store.createRequest({question:'资格边界测试'+index,modelMode:'live',sourceMode:'live',providerIdentity:'current-provider'})
    const runId=request.activeRunId
    const prediction={predictionId:'audit-prediction-'+index,version:1,type:'binary',status:'ready',validation:{ready:true},
      scoringEligible:baseline?true:false,targetAt:'2026-11-20T17:00:00.000Z',forecastClosesAt:'2026-11-20T17:00:00.000Z',resolutionRuleVersion:1,resolutionSource:{url:'https://example.com/audit-original'}}
    store.saveRun(runId,{status:'running',topicId:'audit-topic-'+index,predictionId:prediction.predictionId,predictionVersion:1})
    store.updateRequest(request.requestId,{normalized:{...prediction,baseline}})
    const ids=[]
    for(const role of ['statistics','verification']) {
      const assignmentId='audit-assignment-'+index+'-'+role
      store.createAssignment(runId,{assignmentId,agentSpecId:role,roleId:role,followUp:false})
      store.saveAssignment(assignmentId,{status:'completed',report:{status:'complete',summary:'真实回执格式的测试报告'}})
      const evidenceId='audit-evidence-'+index+'-'+role;ids.push(evidenceId)
      store.recordEvidence(runId,{evidenceId,topicId:'audit-topic-'+index,predictionId:prediction.predictionId,title:'当前材料',text:'隔离测试，不是真实新闻。',url:prediction.resolutionSource.url,contentHash:'audit-body-'+role,sourceMode:'live',publishedAt:'2026-11-19T16:00:00.000Z'},assignmentId)
    }
    const published=store.publishForecast(runId,{probabilityYes:0.6,summary:'仅检验资格保护',evidenceIds:ids},prediction)
    assert.equal(published.scoringEligible,false)
  }
})
