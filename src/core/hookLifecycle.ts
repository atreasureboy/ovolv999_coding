import { randomUUID } from 'node:crypto'
import { createProcessScope } from './executionBackend.js'
import { runOperation, withWorkspaceAccess, type RunContext } from './runContext.js'
import type { EngineConfig } from './types.js'

export function runHookOperation<T>(run: RunContext, config: EngineConfig, event: string, operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
  return runOperation(run, 'hook:' + event, () => withWorkspaceAccess(config.cwd, run.familyId, true, run.controller.signal, async () => {
    const scope = createProcessScope(config.executionProfile)
    try {
      return await scope.run(() => Promise.resolve(operation(run.controller.signal)))
    } finally {
      for (const resource of scope.pending) {
        const id = 'physical:hook:' + event + ':' + randomUUID()
        run.pending.set(id, resource)
        void resource.then(() => run.pending.delete(id), () => undefined)
      }
    }
  }), 60000, config.cancellationGraceMs ?? 2000)
}
