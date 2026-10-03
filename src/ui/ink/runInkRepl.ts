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
  const { App } = await import('./App.js')
  const instance = render(
    createElement(App, {
      store: opts.store,
      _version: opts.version,
      model: opts.model,
      skills: opts.skills,
      runTurn: (prompt, _history, images) => controller.runTurn(prompt, images),
      dispatchSlash: controller.dispatchSlash,
      initialHistory: controller.getHistory(),
      getHistory: controller.getHistory,
      onInterrupt: () => opts.engine.abort(),
      maxContextTokens: opts.maxContextTokens,
      cwd: opts.cwd,
    }),
  )
  opts.store.setBanner(opts.version, opts.model)
  const cleanup = registerCleanup({
    onCleanup: async () => {
      controller.save()
      opts.store.cancelOverlays()
      opts.engine.abort()
      try {
        await opts.engine.dispose()
        controller.release()
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
