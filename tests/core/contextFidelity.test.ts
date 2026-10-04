import type OpenAI from 'openai'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import * as compact from '../../src/core/compact.js'
import { snipCompact } from '../../src/core/snipCompact.js'
import type { OpenAIMessage, ToolDefinition } from '../../src/core/types.js'

interface ContextCorpus {
  schemaVersion: number
  cases: Array<{ id: string; kind: string; messages: OpenAIMessage[]; tools: ToolDefinition[]; expectedText: string[] }>
}

const corpus = JSON.parse(readFileSync(new URL('../../scripts/fixtures/context-corpus.json', import.meta.url), 'utf8')) as ContextCorpus
const serialize = (messages: readonly OpenAIMessage[]): string => compact.serializeCompactionInput(messages)

function toolCall(id: string, args: Record<string, unknown>): OpenAIMessage {
  return { role: 'assistant', content: 'Read the requested source.', tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: JSON.stringify(args) } }] }
}

function filler(count: number): OpenAIMessage[] {
  return Array.from({ length: count }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `Follow-up ${index}: retain the agreed constraints.` }))
}

function assertPairs(messages: OpenAIMessage[]): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') expect(pending.size).toBe(0)
    for (const call of message.tool_calls ?? []) pending.add(call.id)
    if (message.role === 'tool') {
      expect(pending.has(message.tool_call_id ?? '')).toBe(true)
      pending.delete(message.tool_call_id ?? '')
    }
  }
  expect(pending.size).toBe(0)
}

describe('compaction context fidelity', () => {
  it('exports the readonly serialization interface while retaining the legacy entry point', () => {
    expect(compact.serializeCompactionInput).toBeTypeOf('function')
    const messages: readonly OpenAIMessage[] = Object.freeze([{ role: 'user', content: 'Keep this constraint.' }])
    expect(compact.serializeMessages([...messages])).toBe(serialize(messages))
  })

  it.each(corpus.cases)('preserves text from the fixed $id corpus', testCase => {
    expect(corpus.schemaVersion).toBe(1)
    const before = JSON.stringify(testCase.messages)
    const result = serialize(testCase.messages)
    for (const expected of testCase.expectedText) expect(result).toContain(expected)
    expect(JSON.stringify(testCase.messages)).toBe(before)
  })

  it('keeps ordered text and bounded attachment identities without leaking image payloads', () => {
    const dataUrl = 'data:image/png;base64,' + 'QkNERUZH'.repeat(4000)
    const messages: OpenAIMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Before image: do not change auth.' },
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: 'After image: migration remains pending.' },
      { type: 'image_url', image_url: { url: 'https://example.invalid/layout.png' } },
    ] }]
    const before = JSON.stringify(messages)
    const result = serialize(messages)
    expect(result).toContain('Before image: do not change auth.')
    expect(result).toContain('After image: migration remains pending.')
    expect(result).toContain('image/png')
    expect(result).toContain(createHash('sha256').update(dataUrl).digest('hex'))
    expect(result).toContain('message=1 part=2')
    expect(result).toContain('https://example.invalid/layout.png')
    expect(result).toContain('access not verified')
    expect(result.indexOf('Before image')).toBeLessThan(result.indexOf('image/png'))
    expect(result.indexOf('image/png')).toBeLessThan(result.indexOf('After image'))
    expect(result).not.toContain('QkNERUZH')
    expect(result).not.toContain('data:image')
    expect(result.length).toBeLessThan(1500)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('bounds a long supplied image reference and labels truncation without inventing a replacement URL', () => {
    const url = 'https://example.invalid/' + 'reference/'.repeat(1000) + 'layout.png'
    const result = serialize([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }])
    expect(result).toContain('https://example.invalid/')
    expect(result).toContain('layout.png')
    expect(result).toContain('truncated')
    expect(result).toContain('access not verified')
    expect(result.length).toBeLessThan(1000)
  })

  it('preserves late path and purpose arguments after large unrelated values with explicit truncation', () => {
    const messages = [toolCall('read-late', {
      old_content: 'old unrelated content '.repeat(1000),
      file_path: 'src/core/compact.ts',
      purpose: 'Preserve multimodal user constraints and pending migration requirements',
      options: { destination_path: 'fixtures/recovery/session.json', reason: 'Keep the recovery evidence' },
      new_content: 'new unrelated content '.repeat(1000),
    })]
    const before = JSON.stringify(messages)
    const result = serialize(messages)
    expect(result).toContain('src/core/compact.ts')
    expect(result).toContain('Preserve multimodal user constraints and pending migration requirements')
    expect(result).toContain('fixtures/recovery/session.json')
    expect(result).toContain('Keep the recovery evidence')
    expect(result).toContain('truncated')
    expect(result.length).toBeLessThan(5000)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('keeps complete ordinary arguments beyond the former 200 character cutoff', () => {
    const args = { description: 'Explain the task '.repeat(25), file_path: 'src/core/compact.ts', purpose: 'Verify user corrections' }
    expect(serialize([toolCall('ordinary', args)])).toContain(JSON.stringify(args))
  })

  it.each([
    ['primitive array', Array.from({ length: 8000 }, (_, index) => `unrelated-${index}`)],
    ['wide primitive object', Object.fromEntries(Array.from({ length: 8000 }, (_, index) => [`unrelated_${index}`, `value-${index}`]))],
  ])('reports a bounded retained-field scan for a %s', (_, unrelated) => {
    const result = serialize([toolCall('bounded-scan', { file_path: 'src/core/compact.ts', unrelated })])
    expect(result).toContain('src/core/compact.ts')
    expect(result).toContain('[retained-field scan truncated]')
    expect(result.length).toBeLessThan(5000)
  })

  it('retains bounded head and tail for malformed arguments', () => {
    const message = toolCall('malformed', {})
    message.tool_calls![0].function.arguments = 'invalid-json-prefix ' + 'payload '.repeat(2000) + ' target=src/core/compact.ts'
    const result = serialize([message])
    expect(result).toContain('invalid-json-prefix')
    expect(result).toContain('target=src/core/compact.ts')
    expect(result).toContain('truncated')
    expect(result.length).toBeLessThan(5000)
  })

  it('keeps tool identities paired and emits an old result only once within its preview budget', () => {
    const result = serialize([
      toolCall('read-one', { file_path: 'src/one.ts' }),
      { role: 'tool', name: 'Read', tool_call_id: 'read-one', content: 'first result ' + 'payload '.repeat(1000) },
      toolCall('read-two', { file_path: 'src/two.ts' }),
      { role: 'tool', name: 'Read', tool_call_id: 'read-two', content: 'second result' },
    ])
    expect(result.match(/read-one/g)).toHaveLength(2)
    expect(result.match(/read-two/g)).toHaveLength(2)
    expect(result.match(/first result/g)).toHaveLength(1)
    expect(result).toContain('truncated')
    expect(result.length).toBeLessThan(1500)
  })

  it('omits inline image payloads embedded in text and tool arguments', () => {
    const dataUrl = 'data:image/jpeg;base64,' + 'QUJDREVG'.repeat(1000)
    const result = serialize([
      { role: 'user', content: `Keep the caption text. ${dataUrl} Acceptance remains required.` },
      toolCall('image-reference', { file_path: 'screenshots/layout.jpg', attachment: dataUrl, purpose: 'Inspect the supplied reference' }),
    ])
    expect(result).toContain('Keep the caption text.')
    expect(result).toContain('Acceptance remains required.')
    expect(result).toContain('screenshots/layout.jpg')
    expect(result).toContain('Inspect the supplied reference')
    expect(result).not.toContain('QUJDREVG')
    expect(result).not.toContain('data:image')
    expect(result.length).toBeLessThan(1500)
  })

  it('omits inline image payloads when a tool uses escaped JSON slashes', () => {
    const message = toolCall('escaped-image', { attachment: 'data:image/jpeg;base64,' + 'QUJDREVG'.repeat(1000), file_path: 'screenshots/layout.jpg' })
    message.tool_calls![0].function.arguments = message.tool_calls![0].function.arguments.replaceAll('/', '\\/')
    const result = serialize([message])
    expect(result).toContain('screenshots')
    expect(result).not.toContain('QUJDREVG')
    expect(result).not.toContain('data:image')
    expect(result.length).toBeLessThan(1500)
  })

  it('passes corrections, acceptance and pending work through two summary requests while retaining recent tool pairs', async () => {
    const imageCase = corpus.cases.find(testCase => testCase.kind === 'image')!
    const required = imageCase.expectedText
    const inputs: string[] = []
    const create = vi.fn((request: { messages: Array<{ content: string }> }) => {
      const input = request.messages[1].content
      inputs.push(input)
      for (const text of required) expect(input).toContain(text)
      expect(input).not.toContain('data:image')
      return Promise.resolve({ choices: [{ finish_reason: 'stop', message: { content: `<summary>${required.join('\n')}</summary>` } }] })
    })
    const client = { chat: { completions: { create } } } as unknown as OpenAI
    const recentPair: OpenAIMessage[] = [toolCall('recent-read', { file_path: 'src/recent.ts' }), { role: 'tool', name: 'Read', tool_call_id: 'recent-read', content: 'Recent source content' }]
    const initial = [...structuredClone(imageCase.messages), ...filler(20), ...recentPair, ...filler(4)]
    const before = JSON.stringify(initial)
    const first = await compact.maybeCompact(client, 'fixture-model', initial)
    expect(first.compacted).toBe(true)
    expect(first.messages).toContainEqual(recentPair[0])
    expect(first.messages).toContainEqual(recentPair[1])
    assertPairs(first.messages)
    const second = await compact.maybeCompact(client, 'fixture-model', [...first.messages, ...filler(12)])
    expect(second.compacted).toBe(true)
    for (const text of required) expect(serialize(second.messages)).toContain(text)
    assertPairs(second.messages)
    expect(inputs).toHaveLength(2)
    expect(JSON.stringify(initial)).toBe(before)
  })

  it('keeps multimodal user corrections and tool envelopes intact across repeated deterministic snips', () => {
    const imageCase = corpus.cases.find(testCase => testCase.kind === 'image')!
    const initial: OpenAIMessage[] = [...structuredClone(imageCase.messages), toolCall('old-read', { file_path: 'src/old.ts' }), { role: 'tool', name: 'Read', tool_call_id: 'old-read', content: 'old source '.repeat(2000) }, ...filler(8)]
    const before = JSON.stringify(initial)
    const first = snipCompact(initial)
    const second = snipCompact(first.messages)
    expect(first.messages[0]).toEqual(initial[0])
    expect(second.messages).toEqual(first.messages)
    for (const text of imageCase.expectedText) expect(serialize(second.messages)).toContain(text)
    assertPairs(first.messages)
    assertPairs(second.messages)
    expect(JSON.stringify(initial)).toBe(before)
  })
})
