import { appendFileSync } from 'node:fs'

const [action, target] = process.argv.slice(2)
if (action === 'deny') {
  process.stderr.write('protected file')
  process.exitCode = 2
} else if (action === 'rewrite') {
  process.stdout.write(JSON.stringify({ action: 'continue', updatedInput: { file_path: target, content: 'changed' } }))
} else if (action === 'record') {
  appendFileSync(target, process.env.HOOK_EVENT + '\n')
} else if (action === 'environment') {
  process.stdout.write(JSON.stringify({ action: process.env.OVOGO_TEST_API_KEY ? 'deny' : 'continue', reason: process.env.OVOGO_TEST_API_KEY ? 'credential exposed' : 'credential absent' }))
} else if (action === 'fail') {
  process.exitCode = 9
} else if (action === 'wait') {
  setTimeout(() => {}, 30000)
} else if (action === 'leak') {
  process.stderr.write(target)
  process.exitCode = 2
} else {
  throw new Error('Unknown hook fixture action')
}
