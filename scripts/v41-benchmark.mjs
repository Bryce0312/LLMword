import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

export async function benchmark(root = process.cwd()) {
  const module = path => import(pathToFileURL(join(root, path)))
  const [{createCourseService},{createCourseMockProvider},{createWorkbenchService},{createWebResearchGateway},{FIXTURE_PAGES}] = await Promise.all([
    module('server/course/course-service.mjs'),module('server/course/course-mock-provider.mjs'),module('server/domain/workbench-service.mjs'),module('server/course/web-tools.mjs'),module('server/course/course-fixtures.mjs')])
  const folder = await mkdtemp(join(tmpdir(),'v41-bench-')), now = () => '2026-11-22T00:00:00.000Z'
  // Identical artificial long pages for both revisions. No real-world claims.
  const fixturePages = FIXTURE_PAGES.map(page => ({...page, publishedAt: '2026-11-21T00:00:00.000Z', text: page.text + '\n' + '课程测试背景资料，仅用于软件检查。'.repeat(190) + '\n科技展筹备不等于正式开幕；尚无独立确认。'}))
  const workbench = createWorkbenchService({path:join(folder,'domain.sqlite'),now}), mock = createCourseMockProvider()
  let bytes = 0, calls = 0, toolSchemaBytes = 0
  const provider = {...mock,async complete(input) {
    bytes += Buffer.byteLength(JSON.stringify(input.messages)); toolSchemaBytes += Buffer.byteLength(JSON.stringify(input.tools)); calls++
    for (const message of input.messages.filter(m=>m.role==='assistant')) for (const call of message.tool_calls || []) assert(input.messages.some(m=>m.role==='tool'&&m.tool_call_id===call.id))
    return mock.complete(input)
  }}
  const service = createCourseService({path:join(folder,'course.sqlite'),workbench,provider,sourceTools:createWebResearchGateway({env:{WORLD_SEARCH_PROVIDER:'fixture'},now,fixturePages}),now,evidencePolicy:'quoted-claims-v1'})
  try {
    const created=service.createRequest({question:'【模拟】虚构城市科技展未来48小时会正式开幕吗？',watch:false})
    await service.idle(); const done=service.getRequest(created.requestId)
    const claims=done.run.assignments.flatMap(a=>[...(a.report?.support||[]),...(a.report?.counterevidence||[])])
    const quotes=claims.flatMap(c=>c.citations||[]), exact=quotes.filter(q=>done.run.evidence.some(e=>e.evidenceId===q.evidenceId&&e.text.includes(q.quote))).length
    return {mode:'mock',actualModelUsage:null,syntheticUsage:done.run.usage,serializedMessageBytes:bytes,serializedToolSchemaBytes:toolSchemaBytes,estimatedInputTokensByteDiv4:Math.ceil((bytes+toolSchemaBytes)/4),estimateCaveat:'bytes/4 comparison only; not tokenizer usage and not suitable for admission (especially CJK)',calls,status:done.run.status,forecasts:done.forecasts.length,sourceUrls:[...new Set(done.run.evidence.map(e=>e.url))].sort(),evidenceCount:done.run.evidence.length,quoteCount:quotes.length,exactQuoteCount:exact,workerStatuses:done.run.assignments.map(a=>a.report?.status),error:done.run.error}
  } finally {await service.close();workbench.close();await rm(folder,{recursive:true,force:true})}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await benchmark(resolve(process.argv[2]||'.')),null,2))
