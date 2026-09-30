import { describe, expect, it } from 'vitest'
import {
  formatFlows,
  formatPercent,
  matchesProvider,
  nextResetDelay,
  quotaColor,
  RESET_REFRESH_GRACE_MS,
  remainingPercentOf,
  selectLeadingWindow,
  statusSeverity,
} from '../src/client/quota-view.ts'
import { subscriptionDto, windowDto } from './fixtures.ts'

const NOW = Date.parse('2030-01-01T00:00:00Z')
const FUTURE = Date.parse('2030-01-01T05:00:00Z')

describe('remainingPercentOf', () => {
  it('uses flows when they are consistent', () => {
    expect(remainingPercentOf(windowDto(742.8, 800))).toBeCloseTo(92.85, 2)
  })

  it('falls back to usage_percentage when flows contradict each other', () => {
    const broken = windowDto(100, 800, { usedFlows: 10, usagePercentage: 0.25 })
    expect(remainingPercentOf(broken)).toBeCloseTo(75, 5)
  })

  it('tolerates rounding noise in used + remaining', () => {
    expect(remainingPercentOf(windowDto(742.8, 800, { usedFlows: 57.21 }))).toBeCloseTo(92.85, 2)
  })

  it('has no share for a zero-capacity window and clamps absurd readings', () => {
    expect(remainingPercentOf(windowDto(0, 0))).toBeUndefined()
    expect(remainingPercentOf(windowDto(0, 10, { usedFlows: 0, usagePercentage: 5 }))).toBe(0)
  })
})

describe('selectLeadingWindow', () => {
  it('leads with the tighter window', () => {
    const dto = subscriptionDto({ fiveHour: windowDto(700, 800, { resetsAt: FUTURE }), sevenDay: windowDto(1000, 6000, { resetsAt: FUTURE }) })
    const leading = selectLeadingWindow(dto, 'binding', NOW)
    expect(leading).toMatchObject({ available: true, reason: 'binding', window: { kind: 'weekly' }, other: { kind: 'five-hour' } })
  })

  it('breaks a tie in favor of the 5-hour window', () => {
    const dto = subscriptionDto({ fiveHour: windowDto(50, 100, { resetsAt: FUTURE }), sevenDay: windowDto(500, 1000, { resetsAt: FUTURE }) })
    expect(selectLeadingWindow(dto, 'binding', NOW)).toMatchObject({ window: { kind: 'five-hour' } })
  })

  it('leads with the only valid window', () => {
    const dto = subscriptionDto({ fiveHour: windowDto(10, 100, { resetsAt: FUTURE }) })
    const { sevenDay: _omitted, ...rest } = dto
    void _omitted
    expect(selectLeadingWindow(rest, 'binding', NOW)).toMatchObject({ available: true, window: { kind: 'five-hour' } })
  })

  it('forces a window and never substitutes the other one', () => {
    const { fiveHour: _omitted, ...rest } = subscriptionDto()
    void _omitted
    expect(selectLeadingWindow(rest, 'five-hour', NOW)).toEqual({ available: false, reason: 'no-window' })
    expect(selectLeadingWindow(rest, 'weekly', NOW)).toMatchObject({ available: true, reason: 'forced', window: { kind: 'weekly' } })
  })

  it('reports zero capacity instead of a bar', () => {
    const dto = subscriptionDto({ fiveHour: windowDto(0, 0), sevenDay: windowDto(0, 0) })
    expect(selectLeadingWindow(dto, 'binding', NOW)).toEqual({ available: false, reason: 'zero-capacity' })
    expect(selectLeadingWindow(dto, 'five-hour', NOW)).toEqual({ available: false, reason: 'zero-capacity' })
  })

  it('flags a window that has not started but shows its figures as reported', () => {
    const dto = subscriptionDto({ fiveHour: windowDto(100, 100, { resetsAt: null }), sevenDay: windowDto(900, 1000, { resetsAt: FUTURE }) })
    const leading = selectLeadingWindow(dto, 'binding', NOW)
    expect(leading).toMatchObject({ available: true, fiveHour: { notStarted: true, remainingPercent: 100 } })
  })

  it('keeps the reported reading after a passed reset and only flags it as pending', () => {
    const dto = subscriptionDto({
      fiveHour: windowDto(5, 100, { resetsAt: NOW - 1000 }),
      sevenDay: windowDto(900, 1000, { resetsAt: FUTURE }),
    })
    const leading = selectLeadingWindow(dto, 'binding', NOW)
    expect(leading).toMatchObject({ available: true, fiveHour: { resetElapsed: true, remainingPercent: 5, remainingFlows: 5 } })
    // The stale low reading still competes for the bar: better too cautious than falsely full.
    if (leading.available) expect(leading.window.kind).toBe('five-hour')
  })

  it('never lets the monthly cap drive the bar', () => {
    const dto = subscriptionDto({ monthly: { maxFlows: 1, maxValueUsd: 1 } })
    expect(selectLeadingWindow(dto, 'binding', NOW)).toMatchObject({ available: true })
  })

  it('exposes both windows for the dual display', () => {
    const leading = selectLeadingWindow(subscriptionDto(), 'dual', NOW)
    expect(leading).toMatchObject({ available: true, fiveHour: { kind: 'five-hour' }, sevenDay: { kind: 'weekly' } })
  })
})

describe('nextResetDelay', () => {
  it('returns the earliest future reset plus the grace period', () => {
    const dto = subscriptionDto({
      fiveHour: windowDto(10, 100, { resetsAt: NOW + 30_000 }),
      sevenDay: windowDto(10, 100, { resetsAt: NOW + 10_000 }),
    })
    expect(nextResetDelay(dto, NOW)).toBe(10_000 + RESET_REFRESH_GRACE_MS)
  })

  it('ignores past and not-started windows', () => {
    const dto = subscriptionDto({
      fiveHour: windowDto(10, 100, { resetsAt: NOW - 1 }),
      sevenDay: windowDto(10, 100, { resetsAt: null }),
    })
    expect(nextResetDelay(dto, NOW)).toBeUndefined()
  })
})

describe('quotaColor', () => {
  it.each([
    [100, 'green'], [60, 'green'], [59.9, 'yellow'], [40, 'yellow'],
    [39.9, 'orange'], [20, 'orange'], [19.9, 'red'], [0, 'red'], [-5, 'red'], [140, 'green'],
  ])('%s%% is %s', (percent, name) => {
    expect(quotaColor(percent).name).toBe(name)
  })
})

describe('formatting and matching', () => {
  it('never renders a tiny positive Flow count as zero', () => {
    expect(formatFlows(0.04)).toBe('<0.1')
    expect(formatFlows(0)).toBe('0')
    expect(formatPercent(150)).toBe(formatPercent(100))
  })

  it('maps account statuses to marker severities', () => {
    expect(statusSeverity('healthy')).toBe('none')
    expect(statusSeverity('monitored')).toBe('warn')
    expect(statusSeverity('banned')).toBe('error')
    expect(statusSeverity('unknown')).toBe('neutral')
  })

  it('matches providers by exact list first, then by case-insensitive pattern', () => {
    const list = { providers: ['zenmux-anthropic'], providerPattern: '^nothing' }
    expect(matchesProvider('zenmux-anthropic', list)).toBe(true)
    expect(matchesProvider('zenmux-openai', list)).toBe(false)
    const pattern = { providers: [], providerPattern: '^zenmux' }
    expect(matchesProvider('ZenMux-OpenAI', pattern)).toBe(true)
    expect(matchesProvider('openai-codex', pattern)).toBe(false)
    expect(matchesProvider(undefined, pattern)).toBe(false)
    expect(matchesProvider(null, pattern)).toBe(false)
  })

  it('treats an invalid pattern as matching nothing', () => {
    expect(matchesProvider('zenmux', { providers: [], providerPattern: '(' })).toBe(false)
  })
})
