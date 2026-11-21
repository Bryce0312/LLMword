import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { priceQuestion } from './price-case.mjs'

if(!process.argv.includes('--start')&&!process.argv.includes('--resume')){
  console.log('先启动start:live并在页面保存Key，再显式运行node scripts/live-price-case.mjs --start [--base=http://127.0.0.1:4196]；中断用--resume。无自动付费监听，不读取或保存Key。');process.exit(0)
}
const base=new URL(process.argv.find(x=>x.startsWith('--base='))?.slice(7)||'http://127.0.0.1:4196')
if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('Local origin required')
const stateFile=new URL('../.data/price-live-driver.json',import.meta.url),archiveFile=new URL('../docs/evidence/price-live-validation.json',import.meta.url)
async function api(path,body){const response=await fetch(new URL('/api/v1/course/'+path,base),{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error?.message||'Local API error'),{code:data.error?.code});return data}
let state
try{state=JSON.parse(await readFile(stateFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
if(!state){
  if(!process.argv.includes('--start'))throw Error('No saved case')
  const connection=await api('provider-connection');if(!connection.configured||connection.environment==='mock')throw Error('Save Key in the live page before starting')
  const targetAt=new Date(Date.now()+30*60000).toISOString(),record=await api('requests',priceQuestion(targetAt))
  state={requestId:record.requestId,targetAt,base:base.origin,caseLimit:1,tokenLimit:record.budget.maxTotalTokens}
  await mkdir(new URL('../.data/',import.meta.url),{recursive:true});await writeFile(stateFile,JSON.stringify(state,null,2)+'\n')
}else if(state.base!==base.origin)throw Error('Saved request belongs to another local port')
const digest=record=>createHash('sha256').update(JSON.stringify([record.forecast,record.run.evidence,record.run.usage])).digest('hex')
function acceptance(record){const run=record.run,team=run.assignments.filter(a=>!a.followUp),forecast=record.forecast;return {
  threeComplete:team.length===3&&['market','statistics','verification'].every(role=>team.some(a=>a.roleId===role&&a.status==='completed'&&a.report?.status==='complete')),
  normalPublication:Boolean(forecast&&!forecast.publicationMode&&!forecast.reviewRequired&&!run.summaryResumeCount),
  beforeTarget:Boolean(forecast&&Date.parse(forecast.publishedAt)<Date.parse(state.targetAt)),
  liveSources:record.modelMode==='live'&&record.sourceMode==='live'&&run.evidence.every(e=>e.sourceMode==='live'&&!e.fixture),
  resultVerified:Boolean(record.result&&record.result.resolutionPolicy==='binance-btc-usdt-higher-v1'),
  originalSealedUnchanged:Boolean(state.sealedHash&&state.sealedHash===digest(record)),
}}
async function archive(record){const run=record.run,checks=acceptance(record),passed=Object.values(checks).every(Boolean);const data={version:1,id:'btc-usdt-live-'+record.requestId,title:'真实BTC-USDT预测：三席自动发布与到期核验',kind:'price-live-validation',mode:'live',notAccuracyBenchmark:true,capturedAt:new Date().toISOString(),
  requestId:record.requestId,question:record.question,status:record.status,targetAt:state.targetAt,autonomousValidationPassed:passed,acceptance:checks,
  checks:Object.entries(checks).filter(([,ok])=>ok).map(([key])=>key),metrics:{runs:record.runs.length,forecasts:record.forecasts.length,modelRequests:run.usage.modelRequests,toolCalls:run.usage.toolCalls,totalTokens:run.usage.totalTokens},
  forecast:record.forecast,result:record.result,normalized:record.normalized,assignments:run.assignments,error:run.error,
  reviewNotes:['三席是独立上下文与职责，均来自同一Binance市场来源；USDT不是USD。','30个已关闭分钟桶只提供有限样本，概率未校准；单题结果及Brier不能证明总体准确率。'],
  snapshots:[{label:record.result?'真实到期核验后（原预测保留）':'真实发布/运行记录',status:run.status,collaboration:run.collaboration}],
  events:run.events.filter(e=>['team.selected','forecast.published','run.finished','resolution.recorded','research.resume_requested','forecast.revalidated'].includes(e.type))}
  await writeFile(archiveFile,JSON.stringify(data,null,2)+'\n');return data
}
console.log(JSON.stringify({requestId:state.requestId,targetAt:state.targetAt,caseLimit:1,tokenLimit:state.tokenLimit}))
let record,lastLog=0
for(;;){record=await api('requests/'+state.requestId);if(Date.now()-lastLog>30000){console.log(JSON.stringify({status:record.run.status,phase:record.run.phase,usage:record.run.usage,roles:record.run.assignments.map(a=>({role:a.roleId,status:a.status,report:a.report?.status})),error:record.run.error}));lastLog=Date.now()};if(['completed','failed','insufficient','cancelled'].includes(record.run.status))break;await delay(3000)}
if(!record.forecast){const data=await archive(record);console.log(JSON.stringify({finished:true,autonomousValidationPassed:false,error:data.error,metrics:data.metrics}));process.exitCode=1}
else{
  if(!state.sealedHash){state.sealedHash=digest(record);await writeFile(stateFile,JSON.stringify(state,null,2)+'\n')}
  await archive(record)
  console.log(JSON.stringify({publishedAt:record.forecast.publishedAt,probabilityYes:record.forecast.probabilityYes,baseline:record.forecast.baseline,acceptance:acceptance(record)}))
  while(Date.now()<Date.parse(state.targetAt)+1000){await delay(Math.min(10000,Date.parse(state.targetAt)+1000-Date.now()));if(Date.now()-lastLog>30000){console.log('预测已正常封存，等待固定目标；无模型监听，价格核验不调用模型。');lastLog=Date.now()}}
  if(!record.result)for(let i=0;i<3;i++){try{await api('requests/'+state.requestId+'/resolve',{});break}catch(error){if(error.code!=='RESULT_SOURCE_UNAVAILABLE'||i===2){console.log(JSON.stringify({resolutionError:error.code}));break};await delay(5000)}}
  record=await api('requests/'+state.requestId);const data=await archive(record);console.log(JSON.stringify({finished:true,autonomousValidationPassed:data.autonomousValidationPassed,acceptance:data.acceptance,metrics:data.metrics,outcome:record.result?.outcome,scores:record.result?.scores}));if(!data.autonomousValidationPassed)process.exitCode=1
}
