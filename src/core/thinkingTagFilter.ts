/**
 * Removes MiniMax/OpenAI-compatible <think> blocks from streamed assistant
 * content. Tags may be split across arbitrary stream chunk boundaries.
 *
 * Thinking content is captured separately — call `drainThinking()` after
 * `push()` to retrieve accumulated reasoning text (if any).
 */
export class ThinkingTagFilter {
  private buffer = ''
  private insideThinking = false
  private thinkingAccumulator = ''

  push(chunk: string): string {
    this.buffer += chunk
    let visible = ''

    while (this.buffer.length > 0) {
      if (this.insideThinking) {
        const closeIndex = this.buffer.indexOf('</think>')
        if (closeIndex >= 0) {
          this.thinkingAccumulator += this.buffer.slice(0, closeIndex)
          this.buffer = this.buffer.slice(closeIndex + '</think>'.length)
          this.insideThinking = false
          continue
        }

        // Might be a partial </think> at the end — keep the prefix as thinking
        const retained = this.keepPossibleTagPrefix(this.buffer, '</think>')
        this.thinkingAccumulator += this.buffer.slice(0, this.buffer.length - retained.length)
        this.buffer = retained
        break
      }

      const openIndex = this.buffer.indexOf('<think>')
      if (openIndex >= 0) {
        visible += this.buffer.slice(0, openIndex)
        this.buffer = this.buffer.slice(openIndex + '<think>'.length)
        this.insideThinking = true
        continue
      }

      const retained = this.keepPossibleTagPrefix(this.buffer, '<think>')
      visible += this.buffer.slice(0, this.buffer.length - retained.length)
      this.buffer = retained
      break
    }

    return visible
  }

  /** Returns accumulated thinking content since the last call, then resets. */
  drainThinking(): string {
    const t = this.thinkingAccumulator
    this.thinkingAccumulator = ''
    return t
  }

  finish(): string {
    const visible = this.insideThinking ? '' : this.buffer
    this.buffer = ''
    this.insideThinking = false
    return visible
  }

  private keepPossibleTagPrefix(value: string, tag: string): string {
    const maxLength = Math.min(value.length, tag.length - 1)
    for (let length = maxLength; length > 0; length--) {
      const suffix = value.slice(-length)
      if (tag.startsWith(suffix)) return suffix
    }
    return ''
  }
}
