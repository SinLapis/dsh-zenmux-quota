/**
 * Pure presentation functions. The component performs no numeric work of its
 * own; everything testable lives here.
 *
 * @module dsh-zenmux-quota/client/quota-view
 */

import type { AccountStatus, QuotaWindowDTO, SubscriptionDTO } from '../parse.ts'
import type { ZenMuxDisplayMode } from '../paths.ts'
import type { ConfigView } from './route-adapter.ts'

/** Composer geometry shared with the Codex quota indicator. */
export const QUOTA_CONTAINER_HEIGHT_PX = 28
export const QUOTA_PROGRESS_WIDTH_PX = 48
export const QUOTA_PROGRESS_TRACK_HEIGHT_PX = 6

/** The two rolling windows the bar can lead with. */
export type WindowKind = 'five-hour' | 'weekly'

/** One window prepared for display. */
export interface WindowView {
  readonly kind: WindowKind
  /** Remaining share, 0..100. */
  readonly remainingPercent: number
  readonly remainingFlows: number
  readonly maxFlows: number
  readonly usedValueUsd: number
  readonly maxValueUsd: number
  /** Epoch ms; `null` when the window has not started. */
  readonly resetsAt: number | null
  /** The window has not started counting yet. */
  readonly notStarted: boolean
  /** The reset time has passed, so the reported usage may be out of date (refresh pending). */
  readonly resetElapsed: boolean
}

/** Refresh this long after a window's reset time, so the Host sees the new window. */
export const RESET_REFRESH_GRACE_MS = 2_000

/**
 * Delay until the earliest *future* window reset (plus a short grace), or
 * `undefined` when no window resets in the future.
 *
 * @param dto - validated subscription.
 * @param nowMs - current time.
 * @returns milliseconds from now.
 */
export function nextResetDelay(dto: SubscriptionDTO, nowMs: number): number | undefined {
  let earliest: number | undefined
  for (const window of [dto.fiveHour, dto.sevenDay]) {
    const at = window?.resetsAt
    if (at === null || at === undefined || at <= nowMs) continue
    if (earliest === undefined || at < earliest) earliest = at
  }
  return earliest === undefined ? undefined : earliest - nowMs + RESET_REFRESH_GRACE_MS
}

/** Outcome of choosing the leading window. */
export type Leading =
  | {
    readonly available: true
    readonly window: WindowView
    readonly other?: WindowView
    readonly fiveHour?: WindowView
    readonly sevenDay?: WindowView
    readonly reason: 'binding' | 'forced'
  }
  | { readonly available: false; readonly reason: 'no-window' | 'zero-capacity' }

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * Remaining share of one window.
 *
 * Flows are authoritative when they are internally consistent
 * (`used + remaining == max` within tolerance); otherwise the reported
 * `usage_percentage` is used. A window with no capacity has no share.
 *
 * @param window - validated window.
 * @returns the percentage 0..100, or `undefined` when capacity is zero.
 */
export function remainingPercentOf(window: QuotaWindowDTO): number | undefined {
  if (window.maxFlows <= 0) return undefined
  const tolerance = Math.max(0.01, window.maxFlows * 0.005)
  const consistent = Math.abs(window.usedFlows + window.remainingFlows - window.maxFlows) <= tolerance
  return clampPercent(consistent
    ? window.remainingFlows / window.maxFlows * 100
    : (1 - window.usagePercentage) * 100)
}

function viewOf(kind: WindowKind, window: QuotaWindowDTO | undefined, nowMs: number): WindowView | undefined {
  if (window === undefined) return undefined
  const measured = remainingPercentOf(window)
  if (measured === undefined) return undefined
  const notStarted = window.resetsAt === null
  const resetElapsed = window.resetsAt !== null && window.resetsAt <= nowMs
  // The reported figures are always shown as reported. For a rolling window,
  // `resets_at` passing does not prove the whole allowance came back (it may
  // only mark the oldest usage expiring), so an elapsed reset is flagged as
  // "pending refresh" and the store re-polls, instead of inventing a full bar.
  return {
    kind,
    remainingPercent: measured,
    remainingFlows: window.remainingFlows,
    maxFlows: window.maxFlows,
    usedValueUsd: window.usedValueUsd,
    maxValueUsd: window.maxValueUsd,
    resetsAt: window.resetsAt,
    notStarted,
    resetElapsed,
  }
}

/**
 * Choose which window the compact bar leads with.
 *
 * `binding` / `dual` lead with the tighter window (ties go to the 5-hour one).
 * A forced window that is missing returns `no-window`; the other window is never
 * substituted silently. The monthly quota never participates.
 *
 * @param dto - validated subscription.
 * @param display - configured display mode.
 * @param nowMs - current time.
 * @returns the leading selection.
 */
export function selectLeadingWindow(dto: SubscriptionDTO, display: ZenMuxDisplayMode, nowMs: number): Leading {
  const fiveHour = viewOf('five-hour', dto.fiveHour, nowMs)
  const sevenDay = viewOf('weekly', dto.sevenDay, nowMs)
  const reported = [dto.fiveHour, dto.sevenDay].filter((window): window is QuotaWindowDTO => window !== undefined)
  const zeroCapacity = reported.length > 0 && reported.every(window => window.maxFlows === 0)
  const summary = { ...fiveHour === undefined ? {} : { fiveHour }, ...sevenDay === undefined ? {} : { sevenDay } }

  if (display === 'five-hour' || display === 'weekly') {
    const forced = display === 'five-hour' ? fiveHour : sevenDay
    if (forced === undefined) {
      const raw = display === 'five-hour' ? dto.fiveHour : dto.sevenDay
      return { available: false, reason: raw !== undefined && raw.maxFlows === 0 ? 'zero-capacity' : 'no-window' }
    }
    const other = display === 'five-hour' ? sevenDay : fiveHour
    return { available: true, window: forced, ...other === undefined ? {} : { other }, ...summary, reason: 'forced' }
  }

  if (fiveHour === undefined && sevenDay === undefined) {
    return { available: false, reason: zeroCapacity ? 'zero-capacity' : 'no-window' }
  }
  if (fiveHour !== undefined && sevenDay !== undefined) {
    const tighter = sevenDay.remainingPercent < fiveHour.remainingPercent ? sevenDay : fiveHour
    const other = tighter === fiveHour ? sevenDay : fiveHour
    return { available: true, window: tighter, other, ...summary, reason: 'binding' }
  }
  const only = (fiveHour ?? sevenDay) as WindowView
  return { available: true, window: only, ...summary, reason: 'binding' }
}

/** Color band of a bar. */
export type QuotaColorName = 'green' | 'yellow' | 'orange' | 'red'

/**
 * Codex-compatible color bands by remaining share.
 * @param remainingPercent - 0..100.
 * @returns the band name and its CSS color.
 */
export function quotaColor(remainingPercent: number): { readonly name: QuotaColorName; readonly value: string } {
  const bounded = clampPercent(remainingPercent)
  if (bounded >= 60) return { name: 'green', value: 'var(--dsw-alias-state-success-primary, #22c55e)' }
  if (bounded >= 40) return { name: 'yellow', value: 'var(--dsw-alias-state-warn-primary, #eab308)' }
  if (bounded >= 20) return { name: 'orange', value: '#f97316' }
  return { name: 'red', value: 'var(--dsw-alias-state-error-primary, #ef4444)' }
}

/** Account-status marker severity. */
export type StatusSeverity = 'none' | 'warn' | 'error' | 'neutral'

/**
 * Marker for a non-healthy account.
 * @param status - validated account status.
 * @returns its severity; `none` for healthy.
 */
export function statusSeverity(status: AccountStatus): StatusSeverity {
  switch (status) {
    case 'healthy':
      return 'none'
    case 'monitored':
      return 'warn'
    case 'abusive':
    case 'suspended':
    case 'banned':
      return 'error'
    case 'unknown':
      return 'neutral'
  }
}

/** Whether the account cannot currently use the quota at all. */
export function isBlockedStatus(status: AccountStatus): boolean {
  return status === 'suspended' || status === 'banned'
}

/** Whether the effective per-Flow rate exceeds the base rate. */
export function isRateRaised(dto: SubscriptionDTO): boolean {
  return dto.baseUsdPerFlow !== undefined
    && dto.effectiveUsdPerFlow !== undefined
    && dto.effectiveUsdPerFlow > dto.baseUsdPerFlow + 1e-9
}

function decimal(value: number, digits: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value)
}

/** Flows with one decimal; tiny positive values read `<0.1`, never `0`. */
export function formatFlows(value: number): string {
  return value > 0 && value < 0.1 ? '<0.1' : decimal(value, 1)
}

/** Remaining share with one decimal. */
export function formatPercent(value: number): string {
  return decimal(clampPercent(value), 1)
}

/** USD with two decimals. */
export function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

/** Per-Flow rate, which needs more precision than money. */
export function formatRate(value: number): string {
  return `$${decimal(value, 5)}`
}

/** Local date and time for an absolute timestamp. */
export function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

/** Local date only. */
export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms))
}

/**
 * Localized relative time ("in 2 hours", "12 seconds ago").
 * @param targetMs - the moment described.
 * @param nowMs - the reference time.
 * @returns the phrase.
 */
export function formatRelative(targetMs: number, nowMs: number): string {
  const diffSeconds = (targetMs - nowMs) / 1000
  const abs = Math.abs(diffSeconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 45) return formatter.format(Math.round(diffSeconds), 'second')
  if (abs < 90 * 60) return formatter.format(Math.round(diffSeconds / 60), 'minute')
  if (abs < 36 * 3600) return formatter.format(Math.round(diffSeconds / 3600), 'hour')
  return formatter.format(Math.round(diffSeconds / 86_400), 'day')
}

const compiled = new Map<string, RegExp | null>()

/**
 * Whether a provider id belongs to ZenMux according to the Host's config.
 *
 * An explicit `providers` list wins; otherwise the case-insensitive pattern is
 * used. An invalid pattern matches nothing (and is only reported once).
 *
 * @param provider - the current selection's provider id.
 * @param config - the Host's config view.
 * @returns whether to show the ZenMux indicator.
 */
export function matchesProvider(provider: string | null | undefined, config: Pick<ConfigView, 'providers' | 'providerPattern'>): boolean {
  if (provider === null || provider === undefined || provider === '') return false
  if (config.providers.length > 0) return config.providers.includes(provider)
  let pattern = compiled.get(config.providerPattern)
  if (pattern === undefined) {
    try {
      pattern = new RegExp(config.providerPattern, 'i')
    } catch {
      pattern = null
      console.warn('[dsh-zenmux-quota] providerPattern is not a valid regular expression; no provider matches')
    }
    compiled.set(config.providerPattern, pattern)
  }
  return pattern !== null && pattern.test(provider)
}
