/**
 * Whitelist parser for `GET /api/v1/management/subscription/detail`.
 *
 * Input is always `unknown`. Every field is validated individually and only the
 * whitelisted DTO survives; the raw response is never retained or forwarded.
 *
 * @module dsh-zenmux-quota/parse
 */

/** One rolling quota window, validated. */
export interface QuotaWindowDTO {
  /** Consumed fraction as reported, `>= 0` (normally 0..1). */
  readonly usagePercentage: number
  /** Window reset time (epoch ms); `null` when the window has not started. */
  readonly resetsAt: number | null
  readonly maxFlows: number
  readonly usedFlows: number
  readonly remainingFlows: number
  readonly usedValueUsd: number
  readonly maxValueUsd: number
}

/** Known plan tiers; anything else is `unknown`. */
export type PlanTier = 'free' | 'pro' | 'max' | 'ultra' | 'unknown'
/** Known account statuses; anything else is `unknown`. */
export type AccountStatus = 'healthy' | 'monitored' | 'abusive' | 'suspended' | 'banned' | 'unknown'

/** Validated subscription answer. */
export interface SubscriptionDTO {
  readonly plan: {
    readonly tier: PlanTier
    readonly amountUsd?: number
    /** Subscription period expiry (epoch ms). Not a quota reset time. */
    readonly expiresAt?: number
  }
  readonly accountStatus: AccountStatus
  /** Raw status text, kept (truncated) only when `accountStatus` is `unknown`. */
  readonly rawAccountStatus?: string
  readonly baseUsdPerFlow?: number
  readonly effectiveUsdPerFlow?: number
  readonly fiveHour?: QuotaWindowDTO
  readonly sevenDay?: QuotaWindowDTO
  /** Monthly upper limits only; the API reports no real-time monthly usage. */
  readonly monthly?: { readonly maxFlows: number; readonly maxValueUsd: number }
}

const TIERS: readonly PlanTier[] = ['free', 'pro', 'max', 'ultra']
const STATUSES: readonly AccountStatus[] = ['healthy', 'monitored', 'abusive', 'suspended', 'banned']
const RAW_STATUS_MAX = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite, non-negative number; strings, null, NaN and negatives are rejected. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** ISO 8601 string to epoch ms; `undefined` when absent or unparsable. */
function isoToMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function parseWindow(value: unknown): QuotaWindowDTO | undefined {
  if (!isRecord(value)) return undefined
  const usagePercentage = num(value['usage_percentage'])
  const maxFlows = num(value['max_flows'])
  const usedFlows = num(value['used_flows'])
  const remainingFlows = num(value['remaining_flows'])
  const usedValueUsd = num(value['used_value_usd'])
  const maxValueUsd = num(value['max_value_usd'])
  if (
    usagePercentage === undefined || maxFlows === undefined || usedFlows === undefined
    || remainingFlows === undefined || usedValueUsd === undefined || maxValueUsd === undefined
  ) return undefined
  const rawReset = value['resets_at']
  let resetsAt: number | null
  if (rawReset === null) {
    resetsAt = null
  } else {
    const ms = isoToMs(rawReset)
    // A malformed or absent reset time invalidates the window instead of being
    // read as "not started", which would display a misleading full bar.
    if (ms === undefined) return undefined
    resetsAt = ms
  }
  return { usagePercentage, resetsAt, maxFlows, usedFlows, remainingFlows, usedValueUsd, maxValueUsd }
}

/**
 * Validate one upstream response body.
 *
 * @param value - parsed JSON of unknown shape.
 * @returns the whitelisted DTO, or `undefined` when the body is unusable
 * (`success !== true`, no `data`, or neither rolling window valid).
 */
export function parseSubscriptionDetail(value: unknown): SubscriptionDTO | undefined {
  if (!isRecord(value) || value['success'] !== true) return undefined
  const data = value['data']
  if (!isRecord(data)) return undefined

  const fiveHour = parseWindow(data['quota_5_hour'])
  const sevenDay = parseWindow(data['quota_7_day'])
  if (fiveHour === undefined && sevenDay === undefined) return undefined

  const plan = isRecord(data['plan']) ? data['plan'] : {}
  const tierRaw = plan['tier']
  const tier: PlanTier = TIERS.find(candidate => candidate === tierRaw) ?? 'unknown'
  const amountUsd = num(plan['amount_usd'])
  const expiresAt = isoToMs(plan['expires_at'])

  const statusRaw = data['account_status']
  const knownStatus = STATUSES.find(candidate => candidate === statusRaw)
  const accountStatus: AccountStatus = knownStatus ?? 'unknown'
  const rawAccountStatus = knownStatus === undefined && typeof statusRaw === 'string'
    ? statusRaw.slice(0, RAW_STATUS_MAX)
    : undefined

  const baseUsdPerFlow = num(data['base_usd_per_flow'])
  const effectiveUsdPerFlow = num(data['effective_usd_per_flow'])

  const monthlyRaw = data['quota_monthly']
  let monthly: SubscriptionDTO['monthly']
  if (isRecord(monthlyRaw)) {
    const maxFlows = num(monthlyRaw['max_flows'])
    const maxValueUsd = num(monthlyRaw['max_value_usd'])
    if (maxFlows !== undefined && maxValueUsd !== undefined) monthly = { maxFlows, maxValueUsd }
  }

  return {
    plan: {
      tier,
      ...amountUsd === undefined ? {} : { amountUsd },
      ...expiresAt === undefined ? {} : { expiresAt },
    },
    accountStatus,
    ...rawAccountStatus === undefined ? {} : { rawAccountStatus },
    ...baseUsdPerFlow === undefined ? {} : { baseUsdPerFlow },
    ...effectiveUsdPerFlow === undefined ? {} : { effectiveUsdPerFlow },
    ...fiveHour === undefined ? {} : { fiveHour },
    ...sevenDay === undefined ? {} : { sevenDay },
    ...monthly === undefined ? {} : { monthly },
  }
}
