import { spawn, type ChildProcess } from 'node:child_process'

const writerSource = `
const fail = error => {
  process.send?.({ error: String(error.message ?? error) });
  process.exitCode = 1;
};
process.stdout.on('error', fail);
process.on('message', text => {
  if (typeof text !== 'string') { fail(new Error('Invalid output frame')); return; }
  process.stdout.write(text, error => {
    if (error) fail(error);
    else process.send?.({ written: true });
  });
});
`

interface OutputFrame {
  text: string
  bytes: number
  resolve: () => void
  reject: (error: Error) => void
}

export class ProtocolOutput {
  private writer?: ChildProcess
  private exited?: Promise<void>
  private closing = false
  private failure?: Error
  private active?: OutputFrame
  private queue: OutputFrame[] = []
  private buffered = 0
  private disposal?: Promise<void>

  constructor(private readonly onFailure: (error: Error) => void, private readonly maxBytes = 4 * 1024 * 1024) {
    process.stdout.on('error', this.abort)
  }

  get pendingBytes(): number { return this.buffered }

  readonly abort = (error: Error): void => {
    if (this.failure) return
    this.failure = error
    this.closing = true
    this.active?.reject(error)
    this.active = undefined
    for (const frame of this.queue.splice(0)) frame.reject(error)
    this.buffered = 0
    if (this.writer) this.writer.kill()
    else process.stdout.unref?.()
    this.onFailure(error)
  }

  write(text: string): Promise<void> {
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new Error('Protocol output is closed'))
    const bytes = Buffer.byteLength(text)
    if (this.buffered + bytes > this.maxBytes) {
      const error = new Error('Protocol output byte limit exceeded')
      this.abort(error)
      return Promise.reject(error)
    }
    this.buffered += bytes
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, bytes, resolve, reject })
      this.pump()
    })
  }

  private startWriter(): void {
    if (this.writer || process.platform !== 'win32' || process.stdout.isTTY || process.stdout.fd !== 1) return
    this.writer = spawn(process.execPath, ['-e', writerSource], { windowsHide: true, env: {}, stdio: ['ignore', 1, 'ignore', 'ipc'] })
    this.exited = new Promise(resolve => {
      this.writer!.once('exit', () => resolve())
      this.writer!.once('error', () => { if (!this.writer!.pid) resolve() })
    })
    this.writer.on('error', this.abort)
    this.writer.on('message', message => {
      if (this.failure) return
      const event = message as { error?: unknown; written?: unknown }
      if (typeof event.error === 'string') this.abort(new Error(event.error))
      else if (event.written === true && this.active) this.finish(this.active)
      else this.abort(new Error('Invalid output writer acknowledgement'))
    })
    this.writer.once('exit', () => { if (!this.closing) this.abort(new Error('Protocol output writer exited')) })
  }

  private pump(): void {
    if (this.active || this.failure || !this.queue.length) return
    const frame = this.queue.shift()!
    this.active = frame
    try {
      this.startWriter()
      if (this.writer) this.writer.send(frame.text, error => { if (error) this.finish(frame, error) })
      else process.stdout.write(frame.text, error => this.finish(frame, error))
    } catch (error) { this.finish(frame, error instanceof Error ? error : new Error(String(error))) }
  }

  private finish(frame: OutputFrame, error?: Error | null): void {
    if (this.active !== frame) return
    if (error) { this.abort(error); return }
    this.active = undefined
    this.buffered -= frame.bytes
    frame.resolve()
    this.pump()
  }

  close(): Promise<void> {
    this.disposal ??= (async () => {
      if (this.buffered) this.abort(new Error('Protocol output closed before draining'))
      this.closing = true
      if (this.writer?.connected) this.writer.disconnect()
      const deadline = this.writer ? setTimeout(() => this.writer!.kill(), 1000) : undefined
      try { await this.exited } finally {
        clearTimeout(deadline)
        this.writer?.channel?.unref()
        process.stdout.off('error', this.abort)
      }
    })()
    return this.disposal
  }
}
