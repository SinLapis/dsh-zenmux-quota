/**
 * HTTP handlers for the browser half, plus the trusted-request gate.
 *
 * The gate follows `dsh-codex`'s loopback rule: no `Sec-Fetch-Site: cross-site`,
 * an `Origin` (when present) identical to the effective Host origin, and a
 * loopback peer together with a loopback Host. Remote or reverse-proxied access
 * is refused with 403 rather than negotiated.
 *
 * @module dsh-zenmux-quota/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZenMuxDisplayMode } from './paths.ts'
import type { SubscriptionService } from './service.ts'

/** Live, hot-reloadable settings the config route reports. */
export interface QuotaSettings {
  readonly providers: readonly string[]
  readonly providerPattern: string
  readonly display: ZenMuxDisplayMode
}

/** Dependencies of the route handlers. */
export interface RouteDeps {
  readonly service: SubscriptionService
  readonly settings: () => QuotaSettings
}

/** One route handler. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function loopbackHost(rawHost: string): boolean {
  if (/[\\/@?#]/u.test(rawHost)) return false
  try {
    const parsed = new URL(`http://${rawHost}`)
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      return false
    }
    const bracketless = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname
    const hostname = bracketless.toLowerCase().replace(/\.$/u, '')
    return hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '::ffff:127.0.0.1'
  } catch {
    return false
  }
}

function effectiveOrigin(req: IncomingMessage, host: string): string | undefined {
  try {
    const encrypted = (req.socket as IncomingMessage['socket'] & { encrypted?: boolean }).encrypted === true
    return new URL(`${encrypted ? 'https' : 'http'}://${host}`).origin
  } catch {
    return undefined
  }
}

/**
 * Whether the request may read quota data.
 * @param req - the incoming request.
 * @returns `true` only for same-origin requests from a loopback peer and Host.
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  const localPeer = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const fetchSite: unknown = req.headers['sec-fetch-site']
  const values = Array.isArray(fetchSite) ? fetchSite : [fetchSite]
  if (values.some(value => typeof value === 'string' && value.trim().toLowerCase() === 'cross-site')) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const origin = effectiveOrigin(req, host)
  if (origin === undefined) return false
  const claimed = req.headers.origin
  if (claimed !== undefined) {
    if (typeof claimed !== 'string') return false
    try {
      if (new URL(claimed).origin !== origin) return false
    } catch {
      return false
    }
  }
  return localPeer && loopbackHost(host)
}

/** Write a JSON body with the security headers every response here carries. */
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Build the two route handlers.
 * @param deps - service and live settings.
 * @returns the `config` and `subscription` handlers.
 */
export function createHandlers(deps: RouteDeps): { readonly config: RouteHandler; readonly subscription: RouteHandler } {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return false
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { error: 'forbidden' })
      return false
    }
    return true
  }
  return {
    config: async (req, res) => {
      if (!guard(req, res)) return
      const settings = deps.settings()
      json(res, 200, {
        ...deps.service.keyStatus(),
        providers: [...settings.providers],
        providerPattern: settings.providerPattern,
        display: settings.display,
      })
    },
    subscription: async (req, res) => {
      if (!guard(req, res)) return
      let refresh = false
      try {
        refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
      } catch {
        refresh = false
      }
      try {
        json(res, 200, await deps.service.get(refresh))
      } catch {
        json(res, 500, { error: 'internal error' })
      }
    },
  }
}
