import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'

type Schema = Record<string, unknown>
type ErrorCode = 'invalid_output_schema' | 'unsupported_output_schema' | 'invalid_structured_output'

const SCHEMA_BYTES = 64 * 1024
const OUTPUT_BYTES = 1024 * 1024
const MAX_DEPTH = 32
const SCHEMA_NODES = 4096
const OUTPUT_NODES = 16384
const VALIDATION_STEPS = 262144
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'description',
  'title',
])

export class OutputSchemaError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OutputSchemaError'
  }
}

function fail(code: ErrorCode, message: string): never {
  throw new OutputSchemaError(code, message)
}

function isObject(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkTextDepth(text: string, code: ErrorCode): void {
  let depth = 0
  let quoted = false
  let escaped = false
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '{' || character === '[') {
      if (++depth > MAX_DEPTH) fail(code, `JSON nesting exceeds ${MAX_DEPTH}`)
    } else if (character === '}' || character === ']') depth--
  }
}

function checkJsonTree(
  value: unknown,
  malformed: ErrorCode,
  oversized: ErrorCode,
  maxNodes: number,
  maxBytes: number,
): void {
  const pending = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  let queued = 1
  let bytes = 0
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (++nodes > maxNodes || entry.depth > MAX_DEPTH)
      fail(oversized, 'JSON tree exceeds the supported node or depth limit')
    const current = entry.value
    if (typeof current === 'string') {
      if (current.length > maxBytes) fail(oversized, 'JSON string exceeds the supported byte limit')
      bytes += Buffer.byteLength(current, 'utf8') + 2
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(malformed, 'JSON numbers must be finite')
      bytes += String(current).length
    } else if (current === null || typeof current === 'boolean') bytes += String(current).length
    else if (typeof current !== 'object')
      fail(malformed, 'Schema and output values must contain only JSON data')
    else {
      if (seen.has(current))
        fail(oversized, 'Recursive or shared JSON object graphs are unsupported')
      seen.add(current)
      const prototype: unknown = Object.getPrototypeOf(current)
      if (
        Array.isArray(current)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        fail(malformed, 'JSON objects must be plain objects or arrays')
      bytes += 2
      const keys = Reflect.ownKeys(current)
      if (keys.length > maxNodes) fail(oversized, 'JSON object exceeds the supported node limit')
      for (const key of keys) {
        if (Array.isArray(current) && key === 'length') continue
        if (typeof key !== 'string') fail(malformed, 'JSON symbol properties are unsupported')
        if (
          Array.isArray(current) &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)
        )
          fail(malformed, 'JSON arrays must contain only indexed entries')
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          fail(malformed, 'JSON accessors or hidden properties are unsupported')
        if (++queued > maxNodes) fail(oversized, 'JSON tree exceeds the supported node limit')
        if (key.length > maxBytes) fail(oversized, 'JSON key exceeds the supported byte limit')
        if (!Array.isArray(current)) bytes += Buffer.byteLength(key, 'utf8') + 3
        pending.push({ value: descriptor.value as unknown, depth: entry.depth + 1 })
      }
      if (Array.isArray(current) && keys.length !== current.length + 1)
        fail(malformed, 'JSON arrays must not be sparse or contain named properties')
    }
    if (bytes > maxBytes) fail(oversized, 'JSON data exceeds the supported byte limit')
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map((entry: unknown) => canonical(entry)).join(',') + ']'
  if (isObject(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}

function requireType(schema: Schema, keyword: string, allowed: string[]): void {
  if (!allowed.includes(schema.type as string))
    fail('invalid_output_schema', `${keyword} requires type ${allowed.join(' or ')}`)
}

function validateSchemaNode(schema: Schema): void {
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword))
      fail(
        'unsupported_output_schema',
        `Unsupported output schema keyword: ${keyword.slice(0, 80)}`,
      )
  }
  if (Object.hasOwn(schema, 'type') && (typeof schema.type !== 'string' || !TYPES.has(schema.type)))
    fail('unsupported_output_schema', 'Output schema type must be one supported explicit type')
  for (const keyword of ['description', 'title']) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== 'string')
      fail('invalid_output_schema', `${keyword} must be a string`)
  }
  if (Object.hasOwn(schema, 'properties')) {
    requireType(schema, 'properties', ['object'])
    if (!isObject(schema.properties)) fail('invalid_output_schema', 'properties must be an object')
    for (const child of Object.values(schema.properties)) validateChildSchema(child)
  }
  if (Object.hasOwn(schema, 'required')) {
    requireType(schema, 'required', ['object'])
    const required = schema.required
    if (
      !Array.isArray(required) ||
      required.some((key: unknown) => typeof key !== 'string') ||
      new Set(required as unknown[]).size !== required.length
    )
      fail('invalid_output_schema', 'required must contain unique string property names')
  }
  if (Object.hasOwn(schema, 'additionalProperties')) {
    requireType(schema, 'additionalProperties', ['object'])
    if (typeof schema.additionalProperties !== 'boolean')
      validateChildSchema(schema.additionalProperties)
  }
  if (Object.hasOwn(schema, 'items')) {
    requireType(schema, 'items', ['array'])
    if (Array.isArray(schema.items))
      fail('unsupported_output_schema', 'Tuple items schemas are unsupported')
    validateChildSchema(schema.items)
  }
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0)
      fail('invalid_output_schema', 'enum must be a nonempty JSON array')
    const choices = schema.enum.map((choice: unknown) => canonical(choice))
    if (new Set(choices).size !== choices.length)
      fail('invalid_output_schema', 'enum values must be unique')
  }
  for (const [minimum, maximum, allowed, integral] of [
    ['minimum', 'maximum', ['number', 'integer'], false],
    ['minLength', 'maxLength', ['string'], true],
    ['minItems', 'maxItems', ['array'], true],
  ] as const) {
    for (const keyword of [minimum, maximum]) {
      if (!Object.hasOwn(schema, keyword)) continue
      requireType(schema, keyword, [...allowed])
      const bound = schema[keyword]
      if (
        typeof bound !== 'number' ||
        !Number.isFinite(bound) ||
        (integral && (!Number.isSafeInteger(bound) || bound < 0))
      )
        fail(
          'invalid_output_schema',
          `${keyword} must be a valid ${integral ? 'nonnegative integer' : 'finite number'}`,
        )
    }
    if (
      typeof schema[minimum] === 'number' &&
      typeof schema[maximum] === 'number' &&
      schema[minimum] > schema[maximum]
    )
      fail('invalid_output_schema', `${minimum} must not exceed ${maximum}`)
  }
}

function validateChildSchema(value: unknown): void {
  if (!isObject(value))
    fail(
      typeof value === 'boolean' ? 'unsupported_output_schema' : 'invalid_output_schema',
      'Each schema must be an object',
    )
  validateSchemaNode(value)
}

export function validateOutputSchema(schema: Schema): void {
  if (!isObject(schema)) fail('invalid_output_schema', 'Output schema must be a JSON object')
  checkJsonTree(
    schema,
    'invalid_output_schema',
    'unsupported_output_schema',
    SCHEMA_NODES,
    SCHEMA_BYTES,
  )
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > SCHEMA_BYTES)
    fail('unsupported_output_schema', 'Output schema exceeds 64 KiB')
  validateSchemaNode(schema)
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) freezeTree(child)
  Object.freeze(value)
}

export function readOutputSchema(path: string): Schema {
  let descriptor: number | undefined
  let parsed: unknown
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > SCHEMA_BYTES)
      fail('invalid_output_schema', 'Output schema must be a regular file no larger than 64 KiB')
    const buffer = Buffer.alloc(SCHEMA_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > SCHEMA_BYTES) fail('invalid_output_schema', 'Output schema file exceeds 64 KiB')
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0)) fail('invalid_output_schema', 'Output schema must not contain NUL bytes')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    checkTextDepth(text, 'unsupported_output_schema')
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof OutputSchemaError) throw error
    fail('invalid_output_schema', 'Cannot read output schema as a regular UTF-8 JSON file')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  if (!isObject(parsed)) fail('invalid_output_schema', 'Output schema must be a JSON object')
  validateOutputSchema(parsed)
  freezeTree(parsed)
  return parsed
}

function step(budget: { remaining: number }): void {
  if (--budget.remaining < 0)
    fail('invalid_structured_output', 'Structured output exceeds the validation work limit')
}

function equalJson(left: unknown, right: unknown, budget: { remaining: number }): boolean {
  step(budget)
  if (left === right) return true
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value: unknown, index) => equalJson(value, right[index] as unknown, budget))
    )
  if (!isObject(left) || !isObject(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key], budget))
  )
}

function validateValue(value: unknown, schema: Schema, budget: { remaining: number }): void {
  step(budget)
  const type = schema.type as string | undefined
  const matches =
    type === undefined ||
    (type === 'null'
      ? value === null
      : type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? isObject(value)
          : type === 'integer'
            ? typeof value === 'number' && Number.isInteger(value)
            : typeof value === type)
  if (!matches)
    fail('invalid_structured_output', `Structured output does not match type ${String(type)}`)
  if (Object.hasOwn(schema, 'const') && !equalJson(value, schema.const, budget))
    fail('invalid_structured_output', 'Structured output does not match const')
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((choice: unknown) => equalJson(value, choice, budget))
  )
    fail('invalid_structured_output', 'Structured output is not an enum value')
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      fail('invalid_structured_output', 'Structured output is below minimum')
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      fail('invalid_structured_output', 'Structured output is above maximum')
  }
  if (typeof value === 'string') {
    let length = 0
    for (let index = 0; index < value.length; index++, length++) {
      if ((value.codePointAt(index) ?? 0) > 0xffff) index++
    }
    if (typeof schema.minLength === 'number' && length < schema.minLength)
      fail('invalid_structured_output', 'Structured output is shorter than minLength')
    if (typeof schema.maxLength === 'number' && length > schema.maxLength)
      fail('invalid_structured_output', 'Structured output is longer than maxLength')
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      fail('invalid_structured_output', 'Structured output has fewer than minItems')
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      fail('invalid_structured_output', 'Structured output has more than maxItems')
    if (isObject(schema.items))
      for (const child of value) validateValue(child, schema.items, budget)
  }
  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[])
        if (!Object.hasOwn(value, key))
          fail('invalid_structured_output', 'Structured output is missing a required property')
    }
    const properties = isObject(schema.properties) ? schema.properties : {}
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateValue(child, properties[key] as Schema, budget)
      else if (schema.additionalProperties === false)
        fail('invalid_structured_output', 'Structured output contains an additional property')
      else if (isObject(schema.additionalProperties))
        validateValue(child, schema.additionalProperties, budget)
    }
  }
}

export function validateStructuredOutput(text: string, schema: Schema): unknown {
  validateOutputSchema(schema)
  if (
    typeof text !== 'string' ||
    text.length > OUTPUT_BYTES ||
    Buffer.byteLength(text, 'utf8') > OUTPUT_BYTES
  )
    fail('invalid_structured_output', 'Structured output exceeds 1 MiB')
  checkTextDepth(text, 'invalid_structured_output')
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    fail('invalid_structured_output', 'Structured output must be valid JSON')
  }
  checkJsonTree(
    value,
    'invalid_structured_output',
    'invalid_structured_output',
    OUTPUT_NODES,
    OUTPUT_BYTES,
  )
  validateValue(value, schema, { remaining: VALIDATION_STEPS })
  return value
}
