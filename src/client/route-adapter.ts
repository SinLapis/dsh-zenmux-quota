/**
 * Browser-side validation of the Host's JSON.
 *
 * The Host already whitelisted the ZenMux answer, but the browser still treats
 * the body as `unknown`: a stale Host, a proxy error page, or a future schema
 * change must degrade to a fixed "unrecognized" state rather than render
 * garbage or throw inside React.
 *
 * @module dsh-zenmux-quota/client/route-adapter
 */

import type { AccountStatus, PlanTier, QuotaWindowDTO, SubscriptionDTO } from '../parse.ts'
import { ZENMUX_DISPLAY_MODES } from '../paths.ts'
import type { ZenMuxDisplayMode } from '../paths.ts'

/** A `ready` subscription answer as seen by the browser. */
export interface ReadyView {
  readonly data: SubscriptionDTO
  /** Epoch ms of the Host's upstream fetch. */
  readonly fetchedAt: number
}

/** Validated subscription route answer. */
export type RouteResult =
  | ({ readonly state: 'ready' } & ReadyView)
  | { readonly state: 'not-configured' }
  | { readonly state: 'unauthorized' }
  | {
    readonly state: 'rate-limited' | 'upstream-error' | 'invalid-data'
    readonly retryAfterMs: number
    readonly stale?: ReadyView
  }

/** Validated config route answer. */
export interface ConfigView {
  readonly configured: boolean
  readonly providers: readonly string[]
  readonly providerPattern: string
  readonly display: ZenMuxDisplayMode
}

const TIERS: readonly PlanTier[] = ['free', 'pro', 'max', 'ultra', 'unknown']
const STATUSES: readonly AccountStatus[] = ['healthy', 'monitored', 'abusive', 'suspended', 'banned', 'unknown']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function windowOf(value: unknown): QuotaWindowDTO | undefined {
  if (!isRecord(value)) return undefined
  const usagePercentage = num(value['usagePercentage'])
  const maxFlows = num(value['maxFlows'])
  const usedFlows = num(value['usedFlows'])
  const remainingFlows = num(value['remainingFlows'])
  const usedValueUsd = num(value['usedValueUsd'])
  const maxValueUsd = num(value['maxValueUsd'])
  const rawReset = value['resetsAt']
  const resetsAt = rawReset === null ? null : num(rawReset)
  if (
    usagePercentage === undefined || maxFlows === undefined || usedFlows === undefined
    || remainingFlows === undefined || usedValueUsd === undefined || maxValueUsd === undefined
    || resetsAt === undefined
  ) return undefined
  return { usagePercentage, resetsAt, maxFlows, usedFlows, remainingFlows, usedValueUsd, maxValueUsd }
}

function dtoOf(value: unknown): SubscriptionDTO | undefined {
  if (!isRecord(value)) return undefined
  const fiveHour = windowOf(value['fiveHour'])
  const sevenDay = windowOf(value['sevenDay'])
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  const plan = isRecord(value['plan']) ? value['plan'] : {}
  const tier = TIERS.find(candidate => candidate === plan['tier']) ?? 'unknown'
  const amountUsd = num(plan['amountUsd'])
  const expiresAt = num(plan['expiresAt'])
  const accountStatus = STATUSES.find(candidate => candidate === value['accountStatus']) ?? 'unknown'
  const rawStatus = value['rawAccountStatus']
  const baseUsdPerFlow = num(value['baseUsdPerFlow'])
  const effectiveUsdPerFlow = num(value['effectiveUsdPerFlow'])
  const monthlyRaw = value['monthly']
  let monthly: SubscriptionDTO['monthly']
  if (isRecord(monthlyRaw)) {
    const maxFlows = num(monthlyRaw['maxFlows'])
    const maxValueUsd = num(monthlyRaw['maxValueUsd'])
    if (maxFlows !== undefined && maxValueUsd !== undefined) monthly = { maxFlows, maxValueUsd }
  }
  return {
    plan: {
      tier,
      ...amountUsd === undefined ? {} : { amountUsd },
      ...expiresAt === undefined ? {} : { expiresAt },
    },
    accountStatus,
    ...typeof rawStatus === 'string' ? { rawAccountStatus: rawStatus.slice(0, 16) } : {},
    ...baseUsdPerFlow === undefined ? {} : { baseUsdPerFlow },
    ...effectiveUsdPerFlow === undefined ? {} : { effectiveUsdPerFlow },
    ...fiveHour === undefined ? {} : { fiveHour },
    ...sevenDay === undefined ? {} : { sevenDay },
    ...monthly === undefined ? {} : { monthly },
  }
}

function readyOf(value: unknown): ReadyView | undefined {
  if (!isRecord(value) || value['state'] !== 'ready') return undefined
  const data = dtoOf(value['data'])
  const fetchedAt = num(value['fetchedAt'])
  return data === undefined || fetchedAt === undefined ? undefined : { data, fetchedAt }
}

/**
 * Validate a `subscription` route body.
 * @param value - parsed JSON of unknown shape.
 * @returns the typed result, or `undefined` when the body is not recognizable.
 */
export function parseRouteResult(value: unknown): RouteResult | undefined {
  if (!isRecord(value)) return undefined
  const state = value['state']
  switch (state) {
    case 'ready': {
      const ready = readyOf(value)
      return ready === undefined ? undefined : { state: 'ready', ...ready }
    }
    case 'not-configured':
    case 'unauthorized':
      return { state }
    case 'rate-limited':
    case 'upstream-error':
    case 'invalid-data': {
      const retryAfterMs = num(value['retryAfterMs'])
      if (retryAfterMs === undefined) return undefined
      const staleRaw = value['stale']
      const stale = staleRaw === undefined ? undefined : readyOf(staleRaw)
      if (staleRaw !== undefined && stale === undefined) return undefined
      return { state, retryAfterMs, ...stale === undefined ? {} : { stale } }
    }
    default:
      return undefined
  }
}

/**
 * Validate a `config` route body.
 * @param value - parsed JSON of unknown shape.
 * @returns the typed config, or `undefined` when unrecognizable.
 */
export function parseConfigView(value: unknown): ConfigView | undefined {
  if (!isRecord(value)) return undefined
  const { configured, providers, providerPattern, display } = value
  if (typeof configured !== 'boolean' || !Array.isArray(providers) || typeof providerPattern !== 'string') return undefined
  if (!providers.every((entry): entry is string => typeof entry === 'string')) return undefined
  const mode = ZENMUX_DISPLAY_MODES.find(candidate => candidate === display)
  if (mode === undefined) return undefined
  return { configured, providers, providerPattern, display: mode }
}
