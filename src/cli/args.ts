import { resolveApiEnvironment } from './environment.js'
import { normalizeCwd } from './paths.js'
export interface Args {
  task?: string
  model: string
  modelExplicit?: boolean
  maxIter: number
  cwd: string
  help: boolean
  version: boolean
  loop: boolean
  loopMaxIters: number
  continueSession: boolean
  resumeSession?: string
  ink: boolean
  pipe: boolean
  pipeFormat: 'text' | 'json'
  bg: boolean
}
export class ArgError extends Error {}
export function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new ArgError(`Error: ${flag} requires a value`)
  }
  return value
}
function positiveInteger(flag: string, value: string | undefined): number {
  const raw = requireValue(flag, value)
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed <= 0) {
    throw new ArgError(`Error: ${flag} must be a positive integer (got "${raw}")`)
  }
  return parsed
}
export function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  let task: string | undefined
  let model = resolveApiEnvironment().model
  let modelExplicit = false
  let maxIter = parseInt(process.env.OVOGO_MAX_ITER ?? '200', 10)
  if (isNaN(maxIter) || maxIter <= 0) maxIter = 200
  let cwd = normalizeCwd(process.env.OVOGO_CWD ?? process.cwd())
  let help = false
  let version = false
  let loop = false
  let loopMaxIters = parseInt(process.env.OVOGO_LOOP_MAX_ITERS ?? '12', 10)
  if (isNaN(loopMaxIters) || loopMaxIters <= 0) loopMaxIters = 12
  let continueSession = false
  let resumeSession: string | undefined
  let ink = false
  let pipe = false
  let pipeFormat: 'text' | 'json' = 'text'
  let bg = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        help = true
        break
      case '--version':
      case '-v':
      case '-V':
        version = true
        break
      case '--model':
      case '-m':
        model = requireValue(arg, args[++i])
        modelExplicit = true
        break
      case '--max-iter':
        maxIter = positiveInteger(arg, args[++i])
        break
      case '--cwd':
        cwd = normalizeCwd(requireValue(arg, args[++i]))
        break
      case '--loop':
        loop = true
        break
      case '--loop-max-iters':
        loopMaxIters = positiveInteger(arg, args[++i])
        break
      case '--continue':
      case '-c':
        continueSession = true
        break
      case '--resume':
      case '-r':
        resumeSession = requireValue(arg, args[++i])
        break
      case '--ink':
        ink = true
        break
      case '--pipe':
        pipe = true
        break
      case '--bg':
        bg = true
        break
      case '--format': {
        const format = requireValue(arg, args[++i])
        if (format !== 'text' && format !== 'json') {
          throw new ArgError(`Error: --format must be "text" or "json" (got "${format}")`)
        }
        pipeFormat = format
        break
      }
      default:
        if (!arg.startsWith('-')) task = task ? task + ' ' + arg : arg
    }
  }
  return {
    task,
    model,
    modelExplicit,
    maxIter,
    cwd,
    help,
    version,
    loop,
    loopMaxIters,
    continueSession,
    resumeSession,
    ink,
    pipe,
    pipeFormat,
    bg,
  }
}
