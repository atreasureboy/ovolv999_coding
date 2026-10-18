import { InputHandler } from '../../../src/ui/input.js'
import { fileURLToPath } from 'node:url'

const [cwd, phase] = process.argv.slice(2)
Object.defineProperty(process.stdin, 'isTTY', { value: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true })
const inputs = phase === 'first'
  ? ['/profile init', '/profile switch strict', '/mode sharp', 'Write a fixture marker', '/exit']
  : ['Write a fixture marker', '/exit']
InputHandler.prototype.readLine = function () {
  return Promise.resolve(inputs.length ? { text: inputs.shift()!, eof: false } : { text: '', eof: true })
}
process.argv = [process.execPath, fileURLToPath(new URL('../../../bin/ovogogogo.ts', import.meta.url)), '--cwd', cwd]
await import('../../../bin/ovogogogo.js')
