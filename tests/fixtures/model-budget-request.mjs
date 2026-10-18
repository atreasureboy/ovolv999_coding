import OpenAI from 'openai'
import { createModelGateway } from '../../src/core/modelGateway.ts'

const [cwd, baseURL] = process.argv.slice(2)
process.on('message', async message => {
  if (message !== 'start') return
  const config = { cwd, apiKey: 'fixture-secret', baseURL, model: 'fixture-model', maxContextTokens: 16000, maxOutputTokens: 100, maxIterations: 1, permissionMode: 'deny', modelGateway: { maxAttempts: 1 } }
  const client = createModelGateway(new OpenAI({ apiKey: config.apiKey, baseURL }), config, () => null)
  try {
    await client.chat.completions.create({ model: config.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 })
    process.send?.({ completed: true })
  } catch (error) { process.send?.({ error: error instanceof Error ? error.message : String(error) }) }
  process.disconnect?.()
})
process.send?.({ ready: true })
