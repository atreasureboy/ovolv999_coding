export async function handleSessionSubcommand(cmd: string, args: string[]): Promise<void> {
  const {
    listSessions,
    getSession,
    readSessionLogs,
    attachToSession,
    stopSession,
    removeSession,
    cleanStaleSessions,
    formatSessionList,
    formatSessionDetail,
  } = await import('../core/backgroundSession.js')
  switch (cmd) {
    case 'ps': {
      const sessions = listSessions()
      process.stdout.write(formatSessionList(sessions) + '\n')
      process.exit(0)
      break
    }
    case 'logs': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 logs <session-id> [--tail N]\n')
        process.exit(1)
      }
      const tailIdx = args.indexOf('--tail')
      const tail = tailIdx >= 0 ? parseInt(args[tailIdx + 1] ?? '50', 10) : undefined
      const meta = getSession(id)
      if (!meta) {
        process.stderr.write(`Error: no session with id "${id}"\n`)
        process.exit(1)
      }
      const logs = readSessionLogs(id, tail ? { tailLines: tail } : {})
      process.stdout.write(logs)
      if (!logs.endsWith('\n')) process.stdout.write('\n')
      process.exit(0)
      break
    }
    case 'attach': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 attach <session-id>\n')
        process.exit(1)
      }
      const handle = attachToSession(id)
      if (!handle) {
        process.stderr.write(`Error: no session with id "${id}"\n`)
        process.exit(1)
      }
      process.stdout.write(
        formatSessionDetail(handle.metadata) + '\n\n--- streaming logs (Ctrl-C to detach) ---\n',
      )
      for await (const line of handle.stream) {
        process.stdout.write(line + '\n')
      }
      process.stdout.write('\n[session ended]\n')
      process.exit(0)
      break
    }
    case 'stop': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 stop <session-id>\n')
        process.exit(1)
      }
      const result = await stopSession(id)
      if (result.status === 'failed' || result.status === 'not_found') {
        process.stderr.write(
          `Error: could not stop session "${id}": ${result.reason ?? result.status}\n`,
        )
        process.exit(1)
      }
      process.stdout.write(
        `${result.status === 'stopped' ? 'Stopped' : 'Stopping'} session ${id}\n`,
      )
      process.exit(result.status === 'stopped' ? 0 : 2)
      break
    }
    case 'rm': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 rm <session-id> [--force]\n')
        process.exit(1)
      }
      const force = args.includes('--force')
      const ok = removeSession(id, force)
      if (!ok) {
        process.stderr.write(`Error: could not remove session "${id}" (running? use --force)\n`)
        process.exit(1)
      }
      process.stdout.write(`Removed session ${id}\n`)
      process.exit(0)
      break
    }
    case 'clean': {
      const n = cleanStaleSessions()
      process.stdout.write(`Cleaned ${n} stale session(s)\n`)
      process.exit(0)
      break
    }
    default:
      process.stderr.write(`Unknown session subcommand: ${cmd}\n`)
      process.exit(1)
  }
}

export const SESSION_SUBCOMMANDS: ReadonlyMap<string, string> = new Map([
  ['ps', 'ps'],
  ['sessions', 'ps'],
  ['attach', 'attach'],
  ['logs', 'logs'],
  ['stop', 'stop'],
  ['rm', 'rm'],
  ['remove', 'rm'],
  ['clean', 'clean'],
])
