import { describe, expect, it } from 'vitest'
import { parseSubscriptionDetail } from '../src/parse.ts'
import { rawDetail } from './fixtures.ts'

function withData(patch: Record<string, unknown>): unknown {
  return rawDetail(patch)
}

describe('parseSubscriptionDetail', () => {
  it('accepts the documented example unchanged', () => {
    const dto = parseSubscriptionDetail(rawDetail())
    expect(dto).toBeDefined()
    expect(dto?.plan).toEqual({ tier: 'ultra', amountUsd: 200, expiresAt: Date.parse('2026-04-12T08:26:56.000Z') })
    expect(dto?.accountStatus).toBe('healthy')
    expect(dto?.fiveHour?.remainingFlows).toBe(742.8)
    expect(dto?.fiveHour?.resetsAt).toBe(Date.parse('2026-03-24T08:35:09.000Z'))
    expect(dto?.sevenDay?.maxFlows).toBe(6182)
    expect(dto?.monthly).toEqual({ maxFlows: 34560, maxValueUsd: 1134.33 })
  })

  it('keeps only whitelisted fields', () => {
    const body = rawDetail({ secret: 'x', plan: { tier: 'pro', token: 'leak' } }) as { data: Record<string, unknown> }
    const dto = parseSubscriptionDetail(body) as unknown as Record<string, unknown>
    expect(JSON.stringify(dto)).not.toContain('leak')
    expect(JSON.stringify(dto)).not.toContain('secret')
  })

  it('stays ready when only one rolling window is valid', () => {
    const dto = parseSubscriptionDetail(withData({ quota_7_day: undefined }))
    expect(dto?.fiveHour).toBeDefined()
    expect(dto?.sevenDay).toBeUndefined()
    const other = parseSubscriptionDetail(withData({ quota_5_hour: 'nope' }))
    expect(other?.sevenDay).toBeDefined()
    expect(other?.fiveHour).toBeUndefined()
  })

  it('is invalid when neither rolling window is valid', () => {
    expect(parseSubscriptionDetail(withData({ quota_5_hour: undefined, quota_7_day: undefined }))).toBeUndefined()
  })

  it.each([
    ['string number', { max_flows: '800' }],
    ['negative', { remaining_flows: -1 }],
    ['NaN', { used_flows: Number.NaN }],
    ['null number', { max_value_usd: null }],
    ['invalid ISO', { resets_at: 'tomorrow' }],
    ['missing reset key', { resets_at: undefined }],
  ])('invalidates a window with a %s', (_name, patch) => {
    const base = (rawDetail() as { data: { quota_5_hour: Record<string, unknown> } }).data.quota_5_hour
    const dto = parseSubscriptionDetail(withData({ quota_5_hour: { ...base, ...patch } }))
    expect(dto?.fiveHour).toBeUndefined()
    expect(dto?.sevenDay).toBeDefined()
  })

  it('reads a null reset as "window not started"', () => {
    const base = (rawDetail() as { data: { quota_5_hour: Record<string, unknown> } }).data.quota_5_hour
    const dto = parseSubscriptionDetail(withData({ quota_5_hour: { ...base, resets_at: null } }))
    expect(dto?.fiveHour?.resetsAt).toBeNull()
  })

  it('degrades unknown tier and status instead of dropping the quota', () => {
    const dto = parseSubscriptionDetail(withData({ plan: { tier: 'galaxy' }, account_status: 'quarantined-for-a-very-long-time' }))
    expect(dto?.plan.tier).toBe('unknown')
    expect(dto?.accountStatus).toBe('unknown')
    expect(dto?.rawAccountStatus).toHaveLength(16)
    expect(dto?.fiveHour).toBeDefined()
  })

  it('omits an unusable monthly block without failing', () => {
    expect(parseSubscriptionDetail(withData({ quota_monthly: { max_flows: 'x' } }))?.monthly).toBeUndefined()
  })

  it('rejects success:false, missing data and non-objects', () => {
    expect(parseSubscriptionDetail({ success: false, data: {} })).toBeUndefined()
    expect(parseSubscriptionDetail({ success: true })).toBeUndefined()
    expect(parseSubscriptionDetail(null)).toBeUndefined()
    expect(parseSubscriptionDetail([])).toBeUndefined()
    expect(parseSubscriptionDetail('<html>')).toBeUndefined()
  })
})
