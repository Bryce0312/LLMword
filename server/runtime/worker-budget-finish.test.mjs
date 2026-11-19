import assert from 'node:assert/strict'
import test from 'node:test'
import {runWorker} from './worker-loop.mjs'

function setup(){
  let executed=0, turns=0
  const assignment={topicId:'t',predictionId:'p',runId:'r',assignmentId:'a',agentInstanceId:'i',objective:'只在有界取证后报告',inputEvidence:[],allowedTools:['read_source'],budget:{maxToolCalls:2,maxModelRequests:3}}
  const agentSpec={agentSpecId:'official',specVersion:1,instructions:'核对来源',allowedTools:['read_source']}
  const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}})
  const tools=[{toolId:'read_source',version:1,inputSchema:{type:'object',properties:{number:{type:'integer'}},required:['number'],additionalProperties:false},async execute(args){executed++;return {status:'ok',data:{text:'实际取得的测试原文'},evidenceIds:['e'+args.number],summary:'已读取',observedAt:new Date().toISOString(),error:null}}}]
  const provider={async complete({messages,tools:advertised}){
    turns++
    if(turns===1)return {message:{role:'assistant',content:null,tool_calls:[1,2,3].map(n=>call('c'+n,'read_source',{number:n}))},finishReason:'tool_calls',usage:{total_tokens:100}}
    assert.deepEqual(advertised.map(t=>t.function.name),['submit_report'])
    const replies=messages.filter(m=>m.role==='tool');assert.deepEqual(replies.map(m=>m.tool_call_id),['c1','c2','c3'])
    assert.equal(JSON.parse(replies[2].content).error.code,'TOOL_BUDGET_REACHED')
    return {message:{role:'assistant',content:null,tool_calls:[call('report','submit_report',{status:'complete',summary:'根据两份实际材料报告；第三次调用被预算拒绝。',evidenceIds:['e1','e2'],support:[{claim:'已取得两份原文',evidenceIds:['e1','e2']}],counterevidence:[],missingEvidence:[],probability:.4,nextSuggestion:'等待新资料'})]},finishReason:'tool_calls',usage:{total_tokens:100}}
  }}
  return {assignment,agentSpec,tools,provider,executed:()=>executed}
}
test('opt-in budget finishing preserves all tool replies and lets the model report without executing a denied batch call',async()=>{
  const x=setup();const events=[]
  const result=await runWorker({...x,finishOnToolBudget:true,onEvent:e=>events.push(e)})
  assert.equal(x.executed(),2);assert.equal(result.usage.toolCalls,2);assert.equal(result.usage.modelRequests,2)
  assert.deepEqual(result.report.evidenceIds,['e1','e2']);assert(!result.evidenceIds.includes('e3'))
  assert(events.some(e=>e.type==='tool.failed'&&e.payload.toolCallId==='c3'))
})
test('the default worker still stops at the hard tool limit rather than changing legacy behavior',async()=>{
  const x=setup();await assert.rejects(runWorker(x),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(x.executed(),2)
})
