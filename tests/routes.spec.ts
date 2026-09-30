import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createHandlers, isTrustedRequest } from '../src/routes.ts'
import { SubscriptionService } from '../src/service.ts'
import { jsonResponse, rawDetail } from './fixtures.ts'

const KEY = 'mk-route-secret'

interface FakeRequest {
  method?: string
  url?: string
  remote?: string
  headers?: Record<string, string | string[]>
  encrypted?: boolean
}

function request(options: FakeRequest = {}): IncomingMessage {
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/plugins/dsh-zenmux-quota/subscription',
    headers: { host: '127.0.0.1:19387', ...options.headers },
    socket: { remoteAddress: options.remote ?? '127.0.0.1', encrypted: options.encrypted },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse; result: () => { status: number; headers: Record<string, unknown>; body: string } } {
  let status = 0
  let headers: Record<string, unknown> = {}
  let body = ''
  const res = {
    writeHead: (code: number, given: Record<string, unknown>) => { status = code; headers = given },
    end: (text: string) => { body = text },
  } as unknown as ServerResponse
  return { res, result: () => ({ status, headers, body }) }
}

function handlers(fetchMock = vi.fn(async () => jsonResponse(rawDetail()))) {
  const service = new SubscriptionService({ keySource: () => KEY, fetch: fetchMock as unknown as typeof fetch })
  return {
    fetchMock,
    ...createHandlers({
      service,
      settings: () => ({ providers: ['zenmux-anthropic'], providerPattern: '^zenmux', display: 'binding' }),
    }),
  }
}

describe('isTrustedRequest', () => {
  it('accepts loopback peer + loopback host, with or without a matching Origin', () => {
    expect(isTrustedRequest(request())).toBe(true)
    expect(isTrustedRequest(request({ headers: { origin: 'http://127.0.0.1:19387' } }))).toBe(true)
    expect(isTrustedRequest(request({ headers: { host: 'localhost:3080' }, remote: '::1' }))).toBe(true)
  })

  it('rejects cross-site fetches', () => {
    expect(isTrustedRequest(request({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false)
    expect(isTrustedRequest(request({ headers: { 'sec-fetch-site': ['same-origin', 'Cross-Site'] } }))).toBe(false)
    expect(isTrustedRequest(request({ headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(true)
  })

  it('rejects a mismatched or malformed Origin', () => {
    expect(isTrustedRequest(request({ headers: { origin: 'http://evil.example' } }))).toBe(false)
    expect(isTrustedRequest(request({ headers: { origin: 'http://127.0.0.1:1' } }))).toBe(false)
    expect(isTrustedRequest(request({ headers: { origin: 'null' } }))).toBe(false)
  })

  it('rejects non-loopback peers and hosts', () => {
    expect(isTrustedRequest(request({ remote: '192.168.1.5' }))).toBe(false)
    expect(isTrustedRequest(request({ headers: { host: 'dsh.example.com' } }))).toBe(false)
    expect(isTrustedRequest(request({ headers: { host: 'evil@127.0.0.1' } }))).toBe(false)
  })
})

describe('route handlers', () => {
  it('answers 405 to non-GET and 403 to untrusted requests, never reaching upstream', async () => {
    const { subscription, config, fetchMock } = handlers()
    const post = response()
    await subscription(request({ method: 'POST' }), post.res)
    expect(post.result().status).toBe(405)
    const remote = response()
    await subscription(request({ remote: '10.0.0.2' }), remote.res)
    expect(remote.result().status).toBe(403)
    const cross = response()
    await config(request({ headers: { 'sec-fetch-site': 'cross-site' } }), cross.res)
    expect(cross.result().status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the config without touching upstream', async () => {
    const { config, fetchMock } = handlers()
    const out = response()
    await config(request(), out.res)
    const { status, body } = out.result()
    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ configured: true, providers: ['zenmux-anthropic'], providerPattern: '^zenmux', display: 'binding' })
    expect(body).not.toContain(KEY)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves subscription data with no-store, nosniff and never the key', async () => {
    const { subscription } = handlers()
    const out = response()
    await subscription(request(), out.res)
    const { status, headers, body } = out.result()
    expect(status).toBe(200)
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(String(headers['content-type'])).toContain('application/json')
    expect(body).not.toContain(KEY)
    const parsed = JSON.parse(body) as { state: string; data: { fiveHour: { remainingFlows: number } } }
    expect(parsed.state).toBe('ready')
    expect(parsed.data.fiveHour.remainingFlows).toBe(742.8)
    expect(body).not.toContain('quota_5_hour')
  })

  it('passes ?refresh=1 through as a forced refresh', async () => {
    const { subscription, fetchMock } = handlers()
    await subscription(request(), response().res)
    await subscription(request({ url: '/plugins/dsh-zenmux-quota/subscription?refresh=1' }), response().res)
    // Inside the 10 second floor the forced refresh is served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
