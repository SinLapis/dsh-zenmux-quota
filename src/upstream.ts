/**
 * Thin client for ZenMux's Management subscription endpoint.
 *
 * Security posture: no cookies, `redirect: 'error'` so the Bearer token can
 * never follow a redirect to another host, bounded timeout, bounded body.
 *
 * @module dsh-zenmux-quota/upstream
 */

import { parseSubscriptionDetail } from './parse.ts'
import type { SubscriptionDTO } from './parse.ts'

/** Default upstream base. */
export const DEFAULT_BASE_URL = 'https://zenmux.ai/api/v1'
/** Upstream request timeout. */
export const UPSTREAM_TIMEOUT_MS = 15_000
/** Largest response body accepted, in characters. */
export const MAX_BODY_CHARS = 64 * 1024

/** Result of one upstream call, before service-level caching and backoff. */
export type UpstreamOutcome =
  | { readonly kind: 'ok'; readonly data: SubscriptionDTO; readonly requestId?: string }
  | { readonly kind: 'unauthorized'; readonly requestId?: string }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs?: number; readonly requestId?: string }
  | { readonly kind: 'upstream-error'; readonly requestId?: string }
  | { readonly kind: 'invalid-data'; readonly requestId?: string }

/** Options for {@link fetchSubscription}. */
export interface FetchSubscriptionOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly baseURL?: string
  readonly timeoutMs?: number
  /** Cancels the request (service disposal). */
  readonly signal?: AbortSignal
}

/**
 * Accept only `https://zenmux.ai/...` as an upstream base.
 *
 * @param candidate - configured base URL.
 * @returns the normalized base (no trailing slash), or the default when the
 * candidate is absent or would send the Bearer token somewhere else.
 */
export function resolveBaseURL(candidate: string | undefined): string {
  if (candidate === undefined || candidate.trim() === '') return DEFAULT_BASE_URL
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.hostname !== 'zenmux.ai' || url.username !== '' || url.password !== '') {
      return DEFAULT_BASE_URL
    }
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
  } catch {
    return DEFAULT_BASE_URL
  }
}

/** Parse a `Retry-After` header given as whole seconds or an HTTP date. */
function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined
}

/**
 * Call the subscription endpoint once.
 *
 * @param key - Management API key (never logged).
 * @param options - fetch implementation, base URL, timeout and abort signal.
 * @returns a classified outcome; never throws for network or HTTP failures.
 */
export async function fetchSubscription(key: string, options: FetchSubscriptionOptions = {}): Promise<UpstreamOutcome> {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.baseURL ?? DEFAULT_BASE_URL
  const timeout = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

  let response: Response
  try {
    response = await doFetch(`${base}/management/subscription/detail`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal,
    })
  } catch {
    return { kind: 'upstream-error' }
  }

  const requestId = response.headers.get('x-zenmux-requestid') ?? undefined
  const withId = requestId === undefined ? {} : { requestId }
  const status = response.status

  if (status === 401 || status === 403) return { kind: 'unauthorized', ...withId }
  if (status === 422 || status === 429) {
    const wait = retryAfterMs(response.headers.get('retry-after'), Date.now())
    return { kind: 'rate-limited', ...wait === undefined ? {} : { retryAfterMs: wait }, ...withId }
  }
  if (!response.ok) return { kind: 'upstream-error', ...withId }

  let text: string
  try {
    text = await response.text()
  } catch {
    return { kind: 'upstream-error', ...withId }
  }
  if (text.length > MAX_BODY_CHARS) return { kind: 'invalid-data', ...withId }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'invalid-data', ...withId }
  }
  const data = parseSubscriptionDetail(json)
  return data === undefined ? { kind: 'invalid-data', ...withId } : { kind: 'ok', data, ...withId }
}
