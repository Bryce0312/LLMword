import { createCourseStore } from '../server/course/course-store.mjs'
import { createWorkbenchService } from '../server/domain/workbench-service.mjs'
import { validateGroundedClaims } from '../server/domain/claim-grounding.mjs'
const argument = key => process.argv.find(x => x.startsWith('--' + key + '='))?.slice(key.length + 3)
const db = argument('db'), domain = argument('domain'), runId = argument('run')
if (!db || !domain || !runId) throw Error('Provide --db, --domain and --run. Default is validation only; --apply seals the original candidate before its deadline.')
const store = createCourseStore({ path: db }), workbench = createWorkbenchService({ path: domain })
try {
  const run = store.requireRun(runId), request = store.requireRequest(run.requestId)
  const call = run.state.main.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []).findLast(item => item.function.name === 'propose_forecast')
  const candidate = JSON.parse(call.function.arguments)
  validateGroundedClaims(candidate.reasoningClaims, store.evidenceFor(runId), { asOf: store.clock() })
  console.log(JSON.stringify({ runId, probabilityFromOriginalModel: candidate.probabilityYes, targetAt: request.normalized.targetAt, now: store.clock(), modelRequestsUnchanged: run.usage.modelRequests, tokensUnchanged: run.usage.totalTokens, validationPassed: true }))
  if (process.argv.includes('--apply')) {
    const forecast = store.publishForecast(runId, candidate, workbench.getPrediction(run.predictionId), { recoverRecordedCandidate: true })
    console.log(JSON.stringify({ publishedForecastId: forecast.forecastId, publishedAt: forecast.publishedAt, publicationMode: forecast.publicationMode, probabilityYes: forecast.probabilityYes }))
  }
} finally { store.close(); workbench.close() }
