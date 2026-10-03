import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../src/core/types.js'
import { WebFetchTool } from '../../src/tools/webFetch.js'
import { WebBrowserTool, parseHtml } from '../../src/tools/webBrowser.js'
import { WebSearchTool } from '../../src/tools/webSearch.js'

const context = (signal?: AbortSignal): ToolContext => ({ cwd: process.cwd(), permissionMode: 'auto', signal })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('network response boundaries', () => {
  it.each([new WebFetchTool(), new WebBrowserTool()])('$name applies its deadline after response headers arrive', async tool => {
    vi.useFakeTimers()
    const outer = new AbortController()
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
      },
    }), { headers: { 'content-type': 'text/plain' } })))
    let result: Awaited<ReturnType<typeof tool.execute>> | undefined
    const pending = tool.execute({ url: 'https://example.test' }, context(outer.signal)).then(value => { result = value })
    try {
      await vi.advanceTimersByTimeAsync(30_001)
      expect(result?.isError).toBe(true)
      expect(result?.content).toMatch(/timed out/i)
    } finally {
      outer.abort()
      await pending.catch(() => undefined)
    }
  })

  it('WebFetch rejects invalid pagination before fetching', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('hello')))
    vi.stubGlobal('fetch', fetch)
    expect((await new WebFetchTool().execute({ url: 'https://example.test', start_index: -1 }, context())).isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('WebBrowser reports a body read failure as a tool result', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken stream')) } }))))
    await expect(new WebBrowserTool().execute({ url: 'https://example.test' }, context())).resolves.toMatchObject({ isError: true })
  })

  it('WebBrowser identifies HTTP failures', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<p>unavailable</p>', { status: 503 })))
    expect((await new WebBrowserTool().execute({ url: 'https://example.test' }, context())).isError).toBe(true)
  })

  it('WebBrowser decodes invalid numeric entities without throwing', () => {
    expect(parseHtml('https://example.test', 'https://example.test', 200, '<p>&#99999999999; &#x110000;</p>', 'text/html').textBlocks[0]).toBe('� �')
  })

  it('WebSearch distinguishes an unavailable endpoint from zero search results', async () => {
    vi.stubEnv('OVOGO_SEARCH_API_KEY', '')
    vi.stubEnv('SERPAPI_KEY', '')
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 503 })))
    const result = await new WebSearchTool().execute({ query: 'test' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/503/)
  })

  it('WebSearch respects a one-result limit with an abstract and related topics', async () => {
    vi.stubEnv('OVOGO_SEARCH_API_KEY', '')
    vi.stubEnv('SERPAPI_KEY', '')
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ AbstractText: 'Main result', AbstractURL: 'https://example.test/main', RelatedTopics: [{ Text: 'Related', FirstURL: 'https://example.test/related' }] })))
    const result = await new WebSearchTool().execute({ query: 'test', num_results: 1 }, context())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Main result')
    expect(result.content).not.toContain('https://example.test/related')
  })
})
