/**
 * Paste truncation — detects large paste input and replaces with a
 * compact placeholder reference, similar to Claude Code's behavior.
 *
 * When a paste exceeds the threshold, the text is stored in a paste store
 * and replaced with `[Pasted text #N +M lines]` in the input. The full
 * paste content is retrieved by reference when the prompt is submitted.
 */

const PASTE_THRESHOLD = 10_000

interface StoredPaste {
  id: number
  text: string
  lines: number
}

class PasteStore {
  private pastes = new Map<number, StoredPaste>()
  private nextId = 1

  /** Store a paste and return the placeholder reference. */
  store(text: string): string {
    const id = this.nextId++
    const lines = text.split('\n').length
    this.pastes.set(id, { id, text, lines })
    return `[Pasted text #${id} +${lines} lines]`
  }

  /** Retrieve the original paste content by ID. */
  get(id: number): string | undefined {
    return this.pastes.get(id)?.text
  }

  /**
   * Expand all `[Pasted text #N ...]` references in a string to their
   * original content. Called before sending the prompt to the engine.
   */
  expand(text: string): string {
    return text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (match: string, idStr: string) => {
      const id = parseInt(idStr, 10)
      return this.get(id) ?? match
    })
  }

  /** Check if input exceeds the paste threshold. */
  isLargePaste(input: string): boolean {
    return input.length > PASTE_THRESHOLD
  }

  /** Threshold value (exposed for testing). */
  get threshold(): number {
    return PASTE_THRESHOLD
  }
}

/** Singleton paste store instance. */
export const pasteStore = new PasteStore()
