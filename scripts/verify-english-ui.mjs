import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Isolated, read-only browser QA. Never uses a personal browser profile, input values,
// forecast submission, model requests, record deletion or connection verification.
const binary = process.env.CHROME_BINARY || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const base = process.env.UI_CHECK_URL || 'http://127.0.0.1:4174'
const profile = mkdtempSync(join(tmpdir(), 'llmword-english-ui-'))
const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir='+profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let browserExit = null; browser.on('exit', code => { browserExit = code })
class CDP {
  constructor(ws) { this.ws = ws; this.serial = 0; this.pending = new Map(); ws.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id) { const item=this.pending.get(value.id); if (item) { this.pending.delete(value.id); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result) } } }) }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});return new CDP(ws) }
  send(method,params={}) { const id=++this.serial;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))}) }
  async evaluate(expression) { const value=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.text+' '+JSON.stringify(value.exceptionDetails.exception?.description));return value.result?.value }
  close() { this.ws.close() }
}
let root, page
const writeRequests=[]
try {
  const portFile=join(profile,'DevToolsActivePort')
  for(let attempt=0;!existsSync(portFile)&&attempt<80;attempt++){if(browserExit!==null)throw new Error('Isolated browser exited '+browserExit);await delay(100)}
  const [port,path]=readFileSync(portFile,'utf8').trim().split(/\r?\n/)
  root=await CDP.connect('ws://127.0.0.1:'+port+path)
  const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(base+'/#/room'),{method:'PUT'})).json()
  page=await CDP.connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Network.enable')
  page.ws.addEventListener('message', event => {
    const message=JSON.parse(event.data)
    if(message.method==='Fetch.requestPaused') {
      const {requestId,request}=message.params
      void page.send(['GET','HEAD','OPTIONS'].includes(request.method)?'Fetch.continueRequest':'Fetch.failRequest', ['GET','HEAD','OPTIONS'].includes(request.method)?{requestId}:{requestId,errorReason:'BlockedByClient'})
    }
  })
  await page.send('Fetch.enable',{patterns:[{urlPattern:base+'/api/*',requestStage:'Request'}]})
  page.ws.addEventListener('message', event => { const message=JSON.parse(event.data); const request=message.params?.request; if(message.method==='Network.requestWillBeSent' && request.url.startsWith(base+'/api/') && !['GET','HEAD','OPTIONS'].includes(request.method)) writeRequests.push({method:request.method,url:request.url}) })
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  for(let i=0;i<80;i++){if(await page.evaluate('document.readyState === "complete" && Boolean(document.querySelector("[data-locale=en]"))'))break;await delay(100)}
  await page.evaluate('document.querySelector("[data-locale=en]").click()')
  if (await page.evaluate('document.documentElement.lang') !== 'en') throw new Error('English switch was not ready')
  const [history,agents,topics,predictions]=await Promise.all(['/course/requests','/agents','/topics','/predictions'].map(path=>fetch(base+'/api/v1'+path).then(response=>response.json())))
  const routes=['#/room','#/predictions','#/course/new','#/agents','#/agents/new','#/model-connection','#/learning','#/tools','#/advanced','#/advanced/new','#/topics/new','#/course-examples?set=finance',...(agents.agents||[]).map(record=>'#/agents/'+encodeURIComponent(record.agentSpecId)),...(topics.topics||[]).slice(0,2).flatMap(record=>['#/topics/'+encodeURIComponent(record.topicId),'#/topics/'+encodeURIComponent(record.topicId)+'/inbox']),...(predictions.predictions||[]).slice(0,2).map(record=>'#/predictions/'+encodeURIComponent(record.predictionId)),...(history.requests||[]).map(record=>'#/course/'+encodeURIComponent(record.requestId)+'?results=1')]
  const findings=[]
  const scan=String.raw`(()=>{
    const protectedNode = element => {let explicitUI=false,softBlock=false;for(let node=element;node;node=node.parentElement){if(node.matches?.('[data-i18n-skip],[data-i18n-content],[data-user-content],[data-model-content],input,textarea,script,style'))return true;if(node.getAttribute?.('data-i18n-ui')==='true')explicitUI=true;if(node.matches?.('code,pre,blockquote'))softBlock=true}return softBlock&&!explicitUI}
    const visible=element=>!!element?.getClientRects().length && getComputedStyle(element).visibility!=='hidden'
    const results=[]
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT)
    while(walker.nextNode()){const node=walker.currentNode;if(!protectedNode(node.parentElement)&&visible(node.parentElement)&&/\p{Script=Han}/u.test(node.data))results.push({kind:'text',text:node.data.trim().slice(0,240),tag:node.parentElement.tagName,class:node.parentElement.className?.baseVal??node.parentElement.className})}
    for(const element of document.querySelectorAll('[title],[aria-label],[alt],[aria-description],[aria-valuetext]'))if(visible(element)&&!protectedNode(element))for(const name of ['title','aria-label','alt','aria-description','aria-valuetext']){if(element.getAttribute('data-i18n-data-attributes')?.split(/\s+/).includes(name))continue;const value=element.getAttribute(name);if(value&&/\p{Script=Han}/u.test(value))results.push({kind:name,text:value.slice(0,240),tag:element.tagName,class:element.className?.baseVal??element.className})}
    return {lang:document.documentElement.lang,title:document.title,findings:results,bodyWidth:document.body.scrollWidth,viewport:innerWidth}
  })()`
  for(const route of routes){
    await page.evaluate('location.hash='+JSON.stringify(route))
    await delay(650)
    for(let i=0;i<25;i++){if(!await page.evaluate('Boolean(document.querySelector(".wb-workspace-content .wb-loading"))'))break;await delay(100)}
    await page.evaluate('for (const detail of document.querySelectorAll("details")) detail.open=true'); await delay(120)
    const result=await page.evaluate(scan);findings.push({route,...result})
  }
  await page.evaluate('location.hash="#/room"');await delay(100)
  await page.evaluate('location.hash="#/agents"');await delay(400)
  await page.evaluate('document.getElementById("wb-history-menu").open=false')
  await page.evaluate('document.querySelector(".wb-agent-delete").click()');await delay(80)
  findings.push({route:'confirmation:researcher-cancel',...await page.evaluate(scan)})
  await page.evaluate('document.querySelector(".wb-confirm-dialog-actions button").click()');await delay(50)

  mkdirSync('docs/screenshots',{recursive:true})
  const screenshot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
  writeFileSync('docs/screenshots/v43-english-lab.png',Buffer.from(screenshot.data,'base64'))
  for(const width of [900,390]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
    await delay(100);findings.push({route:'responsive:lab:'+width,...await page.evaluate(scan)})
  }
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await page.send('Page.navigate',{url:base+'/legacy.html'})
  for(let attempt=0;attempt<80;attempt++){if(await page.evaluate('location.pathname==="/legacy.html" && document.readyState==="complete" && Boolean(document.querySelector("[data-locale=en]"))'))break;await delay(100)}
  await page.evaluate('document.querySelector("[data-locale=en]").click()');await delay(500)
  if(await page.evaluate('document.documentElement.lang')!=='en')throw new Error('Legacy English switch did not initialize')
  findings.push({route:'/legacy.html',...await page.evaluate(scan)})
  await page.evaluate('document.querySelector("[data-locale=zh-CN]").click()');await delay(100)
  const restored=await page.evaluate('document.documentElement.lang')
  const result={checkedAt:new Date().toISOString(),base,browser:'isolated headless Chrome',viewport:{width:1440,height:1000},noPersonalProfile:true,noInputValuesRead:true,noUserWrites:true,noRealModelCalls:true,restoredLanguage:restored,writeRequests,routes:findings}
  writeFileSync('docs/evidence/v43-english-browser-audit.json',JSON.stringify(result,null,2)+'\n')
  if(writeRequests.length)throw new Error('Read-only audit observed a write request')
  console.log(JSON.stringify({routes:findings.length,findings:findings.filter(value=>value.findings.length).map(value=>({route:value.route,lang:value.lang,count:value.findings.length,examples:value.findings.slice(0,8)})),overflow:findings.filter(value=>value.bodyWidth>value.viewport).map(value=>value.route),restoredLanguage:restored}))
} finally {
  page?.close()
  if(root){try{await root.send('Browser.close')}catch{}root.close()}
  if(browserExit===null)browser.kill()
}
