const sensitive = /^(?:api[_-]?key|authorization|password|token|secret|env|input|stdout|stderr|content|output|command|text|raw)$/i

export function redactDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]'
  if (typeof value === 'string') return value.slice(0, 2048).replace(/\b(?:sk-[\w-]{8,}|(?:api[_-]?key|password|token|secret)\s*[=:]\s*[^\s,;]+)/gi, '[redacted]')
  if (Array.isArray(value)) return value.slice(0, 64).map(item => redactDiagnostic(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key.slice(0, 128), sensitive.test(key) ? '[redacted]' : redactDiagnostic(item, depth + 1)]))
  if (typeof value === 'bigint') return String(value)
  return value
}
