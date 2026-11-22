import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceView, focusedEvidenceView, terms, requestReservation } from './retrieval-view.mjs'
import { validateGroundedClaims } from '../domain/claim-grounding.mjs'
import { benchmark } from '../../scripts/v41-benchmark.mjs'
import { runWorker } from '../runtime/worker-loop.mjs'
const page = text => ({ evidenceId:'e', evidenceKind:'page_content',url:'https://example.com/a',contentHash:'immutable',obtainedAt:'2026-11-20T00:00:00Z',publishedAt:'2026-11-19T00:00:00Z',readBy:['a'],text })
test('Chinese lexical ranking selects exact distant slices, preserves identity and does not mutate evidence',()=>{
  const source=page('开头摘要。'.repeat(80)+'无关背景。'.repeat(210)+'科技展延期，尚未开幕。'.repeat(25)+'其他背景。'.repeat(120));const before=JSON.stringify(source), view=evidenceView(source,'科技展是否开幕')
  assert(terms('科技展').includes('技展')); assert(view.text.includes('科技展延期')); assert(view.text.length<1400)
  for(const {start,end} of view.excerpts) assert(view.text.includes(source.text.slice(start,end)))
  assert.equal(view.evidenceId,'e');assert.equal(view.contentHash,source.contentHash);assert.equal(JSON.stringify(source),before)
})
test('opposing documents both retain their literal selected evidence; empty/unknown queries do not invent facts',()=>{
  for(const stance of ['科技展确认开幕。','科技展否认开幕。']) {const source=page(stance+'背景。'.repeat(1800));assert(evidenceView(source,'科技展').text.includes(stance))}
  const source=page('😀未知。'.repeat(1500));const view=evidenceView(source,'');assert(!view.text.includes('undefined'));for(const w of view.excerpts) assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(source.text.slice(w.start,w.end)))
  assert.deepEqual(evidenceView({text:null},'查询'),{text:null})
})
test('focused expansion retains the same ID, exact quote and bounded size; unavailable term is not fabricated',()=>{
  const source=page('背景'.repeat(900)+'重要反证：展会延期。'+'背景'.repeat(900)), view=focusedEvidenceView(source,'重要反证')
  assert.equal(view.evidenceId,source.evidenceId);assert(view.text.includes('重要反证：展会延期。'));assert(source.text.includes(view.text));assert(view.text.length<=1200);assert.equal(focusedEvidenceView(source,'不存在'),null)
})
test('structured financial snapshots and short evidence are not compressed',()=>{
  for(const source of [{...page('x'.repeat(5000)),evidenceKind:'market_quote'},page('短正文')]) assert.deepEqual(evidenceView(source,'x'),source)
})
test('existing citation validator rejects missing, invalid and cutoff sources after projection',()=>{
  const source=page('支持与反对主张需要真实来源片段。'), claim={claim:'需要真实来源',basis:'inference',evidenceIds:['e'],citations:[{evidenceId:'e',quote:source.text}]}
  assert.equal(validateGroundedClaims([claim],[source],{readerId:'a',asOf:'2026-11-21T00:00:00Z'}).length,1)
  for(const evidence of [[],[{...source,text:'另一个正文'}],[{...source,publishedAt:'2026-11-23T00:00:00Z'}]]) assert.throws(()=>validateGroundedClaims([claim],evidence,{readerId:'a',asOf:'2026-11-21T00:00:00Z'}))
})
test('admission includes serialized input, tool schema, output and protocol overhead, not bytes/4 estimate',()=>{
  const input={messages:[{role:'user',content:'中文'.repeat(1000)}],tools:[{name:'tool'}],maxTokens:4096}
  assert.equal(requestReservation(input),Buffer.byteLength(JSON.stringify(input.messages))+Buffer.byteLength(JSON.stringify(input.tools))+4096+2048)
})
function worker(budget,provider) {return {assignment:{topicId:'t',predictionId:'p',runId:'r',assignmentId:'a',agentInstanceId:'i',objective:'测试预算',inputEvidence:[],allowedTools:[],budget},agentSpec:{agentSpecId:'verification',specVersion:1,instructions:'报告缺口',allowedTools:[]},tools:[],provider,finishOnToolBudget:true}}
test('worker final report is an actual model action and admits its input plus output',async()=>{
  let calls=0
  const result=await runWorker(worker({admissionVersion:1,reserveReportTokens:7000,maxTotalTokens:15000,maxTokens:2048}, {async complete({tools}){calls++;assert.deepEqual(tools.map(t=>t.function.name),['submit_report']);return {message:{role:'assistant',content:null,tool_calls:[{id:'done',type:'function',function:{name:'submit_report',arguments:JSON.stringify({status:'insufficient',summary:'无已读来源',evidenceIds:[],support:[],counterevidence:[],missingEvidence:['缺原文'],probability:null,nextSuggestion:'等待原文'})}}]},finishReason:'tool_calls',usage:{total_tokens:500}}}}))
  assert.equal(calls,1);assert.equal(result.report.status,'insufficient');assert.equal(result.usage.totalTokens,500)
})
test('worker rejects impossible input before provider call and records truthful zero usage',async()=>{
  let calls=0;const events=[]
  await assert.rejects(runWorker({...worker({admissionVersion:1,reserveReportTokens:1000,maxTotalTokens:1000,maxTokens:800},{async complete(){calls++}}),onEvent:e=>events.push(e)}),e=>e.code==='WORKER_INPUT_BUDGET'&&e.requestNotSent&&e.usage.total_tokens===0)
  assert.equal(calls,0);assert(events.some(e=>e.type==='budget.stopped'))
})
test('long staged binary question completes with all citation slices exact and no live usage',async()=>{
  const result=await benchmark();assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(result.forecasts,1);assert(result.quoteCount>0);assert.equal(result.quoteCount,result.exactQuoteCount);assert.equal(result.actualModelUsage,null)
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService } from './course-service.mjs'
import { createCourseMockProvider } from './course-mock-provider.mjs'
import { createWorkbenchService } from '../domain/workbench-service.mjs'
import { createWebResearchGateway } from './web-tools.mjs'
async function serviceCase(t, firstUsage) {
  const folder=await mkdtemp(join(tmpdir(),'v41-reserve-')),now=()=> '2026-11-22T00:00:00Z'
  const workbench=createWorkbenchService({path:join(folder,'domain.sqlite'),now}),mock=createCourseMockProvider();let calls=0
  const provider={...mock,async complete(input){calls++;const response=await mock.complete(input);if(calls===1)response.usage={total_tokens:firstUsage};return response}}
  const service=createCourseService({path:join(folder,'course.sqlite'),workbench,provider,now,sourceTools:createWebResearchGateway({env:{WORLD_SEARCH_PROVIDER:'fixture'},now})})
  t.after(async()=>{await service.close();workbench.close();await rm(folder,{recursive:true,force:true})})
  const created=service.createRequest({question:'【模拟】城市科技展未来48小时开幕吗？',watch:false});await service.idle()
  return {record:service.getRequest(created.requestId),calls}
}
test('run reserve blocks workers before spending final allowance; safe insufficient result has no probability',async t=>{
  const {record,calls}=await serviceCase(t,299000)
  assert.equal(record.run.status,'insufficient',JSON.stringify(record.run.error));assert.equal(record.forecasts.length,0);assert.equal(calls,1)
  assert.equal(record.run.usage.totalTokens,299000);assert.equal(record.run.usage.modelRequests,1)
  assert(record.run.events.some(e=>e.type==='budget.stopped'&&e.payload.code==='RUN_FINAL_RESERVE'&&e.payload.requestNotSent))
  assert(record.run.assignments.every(a=>a.report?.status==='insufficient'&&a.report.probability===null))
})
