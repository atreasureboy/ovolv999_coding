import { describe, it, expect } from 'vitest'
import {
  handleVimKey,
  createVimState,
  modeIndicator,
  type VimState,
} from '../src/ui/vim.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalState(text: string, cursor: number): VimState {
  return { mode: 'normal', text, cursor }
}

function insertState(text: string, cursor: number): VimState {
  return { mode: 'insert', text, cursor }
}

function visualState(text: string, cursor: number, visualStart: number): VimState {
  return { mode: 'visual', text, cursor, visualStart }
}

function press(state: VimState, input: string, key: Record<string, boolean> = {}): VimState {
  return handleVimKey(state, input, key).state
}

// ── Mode indicator ──────────────────────────────────────────────────────────

describe('modeIndicator', () => {
  it('shows INSERT for insert mode', () => {
    expect(modeIndicator('insert')).toBe('-- INSERT --')
  })

  it('shows empty for normal mode', () => {
    expect(modeIndicator('normal')).toBe('')
  })

  it('shows VISUAL for visual mode', () => {
    expect(modeIndicator('visual')).toBe('-- VISUAL --')
  })
})

// ── Normal mode: basic motions ──────────────────────────────────────────────

describe('Normal mode motions', () => {
  it('h moves left', () => {
    const s = press(normalState('hello', 3), 'h')
    expect(s.cursor).toBe(2)
  })

  it('l moves right', () => {
    const s = press(normalState('hello', 1), 'l')
    expect(s.cursor).toBe(2)
  })

  it('h does not go below 0', () => {
    const s = press(normalState('hello', 0), 'h')
    expect(s.cursor).toBe(0)
  })

  it('l does not go past end', () => {
    const s = press(normalState('hello', 4), 'l')
    expect(s.cursor).toBe(4)
  })

  it('0 moves to start of line', () => {
    const s = press(normalState('hello world', 7), '0')
    expect(s.cursor).toBe(0)
  })

  it('$ moves to end of line', () => {
    const s = press(normalState('hello world', 0), '$')
    expect(s.cursor).toBe(10)
  })

  it('w moves to next word start', () => {
    const s = press(normalState('hello world', 0), 'w')
    expect(s.cursor).toBe(6)
  })

  it('b moves to previous word start', () => {
    const s = press(normalState('hello world', 6), 'b')
    expect(s.cursor).toBe(0)
  })

  it('e moves to end of current word', () => {
    const s = press(normalState('hello world', 0), 'e')
    expect(s.cursor).toBe(4)
  })

  it('w handles punctuation', () => {
    const s = press(normalState('foo.bar baz', 0), 'w')
    expect(s.cursor).toBe(3)
  })

  it('G moves to last line', () => {
    const s = press(normalState('line1\nline2\nline3', 0), 'G')
    expect(s.cursor).toBe(12) // start of "line3"
  })

  it('j moves down a line', () => {
    const s = press(normalState('hello\nworld', 2), 'j')
    expect(s.cursor).toBe(8) // column 2 in second line
  })

  it('k moves up a line', () => {
    const s = press(normalState('hello\nworld', 8), 'k')
    expect(s.cursor).toBe(2) // column 2 in first line
  })
})

// ── Normal mode: count prefix ───────────────────────────────────────────────

describe('Count prefix', () => {
  it('3l moves right 3 characters', () => {
    let s = press(normalState('hello', 0), '3')
    s = press(s, 'l')
    expect(s.cursor).toBe(3)
  })

  it('2w moves forward 2 words', () => {
    let s = press(normalState('one two three', 0), '2')
    s = press(s, 'w')
    expect(s.cursor).toBe(8) // start of "three"
  })

  it('count resets after motion', () => {
    let s = press(normalState('hello', 0), '3')
    s = press(s, 'l')
    expect(s.count).toBeUndefined()
  })

  it('0 is a motion when no count, digit when count active', () => {
    // Plain 0 → line start
    let s = press(normalState('hello world', 5), '0')
    expect(s.cursor).toBe(0)
    // 10 → count 10
    s = press(normalState('hello', 0), '1')
    s = press(s, '0')
    expect(s.count).toBe(10)
  })
})

// ── Normal mode: entering insert ────────────────────────────────────────────

describe('Entering insert mode', () => {
  it('i enters insert mode at cursor', () => {
    const s = press(normalState('hello', 2), 'i')
    expect(s.mode).toBe('insert')
    expect(s.cursor).toBe(2)
  })

  it('a enters insert mode after cursor', () => {
    const s = press(normalState('hello', 2), 'a')
    expect(s.mode).toBe('insert')
    expect(s.cursor).toBe(3)
  })

  it('A enters insert mode at end of line', () => {
    const s = press(normalState('hello', 0), 'A')
    expect(s.mode).toBe('insert')
    expect(s.cursor).toBe(5) // past last char (5 chars, index 0-4, past = 5)
  })

  it('I enters insert at start of line', () => {
    const s = press(normalState('hello', 3), 'I')
    expect(s.mode).toBe('insert')
    expect(s.cursor).toBe(0)
  })

  it('o opens new line below', () => {
    const s = press(normalState('hello', 2), 'o')
    expect(s.mode).toBe('insert')
    expect(s.text).toBe('hello\n')
    expect(s.cursor).toBe(6) // start of the new empty line
  })

  it('O opens new line above', () => {
    const s = press(normalState('hello', 2), 'O')
    expect(s.mode).toBe('insert')
    expect(s.text).toBe('\nhello')
    expect(s.cursor).toBe(0)
  })
})

// ── Normal mode: editing ────────────────────────────────────────────────────

describe('Normal mode editing', () => {
  it('x deletes character under cursor', () => {
    const s = press(normalState('hello', 0), 'x')
    expect(s.text).toBe('ello')
    expect(s.cursor).toBe(0)
    expect(s.register).toBe('h')
  })

  it('dd deletes entire line', () => {
    let s = press(normalState('line1\nline2', 7), 'd')
    s = press(s, 'd')
    // "line2" is the second line (no trailing newline). Deletion removes it.
    expect(s.text).toBe('line1\n')
    expect(s.register).toBe('line2')
    expect(s.registerLinewise).toBe(true)
  })

  it('dw deletes to next word', () => {
    let s = press(normalState('hello world', 0), 'd')
    s = press(s, 'w')
    expect(s.text).toBe('world')
  })

  it('d$ deletes to end of line', () => {
    let s = press(normalState('hello world', 5), 'd')
    s = press(s, '$')
    expect(s.text).toBe('hello')
  })

  it('d0 deletes to start of line', () => {
    let s = press(normalState('hello world', 5), 'd')
    s = press(s, '0')
    expect(s.text).toBe(' world')
  })

  it('cw changes word (delete + insert)', () => {
    let s = press(normalState('hello world', 0), 'c')
    s = press(s, 'w')
    expect(s.text).toBe('world')
    expect(s.mode).toBe('insert')
  })

  it('y yanks without deleting', () => {
    let s = press(normalState('hello world', 0), 'y')
    s = press(s, 'w')
    expect(s.text).toBe('hello world') // unchanged
    expect(s.register).toBe('hello ')
  })

  it('p pastes after cursor', () => {
    const state = { ...normalState('hello', 0), register: 'XX' }
    const s = press(state, 'p')
    expect(s.text).toBe('hXXello')
  })

  it('ESC cancels pending operator', () => {
    let s = press(normalState('hello', 0), 'd')
    s = press(s, '\x1b')
    expect(s.pendingOperator).toBeUndefined()
  })

  it('ESC in normal mode clears count', () => {
    let s = press(normalState('hello', 0), '3')
    s = press(s, '\x1b')
    expect(s.count).toBeUndefined()
  })
})

// ── Insert mode ─────────────────────────────────────────────────────────────

describe('Insert mode', () => {
  it('types a character', () => {
    const s = press(insertState('hi', 1), 'X')
    expect(s.text).toBe('hXi')
    expect(s.cursor).toBe(2)
  })

  it('backspace deletes', () => {
    const s = press(insertState('hello', 3), '', { backspace: true })
    expect(s.text).toBe('helo')
    expect(s.cursor).toBe(2)
  })

  it('left arrow moves cursor', () => {
    const s = press(insertState('hello', 3), '', { leftArrow: true })
    expect(s.cursor).toBe(2)
  })

  it('right arrow moves cursor', () => {
    const s = press(insertState('hello', 3), '', { rightArrow: true })
    expect(s.cursor).toBe(4)
  })

  it('ESC returns to normal mode', () => {
    const s = press(insertState('hello', 3), '\x1b')
    expect(s.mode).toBe('normal')
    expect(s.cursor).toBe(2) // moves back one
  })

  it('does not handle ctrl combinations', () => {
    const s = press(insertState('hello', 3), 'l', { ctrl: true })
    expect(s.text).toBe('hello') // unchanged
  })
})

// ── Visual mode ─────────────────────────────────────────────────────────────

describe('Visual mode', () => {
  it('v enters visual mode', () => {
    const s = press(normalState('hello', 2), 'v')
    expect(s.mode).toBe('visual')
    expect(s.visualStart).toBe(2)
  })

  it('extends selection with motion', () => {
    let s = press(normalState('hello world', 0), 'v')
    s = press(s, 'l')
    expect(s.mode).toBe('visual')
    expect(s.cursor).toBe(1)
  })

  it('d deletes selection', () => {
    let s = press(normalState('hello world', 0), 'v')
    s = press(s, 'l')
    s = press(s, 'l')
    s = press(s, 'd')
    // Visual selection [0..2] inclusive = 3 chars = "hel"
    expect(s.text).toBe('lo world')
    expect(s.mode).toBe('normal')
    expect(s.register).toBe('hel')
  })

  it('x also deletes selection', () => {
    let s = press(normalState('hello', 1), 'v')
    s = press(s, 'l')
    s = press(s, 'x')
    // Selection [1..2] = "el", delete leaves "hlo"
    expect(s.text).toBe('hlo')
  })

  it('y yanks selection without deleting', () => {
    let s = press(normalState('hello', 0), 'v')
    s = press(s, 'l')
    s = press(s, 'y')
    // Selection [0..1] = "he"
    expect(s.text).toBe('hello')
    expect(s.register).toBe('he')
  })

  it('ESC exits visual mode', () => {
    const s = press(visualState('hello', 3, 1), '\x1b')
    expect(s.mode).toBe('normal')
    expect(s.visualStart).toBeUndefined()
  })

  it('selection extends backward', () => {
    let s = press(normalState('hello', 3), 'v')
    s = press(s, 'h')
    expect(s.cursor).toBe(2)
    // Delete should remove chars from min(2,3) to max(2,3)+1 = [2,4)
    s = press(s, 'd')
    expect(s.text).toBe('heo')
  })
})

// ── Integration: full flow ──────────────────────────────────────────────────

describe('Integration flows', () => {
  it('type → ESC → move → i → type', () => {
    let s = createVimState('insert')
    // Type "hello"
    for (const ch of 'hello') s = press(s, ch)
    expect(s.text).toBe('hello')
    // ESC to normal
    s = press(s, '\x1b')
    expect(s.mode).toBe('normal')
    // Move to start
    s = press(s, '0')
    expect(s.cursor).toBe(0)
    // Insert mode + type '>'
    s = press(s, 'i')
    s = press(s, '>')
    expect(s.text).toBe('>hello')
  })

  it('delete a word then paste', () => {
    let s = normalState('foo bar baz', 0)
    // dw → delete "foo "
    s = press(s, 'd')
    s = press(s, 'w')
    expect(s.text).toBe('bar baz')
    // Move to end
    s = press(s, '$')
    // p → paste after
    s = press(s, 'p')
    expect(s.text).toContain('foo')
  })

  it('multi-step: visual select + delete', () => {
    let s = createVimState('insert')
    for (const ch of 'abcdef') s = press(s, ch)
    s = press(s, '\x1b')
    s = press(s, '0') // start of line
    s = press(s, 'v') // visual
    s = press(s, 'l'); s = press(s, 'l') // select 3 chars
    s = press(s, 'd') // delete
    expect(s.text).toBe('def')
  })
})

// ── createVimState ──────────────────────────────────────────────────────────

describe('createVimState', () => {
  it('creates insert state by default', () => {
    const s = createVimState()
    expect(s.mode).toBe('insert')
    expect(s.text).toBe('')
    expect(s.cursor).toBe(0)
  })

  it('creates normal state', () => {
    const s = createVimState('normal')
    expect(s.mode).toBe('normal')
  })
})
