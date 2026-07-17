/**
 * Safe string coercion for tool inputs.
 *
 * Tool inputs arrive as `Record<string, unknown>` (parsed JSON).  Calling
 * `String(unknown)` risks "[object Object]" for object/array values.
 * This helper narrows to primitives first.
 */
export function str(v: unknown, def = ''): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return def
}

/**
 * Normalize full-width digits (U+FF10 .. U+FF19) to ASCII `0`..`9`.
 *
 * Common source: a user typing on a CJK IME (Pinyin, Japanese, Korean)
 * hits the digit row by default in full-width form. Without
 * normalization a string like "１２３" would be sent to the LLM
 * verbatim; some tokenizers charge 2 tokens per CJK code point (see
 * NON_ASCII_CHARS_PER_TOKEN) and downstream regexes like `/^\d+$/`
 * would silently miss the input.
 *
 * Implementation: per-char mapping via charCodeAt offsets. The
 * contiguous Unicode range U+FF10..U+FF19 maps to ASCII `0`..`9` with
 * a uniform offset of `0xFEE1` (= 0x30 - 0xFF10). Single replace is
 * the simplest correct shape.
 */
export function normalizeFullWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30))
}

/**
 * Normalize the full-width ideographic space (U+3000) to a regular
 * ASCII space.
 *
 * Same IME context as {@link normalizeFullWidthDigits}: a user typing
 * in CJK mode often produces U+3000 between words. Compare/split logic
 * in user messages would otherwise disagree with downstream search.
 */
export function normalizeFullWidthSpace(s: string): string {
  // Use \u escape for U+3000 — the actual full-width space would trip
  // the no-irregular-whitespace lint rule and would be invisible in
  // code review anyway.
  return s.replace(/\u3000/g, ' ')
}

/**
 * Apply every CJK IME normalization in one call. Currently delegates
 * to {@link normalizeFullWidthDigits} and {@link normalizeFullWidthSpace};
 * additional normalizations (e.g. full-width ASCII letters) can be
 * added here without changing call sites.
 *
 * Use case: normalize the user's message at the engine boundary so
 * downstream tokens, regexes, and tool inputs all see a consistent
 * ASCII-flavored shape. The cost is negligible (one pass through the
 * string) and idempotent — running the function twice on its own
 * output is a no-op.
 */
export function normalizeCJKInput(s: string): string {
  return normalizeFullWidthSpace(normalizeFullWidthDigits(s))
}

/**
 * Escape regex metacharacters in a string for safe embedding in a
 * `new RegExp(...)` constructor.
 *
 * Mirrors the standard MDN-recommended escape pattern. Used by tools
 * that build regexes from user-supplied strings (Grep, Glob, etc.) —
 * skipping this is the canonical "ReDoS / partial-match / wrong-target"
 * bug when the user includes a literal `.` or `*`.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Safe JSON parse — returns `fallback` on any failure (malformed
 * input, bigint overflow, NaN, etc.) instead of throwing.
 *
 * Use when the input is known-bad or known-trustworthy-bounded (e.g.
 * a log line, a tag line, an env-supplied JSON blob). For
 * user-controlled input that should be REJECTED on malformed JSON
 * (auth tokens, config payloads), prefer a direct `JSON.parse` so
 * the error propagates.
 */
export function safeParseJSON<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
