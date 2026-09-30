import { describe, expect, it, vi } from 'vitest'
import { fingerprintOf, readManagementKey } from '../src/key-source.ts'
import { DEFAULT_BASE_URL, MAX_BODY_CHARS, fetchSubscription, resolveBaseURL } from '../src/upstream.ts'
import { jsonResponse, rawDetail } from './fixtures.ts'

const KEY = 'mk-test-secret-123'

describe('fetchSubscription', () => {
  it('sends a Bearer GET with no cookies and no redirects', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(rawDetail(), { headers: { 'x-zenmux-requestid': 'req-1' } }))
    const outcome = await fetchSubscription(KEY, { fetch: fetchMock as unknown as typeof fetch })
    expect(outcome.kind).toBe('ok')
    expect(outcome.requestId).toBe('req-1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://zenmux.ai/api/v1/management/subscription/detail')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`)
  })

  it.each([[401], [403]])('classifies %i as unauthorized', async status => {
    const outcome = await fetchSubscription(KEY, { fetch: async () => new Response('{}', { status }) })
    expect(outcome.kind).toBe('unauthorized')
  })

  it('classifies 422 and 429 as rate-limited and reads Retry-After seconds', async () => {
    const limited = await fetchSubscription(KEY, { fetch: async () => new Response('{}', { status: 422, headers: { 'retry-after': '90' } }) })
    expect(limited).toMatchObject({ kind: 'rate-limited', retryAfterMs: 90_000 })
    const plain = await fetchSubscription(KEY, { fetch: async () => new Response('{}', { status: 429 }) })
    expect(plain.kind).toBe('rate-limited')
    expect((plain as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
  })

  it('classifies 5xx, 404 and network failures as upstream-error', async () => {
    expect((await fetchSubscription(KEY, { fetch: async () => new Response('x', { status: 500 }) })).kind).toBe('upstream-error')
    expect((await fetchSubscription(KEY, { fetch: async () => new Response('x', { status: 404 }) })).kind).toBe('upstream-error')
    expect((await fetchSubscription(KEY, { fetch: async () => { throw new TypeError('boom') } })).kind).toBe('upstream-error')
  })

  it('treats a redirect refusal as upstream-error rather than following it', async () => {
    const outcome = await fetchSubscription(KEY, { fetch: async () => { throw new TypeError('redirect mode is set to error') } })
    expect(outcome.kind).toBe('upstream-error')
  })

  it('times out', async () => {
    const hanging = (_url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const outcome = await fetchSubscription(KEY, { fetch: hanging as unknown as typeof fetch, timeoutMs: 20 })
    expect(outcome.kind).toBe('upstream-error')
  })

  it('honours an external abort signal', async () => {
    const controller = new AbortController()
    const hanging = (_url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const pending = fetchSubscription(KEY, { fetch: hanging as unknown as typeof fetch, signal: controller.signal })
    controller.abort()
    expect((await pending).kind).toBe('upstream-error')
  })

  it('rejects oversized, non-JSON and malformed bodies as invalid-data', async () => {
    expect((await fetchSubscription(KEY, { fetch: async () => new Response('x'.repeat(MAX_BODY_CHARS + 1)) })).kind).toBe('invalid-data')
    expect((await fetchSubscription(KEY, { fetch: async () => new Response('<html>') })).kind).toBe('invalid-data')
    expect((await fetchSubscription(KEY, { fetch: async () => jsonResponse({ success: true, data: {} }) })).kind).toBe('invalid-data')
  })
})

describe('resolveBaseURL', () => {
  it('uses the default unless the candidate is https://zenmux.ai', () => {
    expect(resolveBaseURL(undefined)).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('')).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('http://zenmux.ai/api/v1')).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('https://evil.example/api/v1')).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('https://zenmux.ai.evil.example/api/v1')).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('https://user:pw@zenmux.ai/api/v1')).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('not a url')).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseURL('https://zenmux.ai/api/v2/')).toBe('https://zenmux.ai/api/v2')
  })
})

describe('key source', () => {
  it('reads, trims and validates the key', () => {
    expect(readManagementKey({ K: '  abc123  ' }, 'K')).toBe('abc123')
    expect(readManagementKey({}, 'K')).toBeUndefined()
    expect(readManagementKey({ K: '   ' }, 'K')).toBeUndefined()
    expect(readManagementKey({ K: 'ab cd' }, 'K')).toBeUndefined()
    expect(readManagementKey({ K: 'ab\r\nX-Evil: 1' }, 'K')).toBeUndefined()
    expect(readManagementKey({ K: 'ключ' }, 'K')).toBeUndefined()
  })

  it('fingerprints without revealing the key', () => {
    const fingerprint = fingerprintOf(KEY)
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/u)
    expect(KEY).not.toContain(fingerprint)
    expect(fingerprintOf(KEY)).toBe(fingerprint)
    expect(fingerprintOf('other')).not.toBe(fingerprint)
  })
})
