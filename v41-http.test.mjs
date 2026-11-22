import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
test('V4.1 fresh public mock entry serves UI, completes cited research and keeps unchanged and archived outputs separate',{timeout:20000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'v41-http-'))
  const child=spawn(process.execPath,['start-mock.mjs'],{cwd:new URL('.',import.meta.url),env:{PATH:process.env.PATH,PORT:'0',WORLD_DATA_DIR:dir,WORLD_MOCK_PACING:'0',WORLD_MONITOR:'off'}})
  const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;await rm(dir,{recursive:true,force:true})})
  let output='';const address=await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0])});exited.then(()=>reject(Error('mock exited before ready')))})
  const homepage=await fetch(address);assert.equal(homepage.status,200);const html=await homepage.text();assert(html.includes('课程案例'));assert(html.includes('模型连接'))
  const js=await (await fetch(address+'/course-collaboration.js')).text();assert(js.includes('来源与研究员'));assert(js.includes('同一地址只列一次'))
  const request=async(path,data)=>{const res=await fetch(address+'/api/v1/course'+path,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});assert(res.ok);return res.json()}
  const config=await request('/config');assert.equal(config.modelMode,'mock')
  const created=await request('/requests',{question:'【模拟】虚构科技展未来48小时会开幕吗？',watch:false})
  async function settled(){for(let i=0;i<150;i++){const value=await request('/requests/'+created.requestId);if(['completed','insufficient','failed'].includes(value.run?.status))return value;await delay(20)}throw Error('run did not finish')}
  const done=await settled();assert.equal(done.run.status,'completed',JSON.stringify(done.run.error));assert(done.forecast);assert(done.run.collaboration.sources.length>=2);assert(done.run.collaboration.reports.every(r=>r.evidenceIds.length))
  const sealed=JSON.stringify(done.forecast)
  await request('/requests/'+created.requestId+'/check',{});const unchanged=await settled();assert.equal(JSON.stringify(unchanged.forecast),sealed);assert.equal(unchanged.forecasts.length,1)
  const archived=await (await fetch(address+'/demo/price-cases.json')).json();assert(archived)
})
