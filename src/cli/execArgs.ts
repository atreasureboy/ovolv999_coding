import type { EffortLevel } from '../core/effort.js'
import { isEffortLevel } from '../core/effort.js'
import { ArgError, requireValue } from './args.js'

export interface ExecArgs {
  jsonl: boolean
  task: string
  outputSchemaPath?: string
  resume?: string
  continueSession: boolean
  cwd?: string
  model?: string
  effort?: EffortLevel
}

export function parseExecArgs(argv: string[]): ExecArgs {
  if (argv[0] !== 'exec') throw new ArgError('Error: exec arguments must begin with exec')
  const result: ExecArgs = { jsonl: false, task: '', continueSession: false }
  const task: string[] = []
  const seen = new Set<string>()
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--') {
      task.push(...argv.slice(index + 1))
      break
    }
    if (!flag.startsWith('-')) {
      task.push(flag)
      continue
    }
    if (seen.has(flag)) throw new ArgError(`Error: duplicate exec flag ${flag}`)
    seen.add(flag)
    switch (flag) {
      case '--jsonl':
        result.jsonl = true
        break
      case '--continue':
        result.continueSession = true
        break
      case '--cwd':
        result.cwd = requireValue(flag, argv[++index])
        break
      case '--model':
        result.model = requireValue(flag, argv[++index])
        break
      case '--effort': {
        const effort = requireValue(flag, argv[++index])
        if (!isEffortLevel(effort))
          throw new ArgError('Error: --effort must be minimal, low, medium, high, or maximum')
        result.effort = effort
        break
      }
      case '--resume':
        result.resume = requireValue(flag, argv[++index])
        break
      case '--output-schema':
        result.outputSchemaPath = requireValue(flag, argv[++index])
        break
      default:
        throw new ArgError(`Error: unsupported exec flag ${flag}`)
    }
  }
  if (!result.jsonl) throw new ArgError('Error: --jsonl is required for exec')
  if (result.resume !== undefined && result.continueSession)
    throw new ArgError('Error: --resume and --continue are mutually exclusive')
  result.task = task.join(' ')
  return result
}
