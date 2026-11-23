import { configureEnvironment } from './server/environment.mjs'

try {
  Object.assign(process.env, configureEnvironment(process.env, 'live'))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
await import('./server/app.mjs')
