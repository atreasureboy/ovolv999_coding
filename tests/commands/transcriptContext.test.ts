import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dispatchSlashCommand, type SlashCommandContext } from '../../src/commands/index.js'
import '../../src/commands/builtin.js'

describe('transcript commands use the active conversation', () => {
  let directory: string
  let context: SlashCommandContext

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-transcript-context-'))
    mkdirSync(join(directory, 'session_current'))
    context = {
      cwd: directory,
      sessionDir: join(directory, 'session_current'),
      history: [
        { role: 'user', content: [{ type: 'text', text: 'Question' }] },
        { role: 'assistant', content: 'Answer', tool_calls: [{ id: 'call', type: 'function', function: { name: 'Read', arguments: '{"file_path":"hello.txt"}' } }] },
        { role: 'tool', content: 'Contents', tool_call_id: 'call' },
      ],
    } as SlashCommandContext
    vi.stubEnv('HOME', directory)
    vi.stubEnv('USERPROFILE', directory)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('exports current text, roles and tool calls to the reported JSON file', async () => {
    const result = await dispatchSlashCommand('/transcript json', context)
    expect(result?.type).toBe('text')
    if (result?.type !== 'text') throw new Error('Missing transcript result')
    const path = result.value.split('\n')[0].replace('Transcript exported to: ', '')
    expect(existsSync(path)).toBe(true)
    const transcript = JSON.parse(readFileSync(path, 'utf8'))
    expect(transcript.messages).toHaveLength(3)
    expect(transcript.messages[0]).toMatchObject({ role: 'user', content: 'Question' })
    expect(transcript.messages[1].toolCalls).toEqual([{ name: 'Read', input: { file_path: 'hello.txt' } }])
    expect(transcript.messages[2]).toMatchObject({ role: 'tool', content: 'Contents' })
    if (!path.startsWith(directory + '\\') && !path.startsWith(directory + '/')) rmSync(path)
  })

  it('computes transcript statistics from the current history', async () => {
    expect(await dispatchSlashCommand('/transcript stats', context)).toMatchObject({
      type: 'text',
      value: expect.stringContaining('Messages: 3 (1 user, 1 assistant)'),
    })
  })

  it('reports the file it writes and masks secrets in tool arguments and multimodal text', async () => {
    const secret = 'sk-' + 'A1b2C3d4'.repeat(6)
    context.history[0].content = [{ type: 'text', text: secret }]
    context.history[1].tool_calls![0].function.arguments = JSON.stringify({ token: secret })
    const result = await dispatchSlashCommand('/share json', context)
    if (result?.type !== 'text') throw new Error('Missing share result')
    const path = result.value.split('\n')[0].replace('✓ Shared (secrets masked): ', '')
    expect(existsSync(path)).toBe(true)
    const shared = readFileSync(path, 'utf8')
    expect(shared).not.toContain(secret)
    expect(JSON.parse(shared)[1].tool_calls[0].function.arguments).toContain('...')
    expect(context.history[1].tool_calls![0].function.arguments).toContain(secret)
  })
})
