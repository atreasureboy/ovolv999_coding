import { ArgError } from './args.js'
import { parseExecArgs, type ExecArgs } from './execArgs.js'

export type AcpArgs = Omit<ExecArgs, 'jsonl' | 'task' | 'outputSchemaPath'>

export function parseAcpArgs(argv: string[]): AcpArgs {
  if (argv[0] !== 'acp') throw new ArgError('Error: ACP arguments must begin with acp')
  const { task, outputSchemaPath, jsonl: _jsonl, ...options } = parseExecArgs(['exec', '--jsonl', ...argv.slice(1)])
  void _jsonl
  if (task || outputSchemaPath !== undefined) throw new ArgError('Error: acp accepts session, workspace, and model options only; send tasks over standard input')
  return options
}
