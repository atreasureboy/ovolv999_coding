/**
 * highlight — lightweight syntax highlighter for Ink code rendering.
 *
 * Supports: TypeScript/JavaScript, Python, Bash, JSON, and generic.
 * Not a full parser — uses regex tokenization for common patterns.
 *
 * Token colors:
 *   keyword   → magenta
 *   string    → green
 *   comment   → gray (dim)
 *   number    → yellow
 *   type      → cyan
 *   function  → blue
 *   punct     → white (dim)
 *   plain     → default
 */

export interface HighlightToken {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

// ── Language keyword sets ───────────────────────────────────────────────────

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'extends', 'implements',
  'interface', 'type', 'enum', 'namespace', 'module', 'import', 'export',
  'from', 'as', 'default', 'new', 'delete', 'typeof', 'instanceof', 'in',
  'of', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'return', 'throw', 'try', 'catch', 'finally', 'async',
  'await', 'yield', 'static', 'public', 'private', 'protected', 'readonly',
  'abstract', 'get', 'set', 'void', 'null', 'undefined', 'true', 'false',
  'this', 'super', 'require', 'satisfies', 'keyof', 'infer', 'is',
])

const PY_KEYWORDS = new Set([
  'def', 'class', 'import', 'from', 'as', 'if', 'elif', 'else', 'for',
  'while', 'return', 'yield', 'with', 'try', 'except', 'finally', 'raise',
  'pass', 'break', 'continue', 'lambda', 'global', 'nonlocal', 'assert',
  'del', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'self',
  'async', 'await', 'print',
])

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly',
  'echo', 'printf', 'read', 'source', 'alias', 'unset', 'set', 'shift',
  'cd', 'pwd', 'true', 'false',
])

const JSON_KEYWORDS = new Set(['true', 'false', 'null'])

function getKeywords(lang: string): Set<string> {
  switch (lang) {
    case 'ts':
    case 'typescript':
    case 'js':
    case 'javascript':
    case 'tsx':
    case 'jsx':
      return TS_KEYWORDS
    case 'py':
    case 'python':
      return PY_KEYWORDS
    case 'bash':
    case 'sh':
    case 'shell':
    case 'zsh':
      return BASH_KEYWORDS
    case 'json':
      return JSON_KEYWORDS
    default:
      return TS_KEYWORDS // fallback — TS keywords are a superset
  }
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

const TOKEN_RE = new RegExp(
  '(' +
    '(?<lineComment>\\/\\/[^\\n]*|\\#[^\\n]*)' +
    '|(?<blockComment>\\/\\*[\\s\\S]*?\\*\\/)' +
    '|(?<dqString>"(?:[^"\\\\]|\\\\.)*")' +
    "|(?<sqString>'(?:[^'\\\\]|\\\\.)*')" +
    '|(?<btString>`(?:[^`\\\\]|\\\\.)*`)' +
    '|(?<number>\\b\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?(?:0x[0-9a-fA-F]+)?\\b)' +
    '|(?<identifier>[A-Za-z_$][A-Za-z0-9_$]*)' +
    '|(?<ws>\\s+)' +
    '|(?<other>[^\\sA-Za-z0-9_$])' +
  ')',
  'gy',
)

export function tokenize(code: string, lang: string): HighlightToken[] {
  const keywords = getKeywords(lang)
  const tokens: HighlightToken[] = []
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = TOKEN_RE.exec(code)) !== null) {
    const g = match.groups!
    const text = match[0]

    if (g.lineComment || g.blockComment) {
      tokens.push({ text, dim: true })
    } else if (g.dqString || g.sqString || g.btString) {
      tokens.push({ text, color: 'green' })
    } else if (g.number) {
      tokens.push({ text, color: 'yellow' })
    } else if (g.identifier) {
      if (keywords.has(text)) {
        tokens.push({ text, color: 'magenta', bold: false })
      } else if (/^[A-Z]/.test(text) && text.length > 1) {
        // Type / class name
        tokens.push({ text, color: 'cyan' })
      } else {
        // Look ahead for ( → function call
        const rest = code.slice(TOKEN_RE.lastIndex)
        if (rest[0] === '(') {
          tokens.push({ text, color: 'blue' })
        } else {
          tokens.push({ text })
        }
      }
    } else if (g.ws) {
      tokens.push({ text })
    } else if (g.other) {
      const isPunct = '{}()[];,.'.includes(text)
      tokens.push({ text, dim: isPunct })
    }
  }

  return tokens
}

/** Convenience: tokenize and return as segments suitable for Ink <Text> children. */
export function highlight(code: string, lang: string): HighlightToken[] {
  if (!code) return []
  return tokenize(code, lang)
}
