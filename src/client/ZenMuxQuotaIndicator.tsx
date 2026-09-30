/**
 * Compact ZenMux subscription-quota indicator for the composer tool row.
 *
 * Placement and geometry mirror the Codex quota indicator in
 * `conversation.input.right`. Semantics differ on purpose: ZenMux enforces a
 * 5-hour and a 7-day rolling window at the same time, so the bar leads with the
 * tighter one, and the monthly cap (which has no live usage) is only listed in
 * the detail popover.
 *
 * Two surfaces: a hover/focus tooltip that only reports, and a click-opened
 * popover that carries the actions (Refresh, Open console).
 *
 * @module dsh-zenmux-quota/client/ZenMuxQuotaIndicator
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PlanTier, SubscriptionDTO } from '../parse.ts'
import { ZENMUX_CONSOLE_URL } from '../paths.ts'
import type { ZenMuxQuotaKey } from './locales.ts'
import type { QuotaSnapshot, ZenMuxQuotaStore } from './quota-store.ts'
import {
  QUOTA_CONTAINER_HEIGHT_PX,
  QUOTA_PROGRESS_TRACK_HEIGHT_PX,
  QUOTA_PROGRESS_WIDTH_PX,
  formatDate,
  formatFlows,
  formatPercent,
  formatRate,
  formatRelative,
  formatUsd,
  isBlockedStatus,
  isRateRaised,
  matchesProvider,
  quotaColor,
  selectLeadingWindow,
  statusSeverity,
} from './quota-view.ts'
import type { Leading, StatusSeverity, WindowView } from './quota-view.ts'

/** Translate function bound to this plugin's dictionary. */
type Translate = (key: ZenMuxQuotaKey, params?: Record<string, unknown>) => string

/** Props injected by the slot registration. */
export interface ZenMuxQuotaIndicatorInjected {
  /** Session-scoped model directory shared with the model selector. */
  readonly directory: SnapshotStore<ModelDirectoryState>
  /** Page-wide quota store shared by every mounted indicator. */
  readonly quota: ZenMuxQuotaStore
}

type PlaceholderKind =
  | 'not-configured'
  | 'unauthorized'
  | 'rate-limited'
  | 'upstream-error'
  | 'invalid-data'
  | 'forbidden'
  | 'zero-capacity'
  | 'no-window'

type Presentation =
  | { readonly kind: 'hide' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'placeholder'; readonly reason: PlaceholderKind }
  | { readonly kind: 'bar'; readonly leading: Extract<Leading, { available: true }>; readonly data: SubscriptionDTO }

/** Neutral color for every non-value state; errors never masquerade as 0%. */
const NEUTRAL_COLOR = 'var(--dsw-alias-label-dimmed, #9aa0a6)'
const DOT_COLORS: Readonly<Record<Exclude<StatusSeverity, 'none'>, string>> = {
  warn: 'var(--dsw-alias-state-warn-primary, #eab308)',
  error: 'var(--dsw-alias-state-error-primary, #ef4444)',
  neutral: NEUTRAL_COLOR,
}
const TICK_MS = 30_000
const REFRESH_FALLBACK_MS = 2_500

function planLabel(t: Translate, tier: PlanTier): string {
  switch (tier) {
    case 'free': return t('planFree')
    case 'pro': return t('planPro')
    case 'max': return t('planMax')
    case 'ultra': return t('planUltra')
    case 'unknown': return t('planUnknown')
  }
}

function periodLabel(t: Translate, window: WindowView): string {
  return window.kind === 'five-hour' ? t('windowFiveHour') : t('windowWeekly')
}

function presentationOf(snapshot: QuotaSnapshot, display: Parameters<typeof selectLeadingWindow>[1], nowMs: number): Presentation {
  const { state, data } = snapshot
  if (state === 'idle' || state === 'loading') return { kind: 'loading' }
  if (state === 'route-missing') return { kind: 'hide' }
  if (state === 'forbidden' || state === 'not-configured' || state === 'unauthorized') {
    return { kind: 'placeholder', reason: state }
  }
  if (data === undefined) {
    return { kind: 'placeholder', reason: state === 'ready' ? 'invalid-data' : state }
  }
  const leading = selectLeadingWindow(data, display, nowMs)
  if (!leading.available) return { kind: 'placeholder', reason: leading.reason }
  return { kind: 'bar', leading, data }
}

function placeholderText(reason: PlaceholderKind, t: Translate): string {
  const brand = t('brand')
  switch (reason) {
    case 'not-configured': return t('notConfigured', { brand })
    case 'unauthorized': return t('unauthorized', { brand })
    case 'rate-limited': return t('rateLimited', { brand })
    case 'upstream-error': return t('upstreamError', { brand })
    case 'invalid-data': return t('invalidData', { brand })
    case 'forbidden': return t('forbidden', { brand })
    case 'zero-capacity': return t('zeroCapacity', { brand })
    case 'no-window': return t('noWindow', { brand })
  }
}

function shortText(view: Presentation, t: Translate): string {
  const brand = t('brandShort')
  if (view.kind === 'loading') return `${brand} ${t('loadingShort')}`
  if (view.kind === 'placeholder') {
    if (view.reason === 'not-configured') return `${brand} ⚙`
    if (view.reason === 'unauthorized') return `${brand} !`
    return `${brand} ${t('unavailableShort')}`
  }
  return brand
}

function resetText(window: WindowView, nowMs: number, t: Translate): string {
  if (window.notStarted) return t('windowNotStarted')
  if (window.resetElapsed) return t('windowResetPending')
  return t('resetIn', { time: formatRelative(window.resetsAt ?? nowMs, nowMs) })
}

function statusText(data: SubscriptionDTO, t: Translate): string | undefined {
  switch (data.accountStatus) {
    case 'healthy': return undefined
    case 'monitored': return t('statusMonitored')
    case 'abusive': return t('statusAbusive')
    case 'suspended': return t('statusSuspended')
    case 'banned': return t('statusBanned')
    case 'unknown': return t('statusUnknown', { status: data.rawAccountStatus ?? '?' })
  }
}

/** The one-sentence accessible and hover summary of a bar. */
function barSummary(view: Extract<Presentation, { kind: 'bar' }>, snapshot: QuotaSnapshot, nowMs: number, t: Translate): string {
  const { leading, data } = view
  const window = leading.window
  const parts = [
    t('summaryHead', { brand: t('brand'), plan: planLabel(t, data.plan.tier) }),
    t('summaryWindow', {
      period: periodLabel(t, window),
      percent: formatPercent(window.remainingPercent),
      remaining: formatFlows(window.remainingFlows),
      max: formatFlows(window.maxFlows),
    }),
    resetText(window, nowMs, t),
  ]
  if (leading.other !== undefined) {
    parts.push(t('summaryOther', { period: periodLabel(t, leading.other), percent: formatPercent(leading.other.remainingPercent) }))
  }
  const status = statusText(data, t)
  if (status !== undefined) parts.push(status)
  if (snapshot.stale === true) {
    parts.push(snapshot.state === 'rate-limited' ? t('rateLimited', { brand: t('brand') }) : t('staleNote'))
  }
  return parts.join(' · ')
}

function Track(
  { percent, height, colorOverride, attr }: { percent: number; height: number; colorOverride?: string; attr?: string },
): JSX.Element {
  const color = quotaColor(percent)
  return (
    <span
      aria-hidden="true"
      data-zenmux-quota-track={attr ?? ''}
      style={{ display: 'block', width: '100%', height, borderRadius: '999px', backgroundColor: 'var(--dsw-alias-border-l2)', overflow: 'hidden' }}
    >
      <span
        aria-hidden="true"
        data-zenmux-quota-progress={attr ?? ''}
        data-zenmux-quota-color={color.name}
        style={{
          display: 'block',
          width: `${Math.min(100, Math.max(0, percent))}%`,
          height: '100%',
          borderRadius: 'inherit',
          backgroundColor: colorOverride ?? color.value,
        }}
      />
    </span>
  )
}

function WindowRow({ window, nowMs, t }: { window: WindowView; nowMs: number; t: Translate }): JSX.Element {
  return (
    <span data-zenmux-quota-window={window.kind} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontWeight: 600 }}>{periodLabel(t, window)}</span>
      <Track percent={window.remainingPercent} height={QUOTA_PROGRESS_TRACK_HEIGHT_PX} />
      <span>
        {t('detailRemaining', {
          percent: formatPercent(window.remainingPercent),
          remaining: formatFlows(window.remainingFlows),
          max: formatFlows(window.maxFlows),
          remainingUsd: formatUsd(Math.max(0, window.maxValueUsd - window.usedValueUsd)),
          maxUsd: formatUsd(window.maxValueUsd),
        })}
      </span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{resetText(window, nowMs, t)}</span>
    </span>
  )
}

/** The compact indicator. Renders nothing outside a ZenMux provider. */
export function ZenMuxQuotaIndicator({ directory, quota, t }: ZenMuxQuotaIndicatorInjected & { t: Translate }): JSX.Element | null {
  const directoryState = useSyncExternalStore(
    useCallback((listener: () => void) => directory.subscribe(listener), [directory]),
    useCallback(() => directory.getSnapshot(), [directory]),
    useCallback(() => directory.getSnapshot(), [directory]),
  )
  // A switch in flight (`selecting`) or a reload keeps the previous selection, so
  // the bar does not flicker away and back while the user changes model.
  const usable = directoryState.status === 'ready' || directoryState.status === 'selecting' || directoryState.status === 'loading'
  const provider = usable ? directoryState.current?.provider ?? undefined : undefined

  const store = useSyncExternalStore(quota.subscribe, quota.getSnapshot, quota.getSnapshot)

  useEffect(() => {
    if (provider !== undefined) quota.ensureConfig()
  }, [quota, provider])

  const config = store.config
  const matched = config !== undefined && matchesProvider(provider, config)
  useEffect(() => {
    if (!matched) return
    return quota.retain()
  }, [quota, matched])

  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [, setTick] = useState(0)
  const refreshBaseRef = useRef<QuotaSnapshot | undefined>(undefined)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const tooltipId = useId()
  const detailId = useId()
  const tooltipVisible = hovered || focused

  // Relative times ("resets in 2 hours") only need re-rendering while visible.
  useEffect(() => {
    if (!tooltipVisible && !expanded) return
    const timer = window.setInterval(() => { setTick(tick => tick + 1) }, TICK_MS)
    return () => { window.clearInterval(timer) }
  }, [tooltipVisible, expanded])

  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setExpanded(false)
      }
    }
    const onPointerDown = (event: Event): void => {
      const node = rootRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      setExpanded(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [expanded])

  useEffect(() => { if (!matched) setExpanded(false) }, [matched])

  // Clear the in-flight look when a newer snapshot arrives, or after a short
  // fallback: the store silently ignores a refresh inside its throttle window.
  useEffect(() => {
    if (!refreshing) return
    if (store.quota !== refreshBaseRef.current) {
      setRefreshing(false)
      return
    }
    const timer = window.setTimeout(() => { setRefreshing(false) }, REFRESH_FALLBACK_MS)
    return () => { window.clearTimeout(timer) }
  }, [refreshing, store.quota])

  if (!matched || config === undefined) return null
  const nowMs = Date.now()
  const snapshot = store.quota
  const view = presentationOf(snapshot, config.display, nowMs)
  if (view.kind === 'hide') return null

  const brand = t('brand')
  const label = view.kind === 'loading'
    ? t('loading', { brand })
    : view.kind === 'placeholder'
      ? placeholderText(view.reason, t)
      : barSummary(view, snapshot, nowMs, t)

  const leading = view.kind === 'bar' ? view.leading : undefined
  const dual = leading !== undefined && config.display === 'dual' && leading.fiveHour !== undefined && leading.sevenDay !== undefined
  const blocked = view.kind === 'bar' && isBlockedStatus(view.data.accountStatus)
  const severity: StatusSeverity = view.kind === 'bar' ? statusSeverity(view.data.accountStatus) : 'none'

  const onRefresh = (): void => {
    refreshBaseRef.current = snapshot
    setRefreshing(true)
    quota.refresh()
  }

  return (
    <span
      ref={rootRef}
      data-zenmux-quota={leading?.window.kind ?? 'placeholder'}
      data-zenmux-quota-state={snapshot.state}
      data-zenmux-quota-status={view.kind === 'bar' ? view.data.accountStatus : 'none'}
      data-zenmux-quota-pending={leading?.window.resetElapsed === true ? 'reset' : undefined}
      style={{ display: 'inline-flex', position: 'relative', alignItems: 'center' }}
    >
      <span
        role="status"
        aria-label={label}
        aria-describedby={tooltipVisible && !expanded ? tooltipId : undefined}
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        tabIndex={0}
        data-zenmux-quota-control=""
        onClick={() => { setExpanded(open => !open) }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(open => !open)
          }
        }}
        onMouseEnter={() => { setHovered(true) }}
        onMouseLeave={() => { setHovered(false) }}
        onFocus={() => { setFocused(true) }}
        onBlur={() => { setFocused(false) }}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: `${QUOTA_CONTAINER_HEIGHT_PX}px`,
          padding: leading === undefined ? '0 6px' : '0 2px',
          border: 0,
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '18px',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}
      >
        {leading === undefined ? (
          <span aria-hidden="true" data-zenmux-quota-text="" style={{ color: NEUTRAL_COLOR }}>
            {shortText(view, t)}
          </span>
        ) : dual ? (
          <span
            aria-hidden="true"
            style={{ display: 'flex', flexDirection: 'column', gap: 2, width: `${QUOTA_PROGRESS_WIDTH_PX}px`, opacity: blocked ? 0.5 : 1 }}
          >
            <Track percent={(leading.fiveHour as WindowView).remainingPercent} height={2} attr="five-hour" />
            <Track percent={(leading.sevenDay as WindowView).remainingPercent} height={2} attr="weekly" />
          </span>
        ) : (
          <span aria-hidden="true" style={{ display: 'block', width: `${QUOTA_PROGRESS_WIDTH_PX}px`, opacity: blocked ? 0.5 : 1 }}>
            <Track
              percent={leading.window.remainingPercent}
              height={QUOTA_PROGRESS_TRACK_HEIGHT_PX}
              attr={leading.window.kind}
              {...blocked ? { colorOverride: NEUTRAL_COLOR } : {}}
            />
          </span>
        )}
        {severity === 'none' ? null : (
          <span
            aria-hidden="true"
            data-zenmux-quota-dot={severity}
            style={{
              position: 'absolute',
              top: 3,
              right: 0,
              width: 4,
              height: 4,
              borderRadius: '50%',
              backgroundColor: DOT_COLORS[severity],
            }}
          />
        )}
      </span>

      {tooltipVisible && !expanded ? (
        <span
          id={tooltipId}
          role="tooltip"
          data-zenmux-quota-tooltip=""
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            maxWidth: 320,
            padding: '4px 8px',
            borderRadius: 6,
            backgroundColor: 'var(--dsw-specific-tip, #1f2329)',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgb(0 0 0 / 12%))',
            fontSize: 12,
            lineHeight: '18px',
            textAlign: 'center',
            whiteSpace: 'normal',
            pointerEvents: 'none',
          }}
        >{label}</span>
      ) : null}

      {expanded ? (
        <span
          id={detailId}
          role="dialog"
          aria-label={t('detailHeading')}
          data-zenmux-quota-detail=""
          style={{
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 8px)',
            zIndex: 1001,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: 300,
            maxWidth: '90vw',
            padding: '10px 12px',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgb(0 0 0 / 12%))',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'normal',
          }}
        >
          <span style={{ fontWeight: 600 }}>{t('detailHeading')}</span>
          {view.kind === 'bar' ? (
            <DetailBody view={view} snapshot={snapshot} nowMs={nowMs} t={t} />
          ) : (
            <span data-zenmux-quota-message="">
              {view.kind === 'loading' ? t('loading', { brand }) : placeholderText(view.reason, t)}
              {view.kind === 'placeholder' && view.reason === 'not-configured' ? ` ${t('notConfiguredHint')}` : ''}
            </span>
          )}
          <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            <a
              href={ZENMUX_CONSOLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-zenmux-quota-console=""
              style={{ color: 'var(--dsw-alias-label-secondary)', marginRight: 'auto' }}
            >{t('openConsole')} ↗</a>
            <button
              type="button"
              data-zenmux-quota-refresh=""
              disabled={refreshing || snapshot.state === 'loading'}
              onClick={onRefresh}
              style={{
                padding: '3px 10px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                cursor: refreshing ? 'default' : 'pointer',
              }}
            >{refreshing ? t('refreshing') : t('refresh')}</button>
          </span>
        </span>
      ) : null}
    </span>
  )
}

/** Detail popover body for a usable subscription. */
function DetailBody(
  { view, snapshot, nowMs, t }: { view: Extract<Presentation, { kind: 'bar' }>; snapshot: QuotaSnapshot; nowMs: number; t: Translate },
): JSX.Element {
  const { data, leading } = view
  const status = statusText(data, t)
  const windows = [leading.fiveHour, leading.sevenDay].filter((window): window is WindowView => window !== undefined)
  const plan = planLabel(t, data.plan.tier)
  return (
    <>
      <span data-zenmux-quota-plan="">
        {data.plan.amountUsd === undefined
          ? plan
          : t('detailPlan', { plan, price: formatUsd(data.plan.amountUsd) })}
        {data.plan.expiresAt === undefined ? '' : ` · ${t('detailExpires', { date: formatDate(data.plan.expiresAt) })}`}
      </span>
      <span data-zenmux-quota-account="" style={{ color: status === undefined ? undefined : 'var(--dsw-alias-state-warn-primary, #eab308)' }}>
        {t('statusLabel')}: {status ?? t('statusHealthy')}
      </span>
      {isBlockedStatus(data.accountStatus) ? <span>{t('blockedNote')}</span> : null}
      {snapshot.stale === true ? (
        <span data-zenmux-quota-stale="">
          {snapshot.state === 'rate-limited' ? t('rateLimited', { brand: t('brand') }) : t('staleNote')}
        </span>
      ) : null}
      {windows.map(window => <WindowRow key={window.kind} window={window} nowMs={nowMs} t={t} />)}
      {data.monthly === undefined ? null : (
        <span data-zenmux-quota-monthly="">
          {t('monthlyCap')}: {formatFlows(data.monthly.maxFlows)} Flows ({formatUsd(data.monthly.maxValueUsd)}) — {t('monthlyNoRealtime')}
        </span>
      )}
      {isRateRaised(data) ? (
        <span data-zenmux-quota-rate-raised="" style={{ color: 'var(--dsw-alias-state-warn-primary, #eab308)' }}>
          {t('rateRaised', { effective: formatRate(data.effectiveUsdPerFlow ?? 0), base: formatRate(data.baseUsdPerFlow ?? 0) })}
        </span>
      ) : data.effectiveUsdPerFlow === undefined ? null : (
        <span>{t('rate', { rate: formatRate(data.effectiveUsdPerFlow) })}</span>
      )}
      {snapshot.receivedAtMs === undefined ? null : (
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {t('detailUpdated', { time: formatRelative(snapshot.fetchedAt ?? snapshot.receivedAtMs, nowMs) })}
        </span>
      )}
    </>
  )
}
