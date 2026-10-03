export class BoundedOutputBuffer {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private droppedBytes = 0

  constructor(private readonly bytesPerEnd: number) {}

  append(chunk: string): void {
    const bytes = Buffer.from(chunk, 'utf8')
    const headRoom = this.bytesPerEnd - this.head.length
    const headBytes = Math.min(headRoom, bytes.length)
    if (headBytes > 0) {
      this.head = Buffer.concat([this.head, bytes.subarray(0, headBytes)])
    }

    const remainder = bytes.subarray(headBytes)
    if (remainder.length === 0) return
    if (remainder.length >= this.bytesPerEnd) {
      this.droppedBytes += this.tail.length + remainder.length - this.bytesPerEnd
      this.tail = Buffer.from(remainder.subarray(remainder.length - this.bytesPerEnd))
      return
    }

    const combined = Buffer.concat([this.tail, remainder])
    const trimmedBytes = Math.max(0, combined.length - this.bytesPerEnd)
    this.tail = trimmedBytes > 0 ? Buffer.from(combined.subarray(trimmedBytes)) : combined
    this.droppedBytes += trimmedBytes
  }

  render(): string {
    if (this.droppedBytes === 0) return Buffer.concat([this.head, this.tail]).toString('utf8')
    const head = this.head.toString('utf8')
    const tail = this.tail.toString('utf8')
    const marker = `\n\n[... ${this.droppedBytes.toLocaleString()} bytes of live output dropped from the middle (kept ${this.bytesPerEnd.toLocaleString()} bytes at head + ${this.bytesPerEnd.toLocaleString()} bytes at tail) ...]\n`
    return head + marker + tail
  }
}
