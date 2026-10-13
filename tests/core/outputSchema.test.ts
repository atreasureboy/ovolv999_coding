import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readOutputSchema,
  validateOutputSchema,
  validateStructuredOutput,
} from '../../src/core/outputSchema.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ovolv999-schema-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function file(content: string | Buffer): string {
  const path = join(directory, 'schema.json')
  writeFileSync(path, content)
  return path
}

describe('output schema preflight', () => {
  it('reads real UTF-8 JSON and freezes the returned schema tree', () => {
    const schema = readOutputSchema(
      file(
        '{"type":"object","properties":{"名字":{"type":"string"}},"required":["名字"],"additionalProperties":false}',
      ),
    )
    expect(validateStructuredOutput('{"名字":"你好🌏"}', schema)).toEqual({ 名字: '你好🌏' })
    expect(Object.isFrozen(schema)).toBe(true)
    expect(Object.isFrozen(schema.properties)).toBe(true)
    expect(() => {
      schema.type = 'array'
    }).toThrow()
  })

  it.each([
    ['malformed JSON', '{'],
    ['NUL bytes', '{"title":"\0"}'],
    ['non-UTF-8', Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d])],
    ['oversized input', ' '.repeat(65537)],
    ['non-object JSON', '[]'],
  ])('rejects %s from a real file', (_name, content) => {
    expect(() => readOutputSchema(file(content))).toThrow(
      expect.objectContaining({ code: 'invalid_output_schema' }),
    )
  })

  it('accepts the exact byte ceiling and rejects nonregular or absent files', () => {
    const text = '{"type":"string"}'
    expect(readOutputSchema(file(text + ' '.repeat(65536 - Buffer.byteLength(text))))).toEqual({
      type: 'string',
    })
    const folder = join(directory, 'folder')
    mkdirSync(folder)
    expect(() => readOutputSchema(folder)).toThrow(
      expect.objectContaining({ code: 'invalid_output_schema' }),
    )
    expect(() => readOutputSchema(join(directory, 'absent.json'))).toThrow(
      expect.objectContaining({ code: 'invalid_output_schema' }),
    )
  })

  it.each([
    { $ref: 'https://example.invalid/schema.json' },
    { $ref: '#' },
    { $schema: 'https://json-schema.org/draft/2020-12/schema' },
    { type: ['string', 'null'] },
    { type: 'object', properties: { a: { type: 'string', pattern: 'a' } } },
    { anyOf: [{ type: 'string' }] },
    { type: 'array', items: [{ type: 'string' }] },
    { type: 'strnig' },
  ])('rejects unsupported schema features %j', (schema) => {
    expect(() => validateOutputSchema(schema)).toThrow(
      expect.objectContaining({ code: 'unsupported_output_schema' }),
    )
  })

  it.each([
    { type: 'object', required: ['a', 'a'] },
    { type: 'object', required: [1] },
    { type: 'object', properties: [] },
    { type: 'object', additionalProperties: 1 },
    { type: 'array', items: null },
    { type: 'string', minLength: -1 },
    { type: 'string', maxLength: 1.5 },
    { type: 'array', minItems: 2, maxItems: 1 },
    { type: 'number', minimum: 3, maximum: 2 },
    { type: 'number', minimum: Infinity },
    { type: 'string', minimum: 1 },
    { description: 1 },
    { enum: [] },
    {
      enum: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    },
    { const: undefined },
  ])('rejects malformed subset constraints %j', (schema) => {
    expect(() => validateOutputSchema(schema)).toThrow(
      expect.objectContaining({ code: 'invalid_output_schema' }),
    )
  })

  it('rejects cycles, excessive schema depth, excessive nodes and accessor properties', () => {
    const recursive: Record<string, unknown> = { type: 'array' }
    recursive.items = recursive
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 33; i++) deep = { type: 'array', items: deep }
    expect(() => validateOutputSchema(recursive)).toThrow(
      expect.objectContaining({ code: 'unsupported_output_schema' }),
    )
    expect(() => validateOutputSchema(deep)).toThrow(
      expect.objectContaining({ code: 'unsupported_output_schema' }),
    )
    expect(() =>
      validateOutputSchema({ enum: Array.from({ length: 4097 }, (_, index) => index) }),
    ).toThrow(expect.objectContaining({ code: 'unsupported_output_schema' }))
    const getter = Object.defineProperty({}, 'type', {
      get: () => 'string',
      enumerable: true,
    }) as Record<string, unknown>
    expect(() => validateOutputSchema(getter)).toThrow(
      expect.objectContaining({ code: 'invalid_output_schema' }),
    )
  })

  it('accepts many small enum values below the documented schema limits', () => {
    const schema = { enum: Array.from({ length: 4000 }, (_, index) => index) }
    expect(() => validateOutputSchema(schema)).not.toThrow()
    expect(validateStructuredOutput('3999', schema)).toBe(3999)
  })

  it('rejects sparse arrays whose named property conceals a missing index', () => {
    const choices: unknown[] = [1]
    choices.length = 2
    Object.defineProperty(choices, 'hiddenIndex', { value: 2, enumerable: true })
    expect(() => validateOutputSchema({ enum: choices })).toThrow(
      expect.objectContaining({ code: 'invalid_output_schema' }),
    )
  })
})

describe('structured output local validation', () => {
  const schema = {
    type: 'object',
    properties: {
      answer: { type: 'string', minLength: 1, maxLength: 3 },
      count: { type: 'integer', minimum: 0, maximum: 4 },
      list: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'boolean' } },
    },
    required: ['answer', 'count', 'list'],
    additionalProperties: false,
  }

  it('validates nested types, ranges and codepoint string length', () => {
    expect(
      validateStructuredOutput('{"answer":"🌏🌎🌍","count":4,"list":[true,false]}', schema),
    ).toEqual({ answer: '🌏🌎🌍', count: 4, list: [true, false] })
  })

  it.each([
    'not JSON',
    '```json\n{}\n```',
    '{"answer":"a","count":1}',
    '{"answer":"","count":1,"list":[true]}',
    '{"answer":"abcd","count":1,"list":[true]}',
    '{"answer":"a","count":1.5,"list":[true]}',
    '{"answer":"a","count":-1,"list":[true]}',
    '{"answer":"a","count":5,"list":[true]}',
    '{"answer":"a","count":1,"list":[]}',
    '{"answer":"a","count":1,"list":[true,false,true]}',
    '{"answer":"a","count":1,"list":["true"]}',
    '{"answer":"a","count":1,"list":[true],"extra":1}',
    '[]',
  ])('rejects invalid model output %s', (text) => {
    expect(() => validateStructuredOutput(text, schema)).toThrow(
      expect.objectContaining({ code: 'invalid_structured_output' }),
    )
  })

  it('applies additional-property schemas and does not treat inherited property names as declared', () => {
    const extras = {
      type: 'object',
      properties: { fixed: { const: null } },
      additionalProperties: { type: 'number' },
    }
    expect(validateStructuredOutput('{"fixed":null,"extra":2}', extras)).toEqual({
      fixed: null,
      extra: 2,
    })
    expect(() => validateStructuredOutput('{"toString":"bad"}', extras)).toThrow()
    expect(() =>
      validateStructuredOutput('{"__proto__":1}', { type: 'object', additionalProperties: false }),
    ).toThrow()
    expect(() =>
      validateStructuredOutput('{}', { type: 'object', required: ['toString'] }),
    ).toThrow()
  })

  it('uses deep JSON equality for enum and const independent of object key order', () => {
    const choices = { enum: [{ a: [1, null, true], b: 'ok' }, 2] }
    expect(validateStructuredOutput('{"b":"ok","a":[1,null,true]}', choices)).toEqual({
      b: 'ok',
      a: [1, null, true],
    })
    expect(() => validateStructuredOutput('{"b":"ok","a":[1,null,false]}', choices)).toThrow()
    expect(validateStructuredOutput('{"b":2,"a":1}', { const: { a: 1, b: 2 } })).toEqual({
      b: 2,
      a: 1,
    })
    expect(() => validateStructuredOutput('{"a":1}', { const: { a: 1, b: 2 } })).toThrow()
  })

  it.each([
    ['null', 'null'],
    ['boolean', 'false'],
    ['number', '1.5'],
    ['integer', '-2'],
    ['array', '[]'],
    ['object', '{}'],
    ['string', '"value"'],
  ])('supports the explicit %s type', (type, text) => {
    expect(() => validateStructuredOutput(text, { type })).not.toThrow()
  })

  it('preflights again and rejects nonfinite or excessive output before nested validation', () => {
    expect(() => validateStructuredOutput('1e999', { type: 'number' })).toThrow(
      expect.objectContaining({ code: 'invalid_structured_output' }),
    )
    expect(() => validateStructuredOutput('"' + 'a'.repeat(1048576) + '"', {})).toThrow(
      expect.objectContaining({ code: 'invalid_structured_output' }),
    )
    expect(() => validateStructuredOutput('['.repeat(33) + '0' + ']'.repeat(33), {})).toThrow(
      expect.objectContaining({ code: 'invalid_structured_output' }),
    )
    expect(() => validateStructuredOutput('[' + '0,'.repeat(16384) + '0]', {})).toThrow(
      expect.objectContaining({ code: 'invalid_structured_output' }),
    )
    expect(() => validateStructuredOutput('{}', { pattern: '.' })).toThrow(
      expect.objectContaining({ code: 'unsupported_output_schema' }),
    )
  })

  it('bounds repeated enum comparisons across an otherwise bounded output tree', () => {
    const choices = Array.from({ length: 150 }, (_, index) => [...Array<number>(20).fill(0), index])
    const repeated = JSON.stringify(
      Array.from({ length: 100 }, () => [...Array<number>(20).fill(0), 149]),
    )
    expect(() =>
      validateStructuredOutput(repeated, { type: 'array', items: { enum: choices } }),
    ).toThrow(/validation work limit/)
    const earlyMatch = JSON.stringify(Array.from({ length: 100 }, () => Array<number>(21).fill(0)))
    expect(() =>
      validateStructuredOutput(earlyMatch, { type: 'array', items: { enum: choices } }),
    ).not.toThrow()
  })
})
