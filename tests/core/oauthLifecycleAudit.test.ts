import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, get, type Server } from 'node:http'
import { randomInt } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exchangeCodeForToken, isTokenExpired, loadToken, OAuthCallbackServer, saveToken, type OAuthConfig } from '../../src/core/oauth.js'

const config: OAuthConfig = { clientId: 'fixture', authorizationEndpoint: 'http://localhost/auth', tokenEndpoint: '',
  redirectUri: 'http://localhost/callback', scopes: [], serverName: 'fixture' }
let cwd: string
const servers: Server[] = []
const callbacks: OAuthCallbackServer[] = []

async function listenHttp(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(randomInt(49152, 65536), '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture port')
      return address.port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('Could not obtain a high HTTP fixture port')
}

async function endpoint(response: unknown) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)) })
  servers.push(server)
  return `http://127.0.0.1:${await listenHttp(server)}/token`
}

async function callback() {
  const server = new OAuthCallbackServer(0)
  callbacks.push(server)
  await server.start()
  const address = (server as unknown as { server: Server }).server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return { server, url: `http://127.0.0.1:${address.port}/callback` }
}

function request(url: string): Promise<string> {
  return new Promise((resolve, reject) => get(url, res => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { text += chunk })
    res.on('end', () => resolve(text))
  }).on('error', reject))
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'oauth-lifecycle-'))
  vi.stubEnv('HOME', cwd)
  vi.stubEnv('USERPROFILE', cwd)
})
afterEach(async () => {
  vi.useRealTimers()
  callbacks.splice(0).forEach(server => server.stop())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe('OAuth lifecycle and stored data', () => {
  it('rejects token names escaping the storage directory', () => {
    expect(() => saveToken('../escaped', { accessToken: 'secret', tokenType: 'Bearer' })).toThrow()
  })

  it('rejects malformed saved tokens', () => {
    const dir = join(cwd, '.ovolv999', 'oauth-tokens')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ accessToken: 1 }))
    expect(loadToken('fixture')).toBeNull()
  })

  it('treats an epoch expiration as expired', () => {
    expect(isTokenExpired({ accessToken: 'value', tokenType: 'Bearer', expiresAt: 0 })).toBe(true)
  })

  it('rejects a successful HTTP response without an access token', async () => {
    await expect(exchangeCodeForToken({ ...config, tokenEndpoint: await endpoint({ token_type: 'Bearer' }) }, 'code')).rejects.toThrow()
  })

  it('preserves zero-second token expiration', async () => {
    const token = await exchangeCodeForToken({ ...config, tokenEndpoint: await endpoint({ access_token: 'valid', expires_in: 0 }) }, 'code')
    expect(isTokenExpired(token)).toBe(true)
  })

  it('times out while waiting for an unfinished token response body', async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(30))
    const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{') })
    servers.push(server)
    const port = await listenHttp(server)
    await expect(exchangeCodeForToken({ ...config, tokenEndpoint: `http://127.0.0.1:${port}` }, 'code')).rejects.toThrow(/timeout/i)
  })

  it('rejects an expiration that overflows when converted to milliseconds', async () => {
    await expect(exchangeCodeForToken({ ...config, tokenEndpoint: await endpoint({ access_token: 'value', expires_in: Number.MAX_VALUE }) }, 'code')).rejects.toThrow()
  })

  it('settles a pending callback when its server stops', async () => {
    const { server } = await callback()
    const pending = server.waitForCode(1000).then(() => 'unexpected', () => 'stopped')
    server.stop()
    expect(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('pending'), 20))])).toBe('stopped')
  })

  it('cleans up its deadline after the callback succeeds', async () => {
    const { server, url } = await callback()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = server.waitForCode(1000)
    await request(`${url}?code=accepted&state=expected`)
    await expect(pending).resolves.toEqual({ code: 'accepted', state: 'expected' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders callback errors as text without executing supplied HTML', async () => {
    const { server, url } = await callback()
    const pending = server.waitForCode(1000).catch(() => undefined)
    const body = await request(`${url}?error=${encodeURIComponent('<script>alert(1)</script>')}`)
    expect(body).not.toContain('<script>')
    await pending
  })
})
