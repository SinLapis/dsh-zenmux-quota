import { describe, expect, it, vi } from 'vitest'
import { SubscriptionService } from '../src/service.ts'
import type { SubscriptionResult } from '../src/service.ts'
import { jsonResponse, rawDetail } from './fixtures.ts'

function setup(responses: (() => Response | Promise<Response>)[] | (() => Response | Promise<Response>), options: { key?: () => string | undefined; ttl?: number } = {}) {
  const clock = { now: 1_700_000_000_000 }
  const queue = Array.isArray(responses) ? [...responses] : undefined
  const fetchMock = vi.fn(async () => {
    const next = queue === undefined ? (responses as () => Response | Promise<Response>) : (queue.length > 1 ? queue.shift() : queue[0])
    return (next as () => Response | Promise<Response>)()
  })
  const logs: string[] = []
  const keyBox = { key: 'key-one' as string | undefined }
  const service = new SubscriptionService({
    keySource: options.key ?? (() => keyBox.key),
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock.now,
    random: () => 0.5,
    ...options.ttl === undefined ? {} : { cacheTtlMs: options.ttl },
    log: (event, fields) => { logs.push(`${event} ${JSON.stringify(fields)}`) },
  })
  return { service, clock, fetchMock, keyBox, logs }
}

type Failed = Extract<SubscriptionResult, { retryAfterMs: number }>

const ok = (): Response => jsonResponse(rawDetail())
const status = (code: number, headers: Record<string, string> = {}) => (): Response => new Response('{}', { status: code, headers })

describe('SubscriptionService', () => {
  it('reports not-configured without calling upstream', async () => {
    const { service, fetchMock, keyBox } = setup(ok)
    keyBox.key = undefined
    expect(await service.get()).toEqual({ state: 'not-configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('coalesces concurrent requests into one upstream call', async () => {
    const { service, fetchMock } = setup(ok)
    const results = await Promise.all([service.get(), service.get(), service.get()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results.every(result => result.state === 'ready')).toBe(true)
  })

  it('serves from cache within the TTL and refetches after it', async () => {
    const { service, fetchMock, clock } = setup(ok)
    await service.get()
    clock.now += 59_000
    await service.get()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    clock.now += 2_000
    await service.get()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('enforces the minimum TTL of 30 seconds', async () => {
    const { service, fetchMock, clock } = setup(ok, { ttl: 1_000 })
    await service.get()
    clock.now += 20_000
    await service.get()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bypasses the cache for a refresh only when 10 seconds have passed', async () => {
    const { service, fetchMock, clock } = setup(ok)
    await service.get()
    clock.now += 5_000
    await service.get(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    clock.now += 6_000
    await service.get(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off 422 by at least 60 seconds and doubles on repeats, capped at 5 minutes', async () => {
    const { service, fetchMock, clock } = setup(status(422))
    const first = await service.get() as Failed
    expect(first).toMatchObject({ state: 'rate-limited', retryAfterMs: 60_000 })
    // Inside the window nothing more is sent.
    clock.now += 30_000
    const again = await service.get() as Failed
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(again.retryAfterMs).toBe(30_000)
    clock.now += 31_000
    expect(await service.get()).toMatchObject({ retryAfterMs: 120_000 })
    clock.now += 121_000
    expect(await service.get()).toMatchObject({ retryAfterMs: 240_000 })
    clock.now += 241_000
    expect(await service.get()).toMatchObject({ retryAfterMs: 300_000 })
  })

  it('honours a longer Retry-After', async () => {
    const { service } = setup(status(429, { 'retry-after': '200' }))
    expect(await service.get()).toMatchObject({ state: 'rate-limited', retryAfterMs: 200_000 })
  })

  it('walks the 60/120/300 second ladder for upstream errors', async () => {
    const { service, clock } = setup(status(500))
    expect(await service.get()).toMatchObject({ state: 'upstream-error', retryAfterMs: 60_000 })
    clock.now += 61_000
    expect(await service.get()).toMatchObject({ retryAfterMs: 120_000 })
    clock.now += 121_000
    expect(await service.get()).toMatchObject({ retryAfterMs: 300_000 })
    clock.now += 301_000
    expect(await service.get()).toMatchObject({ retryAfterMs: 300_000 })
  })

  it('resets the backoff after a success', async () => {
    const { service, clock } = setup([status(500), ok, status(500)])
    await service.get()
    clock.now += 61_000
    expect((await service.get()).state).toBe('ready')
    clock.now += 61_000
    expect(await service.get()).toMatchObject({ state: 'upstream-error', retryAfterMs: 60_000 })
  })

  it('does not retry unauthorized automatically, only on a forced refresh', async () => {
    const { service, fetchMock, clock } = setup([status(403), ok])
    expect((await service.get()).state).toBe('unauthorized')
    clock.now += 3_600_000
    expect((await service.get()).state).toBe('unauthorized')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await service.get(true)).state).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the last good answer as stale for five minutes', async () => {
    const { service, clock } = setup([ok, status(500)])
    const first = await service.get() as Extract<SubscriptionResult, { state: 'ready' }>
    clock.now += 61_000
    const failed = await service.get() as Failed
    expect(failed.state).toBe('upstream-error')
    expect(failed.stale?.fetchedAt).toBe(first.fetchedAt)
    // Past five minutes the stale answer is withheld.
    clock.now += 5 * 60_000
    const old = await service.get() as Failed
    expect(old.stale).toBeUndefined()
  })

  it('drops cache and backoff when the key changes', async () => {
    const { service, fetchMock, keyBox } = setup([ok, status(500), ok])
    const first = await service.get() as Extract<SubscriptionResult, { state: 'ready' }>
    keyBox.key = 'key-two'
    const second = await service.get() as Failed
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.stale).toBeUndefined()
    expect(first.keyFingerprint).not.toBe('')
    keyBox.key = 'key-three'
    expect((await service.get()).state).toBe('ready')
  })

  it('reports invalid data and holds off for five minutes', async () => {
    const { service } = setup(() => new Response('<html>'))
    expect(await service.get()).toMatchObject({ state: 'invalid-data', retryAfterMs: 300_000 })
  })

  it('aborts in-flight work and refuses further calls after dispose', async () => {
    const clock = { now: 0 }
    const signals: AbortSignal[] = []
    const service = new SubscriptionService({
      keySource: () => 'k',
      now: () => clock.now,
      fetch: ((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal)
        return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) })
      }) as unknown as typeof fetch,
    })
    const pending = service.get()
    service.dispose()
    expect(signals[0]?.aborted).toBe(true)
    expect((await pending).state).toBe('upstream-error')
    expect((await service.get()).state).toBe('upstream-error')
  })

  it('never logs the key or the response body', async () => {
    const { service, logs } = setup(ok)
    await service.get()
    expect(logs.join('\n')).not.toContain('key-one')
    expect(logs.join('\n')).not.toContain('quota_5_hour')
  })

  // --- review regressions -------------------------------------------------

  /** Race a promise against a short real-time deadline, to catch a hang. */
  const settles = <T,>(promise: Promise<T>): Promise<T | 'HUNG'> =>
    Promise.race([promise, new Promise<'HUNG'>(resolve => { setTimeout(() => { resolve('HUNG') }, 300) })])

  it('does not hang or leak the old key\'s answer when the key changes mid-flight', async () => {
    let release: (() => void) | undefined
    const seenKeys: string[] = []
    let key = 'key-one'
    const service = new SubscriptionService({
      keySource: () => key,
      fetch: (async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)['authorization'] ?? ''
        seenKeys.push(auth)
        if (seenKeys.length === 1) await new Promise<void>(resolve => { release = resolve })
        return jsonResponse(rawDetail())
      }) as unknown as typeof fetch,
    })
    const oldCall = service.get()
    await Promise.resolve()
    key = 'key-two'
    const newCall = service.get()
    release?.()
    const [a, b] = await Promise.all([settles(oldCall), settles(newCall)])
    expect(a).not.toBe('HUNG')
    expect(b).not.toBe('HUNG')
    // The new-key caller must be answered by a request made with the new key.
    expect(seenKeys).toEqual(['Bearer key-one', 'Bearer key-two'])
    expect((b as SubscriptionResult).state).toBe('ready')
    // And the service keeps working afterwards.
    expect(await settles(service.get())).not.toBe('HUNG')
  })

  it('never lets a refresh shorten a rate-limit backoff', async () => {
    const { service, fetchMock, clock } = setup(status(422))
    await service.get()
    for (let i = 0; i < 5; i += 1) {
      clock.now += 10_000
      expect((await service.get(true)).state).toBe('rate-limited')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    clock.now += 11_000
    await service.get(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never lets a refresh shorten an upstream-error or invalid-data backoff', async () => {
    const errors = setup(status(500))
    await errors.service.get()
    errors.clock.now += 20_000
    await errors.service.get(true)
    expect(errors.fetchMock).toHaveBeenCalledTimes(1)

    const invalid = setup(() => new Response('<html>'))
    await invalid.service.get()
    invalid.clock.now += 20_000
    await invalid.service.get(true)
    expect(invalid.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps rate-limit doubling independent of earlier upstream errors', async () => {
    const { service, clock } = setup([status(500), status(500), status(422)])
    await service.get()
    clock.now += 61_000
    await service.get()
    clock.now += 121_000
    expect(await service.get()).toMatchObject({ state: 'rate-limited', retryAfterMs: 60_000 })
  })

  it('reads the cache TTL and base URL live, so hot config updates apply', async () => {
    const clock = { now: 0 }
    const live = { ttl: 60_000, base: 'https://zenmux.ai/api/v1' }
    const fetchMock = vi.fn(async () => jsonResponse(rawDetail()))
    const service = new SubscriptionService({
      keySource: () => 'k',
      now: () => clock.now,
      fetch: fetchMock as unknown as typeof fetch,
      cacheTtlMs: () => live.ttl,
      baseURL: () => live.base,
    })
    await service.get()
    live.ttl = 300_000
    clock.now += 120_000
    await service.get()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    live.ttl = 30_000
    live.base = 'https://zenmux.ai/api/v2'
    await service.get()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe('https://zenmux.ai/api/v2/management/subscription/detail')
  })

  it('reports key status without contacting upstream', () => {
    const { service, fetchMock, keyBox } = setup(ok)
    expect(service.keyStatus().configured).toBe(true)
    expect(service.keyStatus().keyFingerprint).toMatch(/^[0-9a-f]{8}$/u)
    keyBox.key = undefined
    expect(service.keyStatus()).toEqual({ configured: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
