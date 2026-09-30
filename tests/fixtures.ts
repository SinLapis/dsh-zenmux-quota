/** Synthetic fixtures. Nothing here is a real account's data. */

import type { QuotaWindowDTO, SubscriptionDTO } from '../src/parse.ts'

/** Upstream body exactly as the ZenMux docs show it. */
export function rawDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    data: {
      plan: { tier: 'ultra', amount_usd: 200, interval: 'month', expires_at: '2026-04-12T08:26:56.000Z' },
      currency: 'usd',
      base_usd_per_flow: 0.03283,
      effective_usd_per_flow: 0.03283,
      account_status: 'healthy',
      quota_5_hour: {
        usage_percentage: 0.0715,
        resets_at: '2026-03-24T08:35:09.000Z',
        max_flows: 800,
        used_flows: 57.2,
        remaining_flows: 742.8,
        used_value_usd: 1.88,
        max_value_usd: 26.27,
      },
      quota_7_day: {
        usage_percentage: 0.0673,
        resets_at: '2026-03-26T02:15:05.000Z',
        max_flows: 6182,
        used_flows: 416.11,
        remaining_flows: 5765.89,
        used_value_usd: 13.66,
        max_value_usd: 202.99,
      },
      quota_monthly: { max_flows: 34560, max_value_usd: 1134.33 },
      ...overrides,
    },
  }
}

/** A validated window; `remaining` and `max` are Flows. */
export function windowDto(remaining: number, max: number, extra: Partial<QuotaWindowDTO> = {}): QuotaWindowDTO {
  const used = max - remaining
  return {
    usagePercentage: max === 0 ? 0 : used / max,
    resetsAt: Date.parse('2099-01-01T00:00:00Z'),
    maxFlows: max,
    usedFlows: used,
    remainingFlows: remaining,
    usedValueUsd: used * 0.03,
    maxValueUsd: max * 0.03,
    ...extra,
  }
}

/** A validated subscription. */
export function subscriptionDto(extra: Partial<SubscriptionDTO> = {}): SubscriptionDTO {
  return {
    plan: { tier: 'ultra', amountUsd: 200, expiresAt: Date.parse('2099-02-01T00:00:00Z') },
    accountStatus: 'healthy',
    baseUsdPerFlow: 0.03283,
    effectiveUsdPerFlow: 0.03283,
    fiveHour: windowDto(740, 800),
    sevenDay: windowDto(5700, 6182),
    monthly: { maxFlows: 34560, maxValueUsd: 1134.33 },
    ...extra,
  }
}

/** A `Response` carrying JSON. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}
