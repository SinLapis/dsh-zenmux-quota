/**
 * Host-side subscription service: one upstream request at a time, TTL cache,
 * refresh throttling, backoff, and bounded stale fallback.
 *
 * There is deliberately no timer in here. The service only talks to ZenMux when
 * somebody asks, so a page nobody is looking at produces no upstream traffic.
 *
 * @module dsh-zenmux-quota/service
 */

import { fingerprintOf } from './key-source.ts'
import type { SubscriptionDTO } from './parse.ts'
import { DEFAULT_BASE_URL, fetchSubscription } from './upstream.ts'
import type { FetchSubscriptionOptions, UpstreamOutcome } from './upstream.ts'

/** A successful, cached answer. */
export interface ReadyResult {
  readonly state: 'ready'
  readonly data: SubscriptionDTO
  /** Epoch ms of the upstream response. */
  readonly fetchedAt: number
  readonly keyFingerprint: string
}

/** Everything the subscription route can answer. */
export type SubscriptionResult =
  | ReadyResult
  | { readonly state: 'not-configured' }
  | { readonly state: 'unauthorized'; readonly keyFingerprint: string }
  | {
    readonly state: 'rate-limited' | 'upstream-error' | 'invalid-data'
    readonly retryAfterMs: number
    /** Last good answer, only while recent and from the same key. */
    readonly stale?: ReadyResult
  }

/** Structured, secret-free log sink. */
export type ServiceLog = (event: string, fields: Readonly<Record<string, string | number>>) => void

/** A value fixed at construction, or read live on every use (hot-reloadable config). */
export type Live<T> = T | (() => T)

/** Constructor options. */
export interface SubscriptionServiceOptions {
  /** Returns the current Management key, or `undefined` when none is configured. */
  readonly keySource: () => string | undefined
  /** Cache TTL (ms); read on every call when given as a function. */
  readonly cacheTtlMs?: Live<number>
  /** Upstream base URL; read on every upstream call when given as a function. */
  readonly baseURL?: Live<string>
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** Returns a value in [0, 1) for backoff jitter. */
  readonly random?: () => number
  readonly log?: ServiceLog
}

/** Shortest interval between two forced upstream refreshes. */
export const MIN_REFRESH_INTERVAL_MS = 10_000
/** How long a last-good answer may back a failure. */
export const STALE_MAX_AGE_MS = 5 * 60_000
/** Lower bound for the configured cache TTL. */
export const MIN_CACHE_TTL_MS = 30_000
/** Default cache TTL. */
export const DEFAULT_CACHE_TTL_MS = 60_000

const ERROR_BACKOFF_MS = [60_000, 120_000, 300_000] as const
const RATE_LIMIT_FLOOR_MS = 60_000
const RATE_LIMIT_CAP_MS = 300_000
const INVALID_DATA_DELAY_MS = 300_000

interface FailureMemory {
  readonly state: 'rate-limited' | 'upstream-error' | 'invalid-data' | 'unauthorized'
  /** Epoch ms until which no automatic upstream call is made. */
  readonly until: number
}

/** The one in-flight upstream request, tagged with the key it was made for. */
interface Inflight {
  readonly fingerprint: string
  readonly promise: Promise<SubscriptionResult>
}

function read<T>(value: Live<T> | undefined, fallback: T): T {
  if (value === undefined) return fallback
  return typeof value === 'function' ? (value as () => T)() : value
}

/** Cached, coalesced access to the ZenMux subscription detail. */
export class SubscriptionService {
  private readonly options: SubscriptionServiceOptions
  private readonly now: () => number
  private readonly random: () => number
  private readonly controller = new AbortController()
  private inflight: Inflight | undefined
  private cache: ReadyResult | undefined
  private failure: FailureMemory | undefined
  /** Consecutive 5xx/network failures; drives the 60/120/300 s ladder. */
  private errorCount = 0
  /** Consecutive 422/429 answers; drives the rate-limit doubling. Kept apart from errorCount. */
  private rateLimitCount = 0
  private lastUpstreamAt = Number.NEGATIVE_INFINITY
  private fingerprint: string | undefined
  private disposed = false

  constructor(options: SubscriptionServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /** Current cache TTL, never below the 30 s floor. */
  private ttl(): number {
    const value = read(this.options.cacheTtlMs, DEFAULT_CACHE_TTL_MS)
    return Number.isFinite(value) ? Math.max(MIN_CACHE_TTL_MS, value) : DEFAULT_CACHE_TTL_MS
  }

  /** Whether a usable key is currently configured, and its fingerprint. */
  keyStatus(): { readonly configured: boolean; readonly keyFingerprint?: string } {
    const key = this.options.keySource()
    return key === undefined ? { configured: false } : { configured: true, keyFingerprint: fingerprintOf(key) }
  }

  /**
   * Current subscription state.
   *
   * A refresh skips the TTL cache (at most every 10 seconds) and retries an
   * `unauthorized` key, but it never shortens a rate-limit, error, or
   * invalid-data backoff: repeated clicks must not hammer a limited endpoint.
   *
   * @param refresh - a user-requested refresh.
   * @returns a result; never rejects.
   */
  async get(refresh = false): Promise<SubscriptionResult> {
    if (this.disposed) return { state: 'upstream-error', retryAfterMs: ERROR_BACKOFF_MS[0] }
    const key = this.options.keySource()
    if (key === undefined) {
      this.reset()
      this.fingerprint = undefined
      return { state: 'not-configured' }
    }
    const fingerprint = fingerprintOf(key)
    if (fingerprint !== this.fingerprint) {
      this.reset()
      this.fingerprint = fingerprint
    }

    const now = this.now()
    const failure = this.failure
    if (failure !== undefined && now < failure.until) {
      const retryable = failure.state === 'unauthorized' && refresh && now - this.lastUpstreamAt >= MIN_REFRESH_INTERVAL_MS
      if (!retryable) return this.failureResult(now, fingerprint)
    }
    const forced = refresh && now - this.lastUpstreamAt >= MIN_REFRESH_INTERVAL_MS
    if (!forced && this.cache !== undefined && now - this.cache.fetchedAt < this.ttl()) return this.cache

    // Only join a request made for the *current* key; `reset()` already dropped
    // any older one, so this can never hand back another key's answer.
    const inflight = this.inflight
    if (inflight !== undefined && inflight.fingerprint === fingerprint) return inflight.promise
    const promise: Promise<SubscriptionResult> = this.fetchOnce(key, fingerprint).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined
    })
    this.inflight = { fingerprint, promise }
    return promise
  }

  /** Abort any in-flight request and drop cached state. */
  dispose(): void {
    this.disposed = true
    this.controller.abort()
    this.reset()
  }

  private reset(): void {
    this.cache = undefined
    this.failure = undefined
    this.errorCount = 0
    this.rateLimitCount = 0
    this.lastUpstreamAt = Number.NEGATIVE_INFINITY
    // The old request keeps running but can no longer be joined; its answer is
    // discarded by the fingerprint check in fetchOnce.
    this.inflight = undefined
  }

  private staleFor(now: number): ReadyResult | undefined {
    const cache = this.cache
    return cache !== undefined && now - cache.fetchedAt <= STALE_MAX_AGE_MS ? cache : undefined
  }

  private failureResult(now: number, fingerprint: string): SubscriptionResult {
    const failure = this.failure
    if (failure === undefined || failure.state === 'unauthorized') {
      return { state: 'unauthorized', keyFingerprint: fingerprint }
    }
    const stale = this.staleFor(now)
    return {
      state: failure.state,
      retryAfterMs: Math.max(0, failure.until - now),
      ...stale === undefined ? {} : { stale },
    }
  }

  /** Jittered step of the 60 / 120 / 300 s ladder. */
  private errorDelay(): number {
    const base = ERROR_BACKOFF_MS[Math.min(this.errorCount, ERROR_BACKOFF_MS.length) - 1] ?? ERROR_BACKOFF_MS[2]
    return Math.round(base * (0.9 + this.random() * 0.2))
  }

  private async fetchOnce(key: string, fingerprint: string): Promise<SubscriptionResult> {
    this.lastUpstreamAt = this.now()
    const fetchOptions: FetchSubscriptionOptions = {
      baseURL: read(this.options.baseURL, DEFAULT_BASE_URL),
      signal: this.controller.signal,
      ...this.options.fetch === undefined ? {} : { fetch: this.options.fetch },
      ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
    }
    const startedAt = this.now()
    const outcome = await fetchSubscription(key, fetchOptions)
    const now = this.now()
    this.options.log?.('upstream', {
      kind: outcome.kind,
      ms: now - startedAt,
      ...outcome.requestId === undefined ? {} : { requestId: outcome.requestId },
    })

    if (this.disposed) return { state: 'upstream-error', retryAfterMs: ERROR_BACKOFF_MS[0] }
    // The key changed while this request was in flight. Its answer belongs to a
    // key nobody uses any more, so it must not touch the state. The callers who
    // joined it asked under the old key; answer them from the current key.
    // This cannot recurse into itself: `reset()` removed this request from
    // `inflight`, so `get()` either joins the new key's request or starts one.
    if (this.fingerprint !== fingerprint) return this.get()
    return this.apply(outcome, now, fingerprint)
  }

  private apply(outcome: UpstreamOutcome, now: number, fingerprint: string): SubscriptionResult {
    switch (outcome.kind) {
      case 'ok': {
        this.cache = { state: 'ready', data: outcome.data, fetchedAt: now, keyFingerprint: fingerprint }
        this.failure = undefined
        this.errorCount = 0
        this.rateLimitCount = 0
        return this.cache
      }
      case 'unauthorized': {
        this.cache = undefined
        this.failure = { state: 'unauthorized', until: Number.POSITIVE_INFINITY }
        return { state: 'unauthorized', keyFingerprint: fingerprint }
      }
      case 'rate-limited': {
        this.rateLimitCount += 1
        const floor = Math.max(outcome.retryAfterMs ?? 0, RATE_LIMIT_FLOOR_MS)
        const cap = Math.max(RATE_LIMIT_CAP_MS, floor)
        const delay = Math.min(floor * 2 ** (this.rateLimitCount - 1), cap)
        return this.fail('rate-limited', now, delay)
      }
      case 'upstream-error': {
        this.errorCount += 1
        return this.fail('upstream-error', now, this.errorDelay())
      }
      case 'invalid-data':
        return this.fail('invalid-data', now, INVALID_DATA_DELAY_MS)
    }
  }

  private fail(state: 'rate-limited' | 'upstream-error' | 'invalid-data', now: number, delay: number): SubscriptionResult {
    this.failure = { state, until: now + delay }
    const stale = this.staleFor(now)
    return { state, retryAfterMs: delay, ...stale === undefined ? {} : { stale } }
  }
}
