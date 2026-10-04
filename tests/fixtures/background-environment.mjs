import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

writeFileSync(join(process.cwd(), 'worker-environment.json'), JSON.stringify({
  ambientSecret: Boolean(process.env.OVO_TEST_SECRET_TOKEN),
  modelCredential: process.env.OPENAI_API_KEY === 'offline-model-credential',
  extra: process.env.OVO_TEST_ALLOWED,
  supervised: process.env.OVOGV999_SUPERVISED === '1',
  sessionId: process.env.OVOGV999_SESSION_ID,
}))
process.send?.({ type: 'ovogo:ready' })
setInterval(() => {}, 1000)
