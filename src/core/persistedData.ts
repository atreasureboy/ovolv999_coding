import { readFileSync } from 'node:fs'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function readPersistedRows<T>(
  path: string,
  key: string,
  validate: (value: unknown) => value is T,
): T[] {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(data) || !Array.isArray(data[key])) return []
    return data[key].filter(validate)
  } catch {
    return []
  }
}
