/**
 * highlight — lightweight syntax highlighter for Ink code rendering.
 *
 * Supports: TypeScript/JavaScript, Python, Bash, JSON, Go, Rust, Java,
 * C/C++, SQL, YAML, CSS, and generic.
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

const GO_KEYWORDS = new Set([
  'package', 'import', 'func', 'var', 'const', 'type', 'struct', 'interface',
  'map', 'chan', 'go', 'defer', 'return', 'if', 'else', 'for', 'range',
  'switch', 'case', 'default', 'break', 'continue', 'fallthrough', 'select',
  'nil', 'true', 'false', 'iota', 'make', 'new', 'len', 'cap', 'append',
  'panic', 'recover', 'print', 'println',
])

const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'trait', 'impl',
  'pub', 'use', 'mod', 'crate', 'self', 'super', 'as', 'in', 'ref', 'match',
  'if', 'else', 'for', 'while', 'loop', 'return', 'break', 'continue',
  'unsafe', 'async', 'await', 'move', 'dyn', 'where', 'type', 'true',
  'false', 'Some', 'None', 'Ok', 'Err', 'Result', 'Option', 'Vec', 'String',
  'box', 'extern', 'abstract', 'become', 'do', 'final', 'macro', 'try',
  'typeof', 'unsized', 'virtual', 'yield',
])

const JAVA_KEYWORDS = new Set([
  'public', 'private', 'protected', 'class', 'interface', 'extends',
  'implements', 'package', 'import', 'static', 'final', 'abstract', 'void',
  'int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short',
  'String', 'var', 'new', 'this', 'super', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'return', 'throw', 'throws',
  'try', 'catch', 'finally', 'null', 'true', 'false', 'instanceof',
  'synchronized', 'volatile', 'transient', 'native', 'enum', 'assert',
  'default', 'instanceof',
])

const C_KEYWORDS = new Set([
  'int', 'long', 'short', 'char', 'float', 'double', 'void', 'unsigned',
  'signed', 'const', 'static', 'extern', 'volatile', 'register', 'auto',
  'struct', 'union', 'enum', 'typedef', 'sizeof', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'default',
  'goto', 'inline', 'restrict', '_Bool', '_Complex', '_Imaginary',
  'NULL', 'true', 'false', 'include', 'define', 'undef', 'ifdef', 'ifndef',
])

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
  'ALTER', 'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'INTO', 'VALUES', 'SET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'ON', 'AS', 'AND',
  'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ORDER',
  'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'DEFAULT',
  'CHECK', 'CONSTRAINT', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'RETURNS',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'GRANT', 'REVOKE',
  'INT', 'INTEGER', 'VARCHAR', 'TEXT', 'BOOLEAN', 'DATE', 'TIMESTAMP',
  'SERIAL', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'REAL',
])

const CSS_KEYWORDS = new Set([
  'color', 'background', 'background-color', 'background-image', 'margin',
  'padding', 'border', 'border-radius', 'width', 'height', 'display',
  'position', 'top', 'left', 'right', 'bottom', 'flex', 'flex-direction',
  'flex-wrap', 'justify-content', 'align-items', 'grid', 'grid-template',
  'font-size', 'font-weight', 'font-family', 'line-height', 'text-align',
  'text-decoration', 'opacity', 'z-index', 'overflow', 'cursor', 'transition',
  'transform', 'animation', 'box-shadow', 'visible', 'hidden', 'block',
  'inline', 'none', 'auto', 'absolute', 'relative', 'fixed', 'sticky',
])

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
    case 'go':
    case 'golang':
      return GO_KEYWORDS
    case 'rs':
    case 'rust':
      return RUST_KEYWORDS
    case 'java':
    case 'jsp':
      return JAVA_KEYWORDS
    case 'c':
    case 'cpp':
    case 'c++':
    case 'h':
    case 'hpp':
      return C_KEYWORDS
    case 'sql':
      return SQL_KEYWORDS
    case 'css':
    case 'scss':
    case 'less':
      return CSS_KEYWORDS
    case 'yaml':
    case 'yml':
      return TS_KEYWORDS // yaml has no keywords per se; use generic highlighting
    default:
      return TS_KEYWORDS // fallback — TS keywords are a superset
  }
}

// ── Tokenizer with memoization ─────────────────────────────────────────────

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

const _cache = new Map<string, HighlightToken[]>()
const _MAX_CACHE = 500

/** Clear the highlight cache (for tests). */
export function clearHighlightCache(): void {
  _cache.clear()
}

function _tokenizeImpl(code: string, lang: string): HighlightToken[] {
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
        tokens.push({ text, color: 'magenta' })
      } else if (/^[A-Z]/.test(text) && text.length > 1) {
        tokens.push({ text, color: 'cyan' })
      } else {
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

export function tokenize(code: string, lang: string): HighlightToken[] {
  const key = lang + '\0' + code
  const cached = _cache.get(key)
  if (cached) return cached

  const result = _tokenizeImpl(code, lang)

  if (_cache.size >= _MAX_CACHE) {
    const firstKey = _cache.keys().next().value
    if (firstKey !== undefined) _cache.delete(firstKey)
  }
  _cache.set(key, result)
  return result
}

/** Convenience: tokenize and return as segments suitable for Ink <Text> children. */
export function highlight(code: string, lang: string): HighlightToken[] {
  if (!code) return []
  return tokenize(code, lang)
}
