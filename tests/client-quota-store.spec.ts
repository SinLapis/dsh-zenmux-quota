/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZenMuxQuotaStore } from '../src/client/quota-store.ts'
import { ZENMUX_QUOTA_CONFIG_PATH, ZENMUX_QUOTA_SUBSCRIPTION_PATH } from '../src/paths.ts'
import { jsonResponse, subscriptionDto } from './fixtures.ts'

const CONFIG = { configured: true, providers: [], providerPattern: '^zenmux', display: 'binding' }

function readyBody(fetchedAt = Date.now()): unknown {
  return { state: 'ready', data: subscriptionDto(), fetchedAt }
}

type Handler = (url: string) => Response | Promise<Response>

function setup(handler: Handler) {
  const fetchMock = vi.fn(async (url: string) => handler(url))
  const store = new ZenMuxQuotaStore({ fetch: fetchMock as unknown as typeof fetch, random: () => 0.5 })
  const subscriptionCalls = (): number => fetchMock.mock.calls.filter(call => String(call[0]).startsWith(ZENMUX_QUOTA_SUBSCRIPTION_PATH)).length
  return { store, fetchMock, subscriptionCalls }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  setVisibility('visible')
})
afterEach(() => {
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('ZenMuxQuotaStore', () => {
  it('shares one request among many retainers and stops when the last one leaves', async () => {
    const { store, subscriptionCalls } = setup(() => jsonResponse(readyBody()))
    const a = store.retain()
    const b = store.retain()
    await flush()
    expect(subscriptionCalls()).toBe(1)
    expect(store.getSnapshot().quota.state).toBe('ready')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscriptionCalls()).toBe(2)

    a()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscriptionCalls()).toBe(3)
    b()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(subscriptionCalls()).toBe(3)
    store.dispose()
  })

  it('schedules the next poll only after the previous request settles', async () => {
    let release: (() => void) | undefined
    const { store, subscriptionCalls } = setup(() => new Promise<Response>(resolve => {
      release = () => { resolve(jsonResponse(readyBody())) }
    }))
    store.retain()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(subscriptionCalls()).toBe(1)
    release?.()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscriptionCalls()).toBe(2)
    store.dispose()
  })

  it('loads the config once and validates it', async () => {
    const { store, fetchMock } = setup(url => (url === ZENMUX_QUOTA_CONFIG_PATH ? jsonResponse(CONFIG) : jsonResponse(readyBody())))
    store.ensureConfig()
    store.ensureConfig()
    await flush()
    expect(fetchMock.mock.calls.filter(call => call[0] === ZENMUX_QUOTA_CONFIG_PATH)).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ configStatus: 'ready', config: { providerPattern: '^zenmux' } })
    store.dispose()
  })

  it('marks the config unavailable for a 404 and stops asking', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, fetchMock } = setup(() => new Response('nope', { status: 404 }))
    store.ensureConfig()
    await flush()
    expect(store.getSnapshot().configStatus).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    store.ensureConfig()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    store.dispose()
  })

  it('ignores an unrecognizable config', async () => {
    const { store } = setup(() => jsonResponse({ configured: 'yes' }))
    store.ensureConfig()
    await flush()
    expect(store.getSnapshot().configStatus).toBe('unavailable')
    expect(store.getSnapshot().config).toBeUndefined()
    store.dispose()
  })

  it('stops permanently on 404 and on 403 without polling', async () => {
    const missing = setup(() => new Response('x', { status: 404 }))
    missing.store.retain()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(missing.store.getSnapshot().quota.state).toBe('route-missing')
    expect(missing.subscriptionCalls()).toBe(1)
    missing.store.dispose()

    const forbidden = setup(() => new Response('x', { status: 403 }))
    forbidden.store.retain()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(forbidden.store.getSnapshot().quota.state).toBe('forbidden')
    expect(forbidden.subscriptionCalls()).toBe(1)
    forbidden.store.dispose()
  })

  it('does not poll after not-configured or unauthorized', async () => {
    for (const state of ['not-configured', 'unauthorized']) {
      const { store, subscriptionCalls } = setup(() => jsonResponse({ state }))
      store.retain()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(store.getSnapshot().quota.state).toBe(state)
      expect(subscriptionCalls()).toBe(1)
      store.dispose()
    }
  })

  it('backs off network failures 60, 120, then 300 seconds and recovers', async () => {
    let failing = true
    const { store, subscriptionCalls } = setup(() => {
      if (failing) throw new TypeError('network')
      return jsonResponse(readyBody())
    })
    store.retain()
    await flush()
    expect(store.getSnapshot().quota.state).toBe('upstream-error')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(subscriptionCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subscriptionCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(118_000)
    expect(subscriptionCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(subscriptionCalls()).toBe(3)
    failing = false
    await vi.advanceTimersByTimeAsync(301_000)
    expect(store.getSnapshot().quota.state).toBe('ready')
    store.dispose()
  })

  it('keeps the last data, marked stale, when a later request fails', async () => {
    let failing = false
    const { store } = setup(() => {
      if (failing) throw new TypeError('network')
      return jsonResponse(readyBody())
    })
    store.retain()
    await flush()
    failing = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.getSnapshot().quota).toMatchObject({ state: 'upstream-error', stale: true })
    expect(store.getSnapshot().quota.data).toBeDefined()
    store.dispose()
  })

  it('uses the Host stale answer for a rate-limited result and honours retryAfterMs', async () => {
    const stale = { state: 'ready', data: subscriptionDto(), fetchedAt: Date.now() - 1000 }
    const bodies = [{ state: 'rate-limited', retryAfterMs: 120_000, stale }, readyBody()]
    const { store, subscriptionCalls } = setup(() => jsonResponse(bodies.shift() ?? readyBody()))
    store.retain()
    await flush()
    expect(store.getSnapshot().quota).toMatchObject({ state: 'rate-limited', stale: true })
    await vi.advanceTimersByTimeAsync(119_000)
    expect(subscriptionCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subscriptionCalls()).toBe(2)
    store.dispose()
  })

  it('degrades an unrecognizable body to invalid-data', async () => {
    const { store } = setup(() => jsonResponse({ state: 'ready', data: { nope: true }, fetchedAt: 1 }))
    store.retain()
    await flush()
    expect(store.getSnapshot().quota.state).toBe('invalid-data')
    store.dispose()
  })

  it('pauses while hidden and refetches on return when the data is old', async () => {
    const { store, subscriptionCalls } = setup(() => jsonResponse(readyBody()))
    store.retain()
    await flush()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(subscriptionCalls()).toBe(1)
    setVisibility('visible')
    await flush()
    expect(subscriptionCalls()).toBe(2)
    store.dispose()
  })

  it('does not refetch on a quick return to the foreground', async () => {
    const { store, subscriptionCalls } = setup(() => jsonResponse(readyBody()))
    store.retain()
    await flush()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5_000)
    setVisibility('visible')
    await flush()
    expect(subscriptionCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(56_000)
    expect(subscriptionCalls()).toBe(2)
    store.dispose()
  })

  it('throttles manual refresh to once per ten seconds and forces the Host', async () => {
    const { store, fetchMock, subscriptionCalls } = setup(() => jsonResponse(readyBody()))
    store.retain()
    await flush()
    store.refresh()
    await flush()
    expect(subscriptionCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(11_000)
    store.refresh()
    await flush()
    expect(subscriptionCalls()).toBe(2)
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('refresh=1')
    store.dispose()
  })

  it('does not let a late response from a released lifecycle write', async () => {
    let release: (() => void) | undefined
    const { store } = setup(() => new Promise<Response>(resolve => {
      release = () => { resolve(jsonResponse(readyBody())) }
    }))
    const leave = store.retain()
    await flush()
    leave()
    release?.()
    await flush()
    expect(store.getSnapshot().quota.state).not.toBe('ready')
    store.dispose()
  })

  it('reuses a fresh snapshot when retained again soon after', async () => {
    const { store, subscriptionCalls } = setup(() => jsonResponse(readyBody()))
    const first = store.retain()
    await flush()
    first()
    store.retain()
    await flush()
    expect(subscriptionCalls()).toBe(1)
    store.dispose()
  })

  it('is inert after dispose and removes its document listener', async () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { store, fetchMock } = setup(() => jsonResponse(readyBody()))
    store.dispose()
    store.retain()
    store.refresh()
    store.ensureConfig()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    remove.mockRestore()
  })

  it('notifies subscribers with a fresh snapshot identity for each change', async () => {
    const { store } = setup(() => jsonResponse(readyBody()))
    const seen: unknown[] = []
    store.subscribe(() => { seen.push(store.getSnapshot()) })
    store.retain()
    await flush()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(new Set(seen).size).toBe(seen.length)
    store.dispose()
  })

  it('forces a refresh just after a window reset that comes before the next poll', async () => {
    const body = (): unknown => ({
      state: 'ready',
      data: subscriptionDto({ fiveHour: { ...subscriptionDto().fiveHour!, resetsAt: Date.now() + 25_000 } }),
      fetchedAt: Date.now(),
    })
    const { store, fetchMock, subscriptionCalls } = setup(() => jsonResponse(body()))
    store.retain()
    await flush()
    await vi.advanceTimersByTimeAsync(26_000)
    expect(subscriptionCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(subscriptionCalls()).toBe(2)
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('refresh=1')
    store.dispose()
  })

  it('never schedules the reset refresh sooner than the 10 s floor', async () => {
    const body = (): unknown => ({
      state: 'ready',
      data: subscriptionDto({ fiveHour: { ...subscriptionDto().fiveHour!, resetsAt: Date.now() + 1_000 } }),
      fetchedAt: Date.now(),
    })
    const { store, subscriptionCalls } = setup(() => jsonResponse(body()))
    store.retain()
    await flush()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(subscriptionCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(subscriptionCalls()).toBe(2)
    store.dispose()
  })

  it('polls at the regular interval when no reset is near', async () => {
    const { store, fetchMock, subscriptionCalls } = setup(() => jsonResponse(readyBody()))
    store.retain()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscriptionCalls()).toBe(2)
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain('refresh=1')
    store.dispose()
  })
})
