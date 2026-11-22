import assert from 'node:assert/strict'
import test from 'node:test'
import { providerConnectionView } from './workbench-provider.js'
import { COURSE_PROVIDER_DEFAULTS, saveCourseProviderKey, syncCourseProviderCredential } from './course-provider.mjs'

// Minimal DOM used by the actual provider view. All requests resolve from local fake responses.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.disabled = false; this.hidden = false; this.className = '' }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = [...children] }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler) }
  async fire(name) { for (const handler of this.listeners[name] || []) await handler({ preventDefault() {}, target: this }) }
  get textContent() { return this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join('') }
  set textContent(value) { this.children = [String(value)] }
  query(predicate) { if (predicate(this)) return this; for (const child of this.children) if (typeof child === 'object') { const found = child.query(predicate); if (found) return found } return null }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve = yes; reject = no }); return {promise,resolve,reject} }
const status = (stamp = '2026-11-22T15:00:00Z') => ({configured:true,connection:'connected',verifiedAt:stamp,keySource:'session',...COURSE_PROVIDER_DEFAULTS,activeRuns:0,activeWatchers:0,canUpdate:true})
const unconfigured = {configured:false,keySource:'none',activeRuns:0,activeWatchers:0,canUpdate:true}
const capability = {supervisor:true,forecastPublishing:true,nativeToolProtocol:true,modelMode:'live'}
const response = body => ({ok:true,status:200,json:async()=>body})
const credentialOf = nodes => nodes.at(-1).query(node=>node.name==='apiKey')
const formOf = nodes => nodes.at(-1).query(node=>node.tagName==='FORM')
function owner(cache = {}) { const value = {active:true,connected:0,capabilities:[],cache}; value.ctx={cache,isActive:()=>value.active,onDataConnected:()=>{value.connected++},setCourseCapability:next=>{value.capabilities.push(next);cache.courseCapability=next}}; return value }
async function withView(exercise) {
  const previous = {document:globalThis.document,fetch:globalThis.fetch}
  const created = []
  globalThis.document={createElement:tag=>{const element=new Element(tag);created.push(element);return element}}
  syncCourseProviderCredential({value:''},null)
  try { await exercise({created,setFetch:fetcher=>{globalThis.fetch=fetcher}}) }
  finally { syncCourseProviderCredential({value:''},null); for(const [key,value] of Object.entries(previous)) if(value===undefined) delete globalThis[key]; else globalThis[key]=value }
}

test('late inactive popup reads cannot mutate owner callbacks or invalidate a newer verified credential cache', async () => withView(async ({setFetch}) => {
  for (const outcome of ['success','failure']) {
    const stale = deferred(); let gets=0
    setFetch(async (url,options={})=>{
      if(url.endsWith('/config')) return response(capability)
      if(options.method==='POST') return response(status())
      if(++gets===1) return stale.promise
      return response(unconfigured)
    })
    const old = owner(), oldView = providerConnectionView(old.ctx)
    old.active=false
    const next = owner(), nodes = await providerConnectionView(next.ctx)
    credentialOf(nodes).value='FAKE_NEW_POPUP_KEY'
    await formOf(nodes).fire('submit')
    const before = {text:nodes.at(-1).textContent,value:credentialOf(nodes).value}
    if(outcome==='success') stale.resolve(response(status('2026-11-22T01:00:00Z')))
    else stale.reject(new Error('FAKE_STALE_READ'))
    assert.deepEqual(await oldView,[])
    assert.equal(old.connected,0)
    assert.equal(old.capabilities.length,0)
    assert.equal(nodes.at(-1).textContent,before.text)
    assert.equal(credentialOf(nodes).value,before.value)
    const restored={value:''}
    assert.equal(syncCourseProviderCredential(restored,status()),true)
    assert.equal(restored.value,'FAKE_NEW_POPUP_KEY')
  }
}))

test('closed-owner successful save cannot update another popup, its callbacks or its newer document credential', async () => withView(async ({setFetch}) => {
  const stale = deferred(); let posts=0, probes=0
  setFetch(async (url,options={})=>{
    if(url.endsWith('/config')) {probes++;return response(capability)}
    if(options.method==='POST') return ++posts===1 ? stale.promise : response(status('2026-11-22T16:00:00Z'))
    return response(unconfigured)
  })
  const cache={}, old=owner(cache), oldNodes=await providerConnectionView(old.ctx)
  credentialOf(oldNodes).value='FAKE_OLD_POPUP_KEY'
  const oldSave=formOf(oldNodes).fire('submit')
  assert.equal(credentialOf(oldNodes).value,'')
  old.active=false
  const current=owner(cache), newNodes=await providerConnectionView(current.ctx)
  credentialOf(newNodes).value='FAKE_CURRENT_POPUP_KEY'
  await formOf(newNodes).fire('submit')
  const oldText=oldNodes.at(-1).textContent,newText=newNodes.at(-1).textContent,currentCapability=cache.courseCapability
  stale.resolve(response(status('2026-11-22T15:00:00Z')))
  await oldSave
  assert.equal(oldNodes.at(-1).textContent,oldText)
  assert.equal(newNodes.at(-1).textContent,newText)
  assert.equal(credentialOf(newNodes).value,'FAKE_CURRENT_POPUP_KEY')
  assert.equal(credentialOf(oldNodes).value,'')
  assert.equal(cache.courseCapability,currentCapability)
  assert.equal(old.connected,1,'only the initial active read notifies the old owner')
  assert.equal(old.capabilities.length,0)
  assert.equal(probes,1,'only the current save probes capability')
  const restored={value:''}
  assert.equal(syncCourseProviderCredential(restored,status('2026-11-22T16:00:00Z')),true)
  assert.equal(restored.value,'FAKE_CURRENT_POPUP_KEY')
}))

test('a capability probe completing after its popup closes cannot overwrite the next owner cache', async () => withView(async ({setFetch}) => {
  const probe=deferred(), started=deferred()
  setFetch(async (url,options={})=>{
    if(url.endsWith('/config')) {started.resolve();return probe.promise}
    return response(status())
  })
  const cache={}, old=owner(cache), nodes=await providerConnectionView(old.ctx)
  credentialOf(nodes).value='FAKE_PROBE_OWNER_KEY'
  const saving=formOf(nodes).fire('submit')
  await started.promise
  old.active=false
  const next=owner(cache), nextNodes=await providerConnectionView(next.ctx)
  const sentinel={available:true,kind:'new-owner-current'};cache.courseCapability=sentinel
  const before=nextNodes.at(-1).textContent,oldText=nodes.at(-1).textContent
  probe.resolve(response({...capability,modelRef:'old-probe-generation'}))
  await saving
  assert.equal(cache.courseCapability,sentinel)
  assert.equal(nextNodes.at(-1).textContent,before)
  assert.equal(nodes.at(-1).textContent,oldText)
  assert.equal(old.capabilities.length,0)
}))

test('legacy callers without an owner predicate stay supported and loading does not require DOM connection', async () => withView(async ({setFetch}) => {
  let reads=0
  setFetch(async (_url,options={})=>{assert.notEqual(options.method,'POST');reads++;return response(unconfigured)})
  const nodes=await providerConnectionView({cache:{}})
  assert.equal(nodes.length,2)
  assert.equal(reads,1)
  assert.equal(formOf(nodes).query(node=>node.type==='submit').disabled,false)
}))
