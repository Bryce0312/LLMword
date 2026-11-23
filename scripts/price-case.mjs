import assert from 'node:assert/strict'
import { mkdtemp,rm,mkdir,writeFile,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCourseService } from '../server/course/course-service.mjs'
import { createCourseMockProvider } from '../server/course/course-mock-provider.mjs'
import { createWorkbenchService } from '../server/domain/workbench-service.mjs'
import { createWebResearchGateway } from '../server/course/web-tools.mjs'
import { groundingPolicy } from '../server/domain/claim-grounding.mjs'
import { PRICE_URL,PRICE_RULE,readPriceSnapshot } from '../server/course/market-resolution.mjs'

export function priceQuestion(targetAt) {return {question:'在固定目标时点后的首次有界观察中，Binance BTC-USDT现价是否高于本轮固定基准？',mode:'strict',watch:false,
  strict:{targetAt,resolutionSourceUrl:PRICE_URL,resolutionRule:PRICE_RULE,timezone:'Asia/Shanghai'}}}

export async function runPriceCase({value=101,incompleteVerification=false,lateSummary=false}={}) {
  const folder=await mkdtemp(join(tmpdir(),'price-acceptance-')),now=()=>at
  let at='2026-11-21T00:00:00.000Z',reads=0,sourceMode='failure'
  const workbench=createWorkbenchService({path:join(folder,'domain.sqlite'),now}),fixture=createCourseMockProvider()
  let delayed=false
  const provider={...fixture,async complete(input){const response=await fixture.complete(input); if(lateSummary&&!delayed&&response.message.tool_calls?.some(c=>c.function.name==='propose_forecast')){at='2026-11-21T00:03:00.000Z';delayed=true};if(incompleteVerification && input.messages.some(m=>m.role==='user' && m.content.includes('"agentSpecId":"verification"'))) for(const call of response.message.tool_calls||[]) if(call.function.name==='submit_report'){const args=JSON.parse(call.function.arguments);args.status='insufficient';call.function.arguments=JSON.stringify(args)};return response}}
  const open=()=>createCourseService({path:join(folder,'course.sqlite'),workbench,provider,evidencePolicy:groundingPolicy,now,
    sourceTools:createWebResearchGateway({env:{WORLD_SEARCH_PROVIDER:'fixture'},now}),
    priceReader:async options=>{reads++;if(sourceMode==='failure')throw Error('controlled source error');const source=await readPriceSnapshot(options);source.marketQuote.value=value;const raw=JSON.parse(source.text);raw.value=value;raw.rawSpot.price=String(value);source.text=JSON.stringify(raw);
      if(sourceMode==='wrong-pair')source.marketQuote.pair='ETH-USD';if(sourceMode==='wrong-url')source.url='https://example.com/other';if(sourceMode==='mode-wash')source.sourceMode='live';if(sourceMode==='invalid')source.text='{}';return source}})
  let service=open()
  try{
    const request=service.createRequest(priceQuestion('2026-11-21T00:30:00.000Z'));await service.idle();const before=service.getRequest(request.requestId)
    if(incompleteVerification){assert.equal(before.forecast,null);return {rejected:true,error:before.run.error}}
    assert.equal(before.run.status,'completed',JSON.stringify({error:before.run.error,roles:before.run.assignments.map(a=>({role:a.roleId,status:a.status,error:a.error}))}))
    assert.equal(before.normalized.temporalPolicy,'at_target');assert.equal(before.forecast.reviewRequired,false);assert(!before.forecast.publicationMode)
    assert.deepEqual(before.run.assignments.map(a=>a.roleId).sort(),['market','statistics','verification'])
    assert(before.run.assignments.every(a=>a.status==='completed'&&a.report.status==='complete'))
    assert.equal(before.forecast.baseline.value,100);assert.equal(before.forecast.baseline.pair,'BTC-USDT')
    assert.equal(before.budget.maxTotalTokens,service.getSettings().predictionBudget.maxTotalTokens)
    assert(before.run.evidence.some(source=>source.marketQuote&&source.readBy.includes('main')))
    assert(before.run.evidence.some(source=>source.marketHistory&&source.readBy.includes('main')))
    if(lateSummary){assert.equal(before.forecast.currentReference.observedAt,at);assert.equal(before.forecast.baseline.observedAt,'2026-11-21T00:00:00.000Z')}
    const sealed=JSON.stringify([before.forecast,before.run.evidence,before.run.usage])
    await assert.rejects(service.resolve(request.requestId),{code:'RESULT_NOT_AVAILABLE'});assert.equal(reads,0)
    at='2026-11-21T00:36:00.000Z';await assert.rejects(service.resolve(request.requestId),{code:'RESOLUTION_WINDOW'});assert.equal(reads,0)
    at='2026-11-21T00:30:01.000Z'
    await assert.rejects(service.resolve(request.requestId),{code:'RESULT_SOURCE_UNAVAILABLE'});assert.equal(service.getRequest(request.requestId).result,null)
    for(const kind of ['wrong-pair','wrong-url','mode-wash','invalid']){sourceMode=kind;await assert.rejects(service.resolve(request.requestId));assert.equal(service.getRequest(request.requestId).result,null)}
    sourceMode='valid';const result=await service.resolve(request.requestId),after=service.getRequest(request.requestId)
    assert.equal(result.outcome,value>100?1:0);assert.equal(result.observedValue,value);assert.equal(result.scoringEligible,false)
    assert(result.scores.every(s=>!s.scoringEligible));assert.equal(sealed,JSON.stringify([after.forecast,after.run.evidence,after.run.usage]))
    const count=reads;assert.deepEqual(await service.resolve(request.requestId),result);assert.equal(reads,count)
    assert.throws(()=>service.check(request.requestId),{code:'REQUEST_CLOSED'})
    await service.close();service=open();assert.deepEqual(service.getRequest(request.requestId).result,result)
    return {version:1,id:'btc-bounded-mock',title:'BTC短窗口预测：三席到结果核验',mode:'mock',notAccuracyBenchmark:true,question:before.question,
      checks:['市场/统计/核验三席全部完成并各自读取现价','已关闭分钟桶与逐条原文片段','市场席固定基准且正常自动发布','目标前/错过观察窗口不读取结果','来源失败、错资产、地址、模式及坏正文不能判No','涨/平/跌按严格比较规则且模拟不计真实成绩','原预测/证据/用量不变，重复核验幂等','结算后禁止再开轮且数据库重开一致'],
      metrics:{runs:1,forecasts:1,modelRequests:after.run.usage.modelRequests,toolCalls:after.run.usage.toolCalls,totalTokens:after.run.usage.totalTokens},forecast:before.forecast,result,
      snapshots:[{label:'正常自动发布',status:before.run.status,collaboration:before.run.collaboration},{label:'结果核验后',status:after.run.status,collaboration:after.run.collaboration}]}
  }finally{await service.close();workbench.close();await rm(folder,{recursive:true,force:true})}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mock=await runPriceCase(),cases=[mock]
  const seen=new Set()
  for(const name of ['price-live-attempt-one.json','price-live-validation.json'])try{const live=JSON.parse(await readFile(new URL('../docs/evidence/'+name,import.meta.url),'utf8'));if(live.mode!=='live'||!live.notAccuracyBenchmark)throw Error('Invalid public archive');if(!seen.has(live.requestId)){seen.add(live.requestId);cases.push({...live,title:live.autonomousValidationPassed?'真实BTC-USDT预测：三席自动发布与到期核验':'真实BTC-USDT预测：未通过验收记录'})}}catch(error){if(error.code!=='ENOENT')throw error}
  const path=new URL('../web/demo/price-cases.json',import.meta.url);await mkdir(dirname(fileURLToPath(path)),{recursive:true});await writeFile(path,JSON.stringify({version:1,notAccuracyBenchmark:true,cases},null,2)+'\n')
  console.log(JSON.stringify({checks:mock.checks,metrics:mock.metrics,preservedLiveArchives:cases.length-1}))
}
