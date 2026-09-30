/**
 * Host half of the ZenMux quota indicator.
 *
 * Reads the Management API key from the launch environment, asks ZenMux for the
 * subscription detail on behalf of the browser (with caching, coalescing and
 * backoff), and serves a whitelisted JSON view over two same-origin GET routes.
 * The key never reaches the browser. The plugin registers no provider and no
 * model.
 *
 * @module dsh-zenmux-quota
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readManagementKey } from './key-source.ts'
import {
  DEFAULT_MANAGEMENT_KEY_ENV,
  DEFAULT_PROVIDER_PATTERN,
  ZENMUX_QUOTA_CONFIG_PATH,
  ZENMUX_QUOTA_SUBSCRIPTION_PATH,
} from './paths.ts'
import type { ZenMuxDisplayMode } from './paths.ts'
import { createHandlers } from './routes.ts'
import type { QuotaSettings } from './routes.ts'
import { DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS, SubscriptionService } from './service.ts'
import { resolveBaseURL } from './upstream.ts'

export { ZENMUX_QUOTA_CONFIG_PATH, ZENMUX_QUOTA_SUBSCRIPTION_PATH } from './paths.ts'
export { parseSubscriptionDetail } from './parse.ts'
export type { SubscriptionDTO, QuotaWindowDTO } from './parse.ts'
export { SubscriptionService } from './service.ts'
export type { SubscriptionResult } from './service.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-zenmux-quota'

/** Plugin configuration. */
export interface Config {
  /** Environment variable holding the Management API key (never the key itself). */
  managementKeyEnv?: string
  /** Exact provider ids that belong to a ZenMux *subscription* key. */
  providers?: string[]
  /** Case-insensitive provider-id pattern used when `providers` is empty. */
  providerPattern?: string
  /** Which window leads the compact bar. */
  display?: ZenMuxDisplayMode
  /** Host cache TTL in seconds (minimum 30). */
  cacheTtlSeconds?: number
  /** Upstream base URL; only `https://zenmux.ai/...` is honoured. */
  baseURL?: string
}

export const Config = z.object({
  managementKeyEnv: z.string().default(DEFAULT_MANAGEMENT_KEY_ENV).volatile(),
  providers: z.array(z.string()).default([]).volatile(),
  providerPattern: z.string().default(DEFAULT_PROVIDER_PATTERN).volatile(),
  display: z.union(['binding', 'five-hour', 'weekly', 'dual'] as const).default('binding').volatile(),
  cacheTtlSeconds: z.number().step(1).min(MIN_CACHE_TTL_MS / 1000).default(DEFAULT_CACHE_TTL_MS / 1000).volatile(),
  baseURL: z.string().default('').volatile(),
})

function liveValue<T>(value: T | undefined, fallback: T): T {
  const candidate = value as T | Volatile<T> | undefined
  if (typeof candidate === 'object' && candidate !== null && 'get' in candidate && typeof candidate.get === 'function') {
    return (candidate.get() ?? fallback) as T
  }
  return (candidate ?? fallback) as T
}

/**
 * Register the quota routes once the web server is available.
 * @param ctx - plugin context.
 * @param config - plugin configuration (volatile fields are read live).
 */
export function apply(ctx: Context, config: Config): void {
  const settings = (): QuotaSettings => ({
    providers: liveValue(config.providers, []),
    providerPattern: liveValue(config.providerPattern, DEFAULT_PROVIDER_PATTERN),
    display: liveValue<ZenMuxDisplayMode>(config.display, 'binding'),
  })
  const reported = new Set<string>()
  const service = new SubscriptionService({
    keySource: () => readManagementKey(process.env, liveValue(config.managementKeyEnv, DEFAULT_MANAGEMENT_KEY_ENV)),
    // Both are volatile config: read on every use so a hot update takes effect
    // without the plugin being re-applied.
    cacheTtlMs: () => liveValue(config.cacheTtlSeconds, DEFAULT_CACHE_TTL_MS / 1000) * 1000,
    baseURL: () => resolveBaseURL(liveValue(config.baseURL, '')),
    // Only state changes worth a user's attention are printed, once each.
    log: (event, fields) => {
      const kind = String(fields['kind'])
      if (event !== 'upstream') return
      if (kind === 'ok') {
        reported.clear()
        return
      }
      if (reported.has(kind)) return
      reported.add(kind)
      const id = fields['requestId'] === undefined ? '' : ` requestId=${String(fields['requestId'])}`
      console.warn(`[dsh-zenmux-quota] upstream ${kind}${id}`)
    },
  })
  ctx.effect(() => () => { service.dispose() }, 'dsh-zenmux-quota: subscription service')

  ctx.inject(['webServer'], webCtx => {
    const handlers = createHandlers({ service, settings })
    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({ kind: 'exact', path: ZENMUX_QUOTA_CONFIG_PATH, handler: handlers.config }),
        webCtx.webServer.register({ kind: 'exact', path: ZENMUX_QUOTA_SUBSCRIPTION_PATH, handler: handlers.subscription }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-zenmux-quota: routes')
  })
}
