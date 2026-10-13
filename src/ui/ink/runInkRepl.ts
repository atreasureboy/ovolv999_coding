import { render } from 'ink'
import { createElement } from 'react'
import { registerCleanup } from '../../utils/cleanup.js'
import { createInkReplController, type InkReplControllerOptions } from './replController.js'

export interface InkReplOptions extends Omit<InkReplControllerOptions, 'onExit'> {
  version: string
  model: string
  maxContextTokens: number
}

export async function runInkRepl(opts: InkReplOptions): Promise<void> {
  const controller = createInkReplController({ ...opts, onExit: () => instance.unmount() })
  try { await controller.initialize() } catch (error) {
    opts.store.addError(error instanceof Error ? error.message : String(error))
    opts.store.addInfo('Use /recover --fork to continue from saved history in a new session.')
  }
  const { App } = await import('./App.js')
  const instance = render(
    createElement(App, {
      store: opts.store,
      _version: opts.version,
      model: opts.model,
      skills: opts.skills,
      runTurn: (prompt, _history, images, displayPrompt) => controller.runTurn(prompt, images, displayPrompt),
      displayUserViaEvents: true,
      dispatchSlash: controller.dispatchSlash,
      initialHistory: controller.getHistory(),
      getHistory: controller.getHistory,
      getModelHistory: controller.getModelHistory,
      onInterrupt: () => { void controller.interrupt().catch(error => opts.store.addError(error instanceof Error ? error.message : String(error))) },
      maxContextTokens: opts.maxContextTokens,
      cwd: opts.cwd,
    }),
  )
  opts.store.setBanner(opts.version, opts.model)
  const cleanup = registerCleanup({
    onCleanup: async () => {
      opts.store.cancelOverlays()
      try {
        await controller.release()
      } finally {
        instance.unmount()
      }
    },
  })
  try {
    await instance.waitUntilExit()
  } finally {
    await cleanup()
  }
}
