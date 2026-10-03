import { StringDecoder } from 'string_decoder'

interface FramedInputHandlers {
  onFrame: (line: string) => void
  onError: (error: Error) => void
  onClose: () => void
}

export function attachFramedInput(input: NodeJS.ReadableStream, maxMessageBytes: number, handlers: FramedInputHandlers): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const receive = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (;;) {
      const newline = buffer.indexOf('\n')
      const length = Buffer.byteLength(newline < 0 ? buffer : buffer.slice(0, newline))
      if (length > maxMessageBytes) {
        handlers.onError(new Error('ACP message byte limit exceeded'))
        return
      }
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      handlers.onFrame(line)
    }
  }
  input.on('data', receive)
  input.once('end', handlers.onClose)
  return () => {
    input.removeListener('data', receive)
    input.removeListener('end', handlers.onClose)
    buffer = ''
  }
}
