import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'llmword-course-http-'))
  const children = []
  t.after(async () => { for (const stop of children.reverse()) await stop(); await rm(folder, {recursive:true,force:true}) })
  return async function launch(extraEnv = {}) {
    const child=spawn(process.execPath,['server/app.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,
      PORT:'0',WORLD_MODEL:'mock',WORLD_API_KEY:'',WORLD_MONITOR:'off',WORLD_MOCK_PACING:'0',
      WORLD_COURSE:'on',WORLD_SEARCH_PROVIDER:'fixture',WORLD_COURSE_POLL_MS:'3600000',
      WORLD_STATE_PATH:join(folder,'legacy.json'),WORLD_COURSE_PATH:join(folder,'course.sqlite'), ...extraEnv}})
    const exited=once(child,'exit'); let errors=''
    child.stderr.setEncoding('utf8').on('data',chunk=>{errors+=chunk})
    const stop=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited}
    children.push(stop)
    const address=await new Promise((resolve,reject)=>{let output='';child.stdout.setEncoding('utf8').on('data',chunk=>{output+=chunk;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0])});exited.then(()=>reject(new Error(errors)),reject)})
    async function request(path,{method='GET',data,key,expected=200,headers={}}={}) {
      const res=await fetch(address+'/api/v1/course'+path,{method,headers:{...headers,...(data===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})})
      const json=await res.json();assert.equal(res.status,expected,JSON.stringify(json));return json
    }
    async function settled(id){let value;for(let i=0;i<150;i++){value=await request('/requests/'+id);const r=value.run??value.latestRun;if(r&&['completed','failed','cancelled','insufficient'].includes(r.status))return value;await delay(20)}throw new Error('Course did not settle: '+JSON.stringify(value))}
    return {request,settled,stop,address}
  }
}

test('course HTTP accepts one question, performs three independent tool investigations and preserves the forecast across restart', {timeout:25000}, async t=>{
  const launch=await fixture(t), app=await launch()
  const capability=await app.request('/config')
  assert.equal(capability.stage,'course-adaptive')
  assert.equal(capability.supervisor,true)
  assert.equal(capability.nativeToolProtocol,true)
  assert.equal(capability.forecastPublishing,true)
  assert.equal(new Set(capability.roles).size,10)
  for(const role of ['official','timeline','verification','statistics','social','people']) assert(capability.roles.includes(role))
  const input={question:'虚构的城市科技展是否会在未来两天正式开幕？',horizonHours:48,mode:'preset'}
  const created=await app.request('/requests',{method:'POST',data:input,key:'course-first',expected:202})
  const id=created.requestId??created.id;assert(id)
  const done=await app.settled(id)
  assert.equal(done.modelMode,'mock')
  assert(done.predictionId);assert(done.topicId)
  const run=done.run??done.latestRun
  assert.equal(run.status,'completed',JSON.stringify(run.error))
  const detail=await app.request('/runs/'+run.runId)
  const roles=new Set(detail.assignments.map(a=>a.agentSpecId))
  for(const role of ['official','timeline','verification'])assert(roles.has(role))
  assert(detail.events.some(e=>e.type==='tool.completed'&&e.payload.toolId==='search_web'))
  assert(detail.events.some(e=>e.type==='tool.completed'&&e.payload.toolId==='fetch_page'))
  assert(detail.events.filter(e=>e.type==='assignment.completed').length>=3)
  assert(!JSON.stringify(detail).includes('"messages"'))
  assert(done.evidence.length>=2)
  assert(done.forecast&&Number.isFinite(done.forecast.probabilityYes))
  assert.equal(done.forecast.scoringEligible,false)
  const retry=await app.request('/requests',{method:'POST',data:input,key:'course-first',expected:202})
  assert.equal(retry.requestId??retry.id,id)
  await app.request('/requests',{method:'POST',data:{...input,question:'另一个问题'},key:'course-first',expected:409})
  const before=done.forecasts.length
  await app.request('/requests/'+id+'/check',{method:'POST',data:{},expected:202})
  const checked=await app.settled(id)
  assert.equal(checked.forecasts.length,before,'unchanged pages must not invent a new probability point')
  await app.stop()
  const reopened=await launch(), persisted=await reopened.request('/requests/'+id)
  assert.equal(persisted.forecast.forecastId,done.forecast.forecastId)
  assert.equal(persisted.forecasts.length,before)
  assert(persisted.runs.length>=1)
  await reopened.request('/requests/'+id+'/stop',{method:'POST',data:{}})
  await reopened.request('/requests/'+id+'/check',{method:'POST',data:{},expected:409})
})

test('course HTTP rejects malformed input and cross-origin writes without accepting manual materials or capability grants', {timeout:15000}, async t=>{
  const app=await(await fixture(t))()
  for(const data of [{question:''},{question:'测试',horizonHours:0},{question:'测试',mode:'admin'},
    {question:'测试',allowedTools:['unsafe']},{question:'测试',evidence:[{text:'manual'}]}]) {
    await app.request('/requests',{method:'POST',data,expected:400})
  }
  await app.request('/requests',{method:'POST',data:{question:'外站创建'},headers:{Origin:'https://example.org'},expected:403})
  assert.equal((await app.request('/requests')).requests.length,0)
})

test('disabled course routes report their own capability error without falling through to the runtime router', {timeout:15000}, async t=>{
  const app=await(await fixture(t))({WORLD_COURSE:'off'})
  for(const path of ['/config','/requests']) {
    const result=await app.request(path,{expected:503})
    assert.equal(result.error.code,'COURSE_DISABLED')
    assert(!result.error.message.includes('找不到此运行 API'))
  }
  const create=await app.request('/requests',{method:'POST',data:{question:'测试自动跟踪'},expected:503})
  assert.equal(create.error.code,'COURSE_DISABLED')
  const runtime=await fetch(app.address+'/api/v1/runtime')
  assert.equal(runtime.status,200,'the runtime router remains independently available')
})

test('prediction settings work without a model key, persist across restart and reject invalid writes atomically', {timeout:15000}, async t => {
  const launch = await fixture(t)
  const app = await launch({ WORLD_ENV: 'live', WORLD_MODEL: 'openai', WORLD_API_KEY: '', WORLD_SEARCH_PROVIDER: 'deepseek' })
  assert.deepEqual(await app.request('/settings'), { predictionBudget: { mode: 'limited', maxTotalTokens: 1000000 } })
  const unlimited = { predictionBudget: { mode: 'unlimited', maxTotalTokens: null } }
  assert.deepEqual(await app.request('/settings', { method: 'PUT', data: unlimited }), unlimited)
  for (const data of [{predictionBudget:{mode:'limited',maxTotalTokens:0}}, {predictionBudget:{mode:'limited',maxTotalTokens:1.5}}, {...unlimited,apiKey:'must-not-persist'}]) {
    const failure = await app.request('/settings', { method: 'PUT', data, expected: 400 })
    assert.equal(failure.error.code, 'INVALID_PREDICTION_BUDGET')
    assert.deepEqual(await app.request('/settings'), unlimited)
  }
  await app.request('/settings', { method: 'PUT', data: {predictionBudget:{mode:'limited',maxTotalTokens:500000}}, headers:{Origin:'https://example.org'}, expected:403 })
  assert.deepEqual(await app.request('/settings'), unlimited)
  await app.request('/requests', {method:'POST', data:{question:'No configured key'}, expected:409})
  await app.stop()
  const reopened = await launch({ WORLD_ENV: 'live', WORLD_MODEL: 'openai', WORLD_API_KEY: '', WORLD_SEARCH_PROVIDER: 'deepseek' })
  assert.deepEqual(await reopened.request('/settings'), unlimited)
  const limited = {predictionBudget:{mode:'limited',maxTotalTokens:300000}}
  assert.deepEqual(await reopened.request('/settings', {method:'PUT',data:limited}), limited)
  assert.equal((await reopened.request('/config')).limits.totalTokensPerRun, 300000)
})
