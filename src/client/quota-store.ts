/**
 * Page-wide quota store shared by every mounted indicator.
 *
 * One instance per browser plugin. Indicators `retain()` it while a ZenMux model
 * is selected; the first retainer starts polling, the last one stops it. A
 * request is scheduled only *after* the previous one settles, so nothing can
 * pile up, and a `generation` counter stops a late response from a torn-down
 * lifecycle from writing into the current state.
 *
 * @module dsh-zenmux-quota/client/quota-store
 */

import { ZENMUX_QUOTA_CONFIG_PATH, ZENMUX_QUOTA_SUBSCRIPTION_PATH } from '../paths.ts'
import type { SubscriptionDTO } from '../parse.ts'
import { parseConfigView, parseRouteResult } from './route-adapter.ts'
import { nextResetDelay } from './quota-view.ts'
import type { ConfigView } from './route-adapter.ts'

/** Lifecycle of the subscription data. */
export type QuotaState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'not-configured'
  | 'unauthorized'
  | 'rate-limited'
  | 'upstream-error'
  | 'invalid-data'
  | 'route-missing'
  | 'forbidden'

/** Immutable quota snapshot. A fresh object is published for every outcome. */
export interface QuotaSnapshot {
  readonly state: QuotaState
  /** Last usable data; present for `ready`, and for failures backed by a recent answer. */
  readonly data?: SubscriptionDTO
  /** Whether `data` is a fallback rather than the newest answer. */
  readonly stale?: boolean
  /** Host's upstream fetch time (epoch ms) for `data`. */
  readonly fetchedAt?: number
  /** Browser receive time (epoch ms) of the answer that produced this snapshot. */
  readonly receivedAtMs?: number
}

/** Config route lifecycle. */
export type ConfigStatus = 'unknown' | 'loading' | 'ready' | 'unavailable'

/** What `useSyncExternalStore` reads. */
export interface StoreState {
  readonly configStatus: ConfigStatus
  readonly config?: ConfigView
  readonly quota: QuotaSnapshot
}

/** Injectable environment, for tests. */
export interface QuotaStoreOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly random?: () => number
  readonly requestTimeoutMs?: number
}

/** Regular poll interval. */
export const POLL_INTERVAL_MS = 60_000
/** Minimum spacing of manual refreshes. */
export const MIN_MANUAL_REFRESH_MS = 10_000
/** A return to the foreground re-polls only if the last request is older than this. */
export const FOREGROUND_REFETCH_MS = 30_000
/** Config is re-read at most this often. */
export const CONFIG_REFRESH_MS = 5 * 60_000
const CONFIG_RETRY_MS = 30_000
const REQUEST_TIMEOUT_MS = 20_000
const CLIENT_BACKOFF_MS = [60_000, 120_000, 300_000] as const
const INVALID_DATA_DELAY_MS = 300_000
/** A failure may keep showing the last answer for this long. */
const STALE_MAX_AGE_MS = 5 * 60_000
const MIN_SERVER_RETRY_MS = 10_000

type FetchOutcome =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed' }

/** Shared, dispose-safe quota state. */
export class ZenMuxQuotaStore {
  private state: StoreState = { configStatus: 'unknown', quota: { state: 'idle' } }
  private readonly listeners = new Set<() => void>()
  private readonly fetchImpl: typeof globalThis.fetch | undefined
  private readonly now: () => number
  private readonly random: () => number
  private readonly timeoutMs: number
  private retainers = 0
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private configController: AbortController | undefined
  private lastRequestAt = Number.NEGATIVE_INFINITY
  private lastConfigAttemptAt = Number.NEGATIVE_INFINITY
  private lastConfigAt = Number.NEGATIVE_INFINITY
  private failureCount = 0
  private configMissing = false
  private disposed = false
  private readonly onVisibility = (): void => { this.handleVisibility() }

  constructor(options: QuotaStoreOptions = {}) {
    this.fetchImpl = options.fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
  }

  /** `useSyncExternalStore` subscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** `useSyncExternalStore` snapshot; identity changes only on real change. */
  getSnapshot = (): StoreState => this.state

  /**
   * Load the Host config if it is missing or old. Cheap and idempotent: every
   * mounted indicator calls it, and only one request is ever in flight.
   */
  ensureConfig(): void {
    if (this.disposed || this.configController !== undefined) return
    if (this.configMissing) return
    const now = this.now()
    if (this.state.config !== undefined && now - this.lastConfigAt < CONFIG_REFRESH_MS) return
    if (now - this.lastConfigAttemptAt < CONFIG_RETRY_MS) return
    this.lastConfigAttemptAt = now
    void this.loadConfig()
  }

  /**
   * Keep data fresh while a ZenMux model is selected.
   * @returns the release function; call it exactly once.
   */
  retain(): () => void {
    if (this.disposed) return () => {}
    this.retainers += 1
    if (this.retainers === 1) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.retainers -= 1
      if (this.retainers === 0) this.stop()
    }
  }

  /** Manual refresh: a forced Host refresh, throttled to once per 10 seconds. */
  refresh(): void {
    if (this.disposed || this.controller !== undefined) return
    if (this.now() - this.lastRequestAt < MIN_MANUAL_REFRESH_MS) return
    this.clearTimer()
    void this.request(true)
  }

  /** Tear everything down; late responses can no longer write. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.clearTimer()
    this.controller?.abort()
    this.configController?.abort()
    this.controller = undefined
    this.configController = undefined
    this.listeners.clear()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
  }

  private publish(next: Partial<StoreState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...next }
    for (const listener of [...this.listeners]) listener()
  }

  private hidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Arm the one poll timer.
   * @param delayMs - delay until the next request.
   * @param forced - ask the Host to bypass its TTL cache (used right after a
   * window reset, when the cached answer is known to be out of date).
   */
  private schedule(delayMs: number, forced = false): void {
    this.clearTimer()
    if (this.disposed || this.retainers === 0 || this.hidden()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.request(forced)
    }, Math.max(0, delayMs))
  }

  private start(): void {
    this.generation += 1
    if (this.hidden()) return
    const elapsed = this.now() - this.lastRequestAt
    if (this.state.quota.state === 'ready' && elapsed < FOREGROUND_REFETCH_MS) {
      this.schedule(POLL_INTERVAL_MS - elapsed)
      return
    }
    void this.request(false)
  }

  private stop(): void {
    this.generation += 1
    this.clearTimer()
    this.controller?.abort()
    this.controller = undefined
  }

  private handleVisibility(): void {
    if (this.disposed || this.retainers === 0) return
    if (this.hidden()) {
      // Pause: no timer, no request. The last snapshot stays, marked by its
      // receive time; returning to the foreground re-fetches.
      this.clearTimer()
      return
    }
    this.ensureConfig()
    const halted = this.state.quota.state === 'route-missing'
    if (halted || this.controller !== undefined) return
    const elapsed = this.now() - this.lastRequestAt
    if (elapsed >= FOREGROUND_REFETCH_MS) void this.request(false)
    else if (this.timer === undefined) this.schedule(POLL_INTERVAL_MS - elapsed)
  }

  private async fetchJson(url: string, signal: AbortSignal): Promise<FetchOutcome> {
    const doFetch = this.fetchImpl ?? globalThis.fetch.bind(globalThis)
    // One local controller joins the caller's cancellation and the request
    // timeout (`AbortSignal.any` is not available in every embedded browser).
    const local = new AbortController()
    const onAbort = (): void => { local.abort() }
    signal.addEventListener('abort', onAbort)
    const timer = setTimeout(onAbort, this.timeoutMs)
    try {
      const response = await doFetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: local.signal,
      })
      if (response.status === 404) return { kind: 'missing' }
      if (response.status === 403) return { kind: 'forbidden' }
      if (!response.ok) return { kind: 'failed' }
      return { kind: 'json', value: await response.json().catch(() => undefined) }
    } catch {
      return { kind: 'failed' }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
  private async loadConfig(): Promise<void> {
    const controller = new AbortController()
    this.configController = controller
    this.publish({ configStatus: this.state.config === undefined ? 'loading' : this.state.configStatus })
    const outcome = await this.fetchJson(ZENMUX_QUOTA_CONFIG_PATH, controller.signal)
    if (this.disposed || this.configController !== controller) return
    this.configController = undefined
    if (outcome.kind === 'json') {
      const config = parseConfigView(outcome.value)
      if (config !== undefined) {
        this.lastConfigAt = this.now()
        this.configMissing = false
        this.publish({ config, configStatus: 'ready' })
        return
      }
    }
    if (outcome.kind === 'missing') {
      this.configMissing = true
      console.warn('[dsh-zenmux-quota] host routes are missing; is the dsh-zenmux-quota host plugin enabled?')
    }
    // Keep the last good config when a refresh fails; hide only if there never was one.
    this.publish({ configStatus: this.state.config === undefined ? 'unavailable' : 'ready' })
  }

  private async request(refresh: boolean): Promise<void> {
    if (this.disposed || this.controller !== undefined) return
    const controller = new AbortController()
    this.controller = controller
    const generation = this.generation
    this.lastRequestAt = this.now()
    if (this.state.quota.data === undefined) this.publish({ quota: { state: 'loading' } })

    const url = refresh ? `${ZENMUX_QUOTA_SUBSCRIPTION_PATH}?refresh=1` : ZENMUX_QUOTA_SUBSCRIPTION_PATH
    const outcome = await this.fetchJson(url, controller.signal)
    // A request from a torn-down lifecycle must not write or reschedule.
    if (this.disposed || generation !== this.generation || this.controller !== controller) return
    this.controller = undefined
    const now = this.now()

    if (outcome.kind === 'missing') {
      this.publish({ quota: { state: 'route-missing' } })
      return
    }
    if (outcome.kind === 'forbidden') {
      this.publish({ quota: { state: 'forbidden' } })
      return
    }
    const result = outcome.kind === 'json' ? parseRouteResult(outcome.value) : undefined
    if (outcome.kind === 'failed') {
      this.failureCount += 1
      this.publish({ quota: this.degraded('upstream-error', now) })
      this.schedule(this.clientBackoff())
      return
    }
    if (result === undefined) {
      this.publish({ quota: this.degraded('invalid-data', now) })
      this.schedule(INVALID_DATA_DELAY_MS)
      return
    }

    switch (result.state) {
      case 'ready':
        this.failureCount = 0
        this.publish({ quota: { state: 'ready', data: result.data, fetchedAt: result.fetchedAt, receivedAtMs: now } })
        this.scheduleAfterReady(result.data, now)
        return
      case 'not-configured':
      case 'unauthorized':
        // Nothing to poll for: the user has to fix the key. A manual refresh or
        // a return to the foreground tries again.
        this.failureCount = 0
        this.publish({ quota: { state: result.state, receivedAtMs: now } })
        return
      case 'rate-limited':
      case 'upstream-error':
      case 'invalid-data':
        this.publish({
          quota: {
            state: result.state,
            receivedAtMs: now,
            ...result.stale === undefined
              ? {}
              : { data: result.stale.data, fetchedAt: result.stale.fetchedAt, stale: true },
          },
        })
        this.schedule(Math.max(result.retryAfterMs, MIN_SERVER_RETRY_MS))
        return
    }
  }

  /**
   * Next poll after a good answer: the regular interval, or a forced refresh
   * just after the earliest window reset when that comes sooner. The 10 s floor
   * matches the Host's forced-refresh floor, so the request is never wasted.
   */
  private scheduleAfterReady(data: SubscriptionDTO, now: number): void {
    const untilReset = nextResetDelay(data, now)
    if (untilReset !== undefined && untilReset < POLL_INTERVAL_MS) {
      this.schedule(Math.max(untilReset, MIN_MANUAL_REFRESH_MS), true)
      return
    }
    this.schedule(POLL_INTERVAL_MS)
  }

  /** A failure snapshot that keeps the previous data (marked stale) if any. */
  private degraded(state: 'upstream-error' | 'invalid-data', now: number): QuotaSnapshot {
    const previous = this.state.quota
    const usable = previous.data !== undefined && previous.fetchedAt !== undefined && now - previous.fetchedAt <= STALE_MAX_AGE_MS
    return !usable || previous.data === undefined
      ? { state, receivedAtMs: now }
      : {
        state,
        receivedAtMs: now,
        data: previous.data,
        stale: true,
        ...previous.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt },
      }
  }

  private clientBackoff(): number {
    const base = CLIENT_BACKOFF_MS[Math.min(this.failureCount, CLIENT_BACKOFF_MS.length) - 1] ?? CLIENT_BACKOFF_MS[2]
    return Math.round(base * (0.9 + this.random() * 0.2))
  }
}
