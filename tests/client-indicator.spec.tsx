/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ZenMuxQuotaIndicator } from '../src/client/ZenMuxQuotaIndicator.tsx'
import type { QuotaSnapshot, StoreState, ZenMuxQuotaStore } from '../src/client/quota-store.ts'
import type { ConfigView } from '../src/client/route-adapter.ts'
import { en } from '../src/client/locales.ts'
import type { ZenMuxQuotaKey } from '../src/client/locales.ts'
import { subscriptionDto, windowDto } from './fixtures.ts'

afterEach(() => { cleanup() })

const t = (key: ZenMuxQuotaKey, params?: Record<string, unknown>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function directoryStub(provider: string | undefined, status: ModelDirectoryState['status'] = 'ready'): SnapshotStore<ModelDirectoryState> {
  const state: ModelDirectoryState = {
    current: provider === undefined ? null : { provider, model: 'm' },
    routable: true,
    groups: [],
    failures: [],
    pending: null,
    status,
    error: null,
  } as unknown as ModelDirectoryState
  return { getSnapshot: () => state, subscribe: () => () => {}, set: () => {}, update: () => state } as unknown as SnapshotStore<ModelDirectoryState>
}

type StubStore = ZenMuxQuotaStore & {
  ensureConfig: ReturnType<typeof vi.fn>
  retain: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

const CONFIG: ConfigView = { configured: true, providers: [], providerPattern: '^zenmux', display: 'binding' }

function quotaStub(quota: QuotaSnapshot, configArg: ConfigView | null = CONFIG): StubStore {
  const config = configArg ?? undefined
  const state: StoreState = { configStatus: config === undefined ? 'loading' : 'ready', ...config === undefined ? {} : { config }, quota }
  const release = vi.fn()
  return {
    subscribe: () => () => {},
    getSnapshot: () => state,
    ensureConfig: vi.fn(),
    retain: vi.fn(() => release),
    release,
    refresh: vi.fn(),
    dispose: () => {},
  } as unknown as StubStore
}

function ready(extra: Parameters<typeof subscriptionDto>[0] = {}, snapshot: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return { state: 'ready', data: subscriptionDto(extra), fetchedAt: Date.now() - 12_000, receivedAtMs: Date.now(), ...snapshot }
}

function mount(provider: string | undefined, quota: ZenMuxQuotaStore, status: ModelDirectoryState['status'] = 'ready') {
  return render(<ZenMuxQuotaIndicator directory={directoryStub(provider, status)} quota={quota} t={t} />)
}

const root = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-zenmux-quota]')

describe('ZenMuxQuotaIndicator gating', () => {
  it('renders nothing and keeps the store idle for a non-ZenMux provider', () => {
    const quota = quotaStub(ready())
    const { container } = mount('openai-codex', quota)
    expect(root(container)).toBeNull()
    expect(quota.retain).not.toHaveBeenCalled()
  })

  it('asks for the config but renders nothing until it is known', () => {
    const quota = quotaStub(ready(), null)
    const { container } = mount('zenmux-anthropic', quota)
    expect(quota.ensureConfig).toHaveBeenCalled()
    expect(root(container)).toBeNull()
    expect(quota.retain).not.toHaveBeenCalled()
  })

  it('does nothing while the directory has no selection', () => {
    const quota = quotaStub(ready())
    const { container } = mount(undefined, quota, 'loading')
    expect(root(container)).toBeNull()
    expect(quota.ensureConfig).not.toHaveBeenCalled()
    expect(quota.retain).not.toHaveBeenCalled()
  })

  it('retains while a ZenMux model is selected and releases on unmount', async () => {
    const quota = quotaStub(ready())
    const view = mount('zenmux-anthropic', quota)
    await waitFor(() => { expect(quota.retain).toHaveBeenCalledTimes(1) })
    view.unmount()
    expect(quota.release).toHaveBeenCalledTimes(1)
  })

  it('stays visible while a model switch is in flight', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready()), 'selecting')
    expect(root(container)).not.toBeNull()
  })

  it('honours an explicit provider list over the pattern', () => {
    const config: ConfigView = { ...CONFIG, providers: ['zenmux-openai'] }
    expect(root(mount('zenmux-anthropic', quotaStub(ready(), config)).container)).toBeNull()
    cleanup()
    expect(root(mount('zenmux-openai', quotaStub(ready(), config)).container)).not.toBeNull()
  })
})

describe('ZenMuxQuotaIndicator bar', () => {
  it('draws a 48x6 bar with a named color and an accessible sentence', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({
      fiveHour: windowDto(742.8, 800),
      sevenDay: windowDto(5765.89, 6182),
    })))
    const control = container.querySelector('[role="status"]') as HTMLElement
    expect(control.getAttribute('aria-label')).toContain('ZenMux Ultra')
    expect(control.getAttribute('aria-label')).toContain('5-hour window: 92.9% left (742.8 / 800 Flows)')
    expect(control.getAttribute('aria-label')).toContain('7-day window: 93.3% left')
    const progress = container.querySelector('[data-zenmux-quota-progress]') as HTMLElement
    expect(progress.getAttribute('data-zenmux-quota-color')).toBe('green')
    expect(progress.style.width).toBe('92.85%')
    expect(root(container)?.getAttribute('data-zenmux-quota')).toBe('five-hour')
  })

  it('leads with the tighter window and colors by it', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({
      fiveHour: windowDto(700, 800),
      sevenDay: windowDto(1000, 6000),
    })))
    expect(root(container)?.getAttribute('data-zenmux-quota')).toBe('weekly')
    expect(container.querySelector('[data-zenmux-quota-progress]')?.getAttribute('data-zenmux-quota-color')).toBe('red')
  })

  it('draws two thin bars in dual mode', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready(), { ...CONFIG, display: 'dual' }))
    expect(container.querySelectorAll('[data-zenmux-quota-track]')).toHaveLength(2)
  })

  it('marks a monitored account with a dot and names it in the label', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({ accountStatus: 'monitored' })))
    expect(container.querySelector('[data-zenmux-quota-dot="warn"]')).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain(en.statusMonitored)
  })

  it('greys the bar out for a banned account instead of showing it as healthy', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({ accountStatus: 'banned' })))
    const progress = container.querySelector('[data-zenmux-quota-progress]') as HTMLElement
    expect(progress.style.backgroundColor).toContain('--dsw-alias-label-dimmed')
    expect(container.querySelector('[data-zenmux-quota-dot="error"]')).not.toBeNull()
  })

  it('says so when the value is a stale fallback', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({}, { state: 'rate-limited', stale: true })))
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain(en.rateLimited.replace('{brand}', 'ZenMux'))
    expect(root(container)?.getAttribute('data-zenmux-quota-state')).toBe('rate-limited')
  })

  it('renders hostile account text as plain text', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const { container } = mount('zenmux-anthropic', quotaStub(ready({ accountStatus: 'unknown', rawAccountStatus: hostile })))
    fireEvent.click(container.querySelector('[role="status"]') as HTMLElement)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-zenmux-quota-account]')?.textContent).toContain(hostile)
  })

  it('keeps the old reading after a passed reset and marks it as pending, never a fake full bar', () => {
    const past = Date.now() - 60_000
    const { container } = mount('zenmux-anthropic', quotaStub(ready({
      fiveHour: windowDto(80, 800, { resetsAt: past }),
      sevenDay: windowDto(5000, 6000),
    })))
    const label = container.querySelector('[role="status"]')?.getAttribute('aria-label') ?? ''
    expect(label).toContain('5-hour window: 10% left (80 / 800 Flows)')
    expect(label).toContain(en.windowResetPending)
    expect(root(container)?.getAttribute('data-zenmux-quota-pending')).toBe('reset')
    expect(container.querySelector('[data-zenmux-quota-progress]')?.getAttribute('data-zenmux-quota-color')).toBe('red')
    fireEvent.click(container.querySelector('[role="status"]') as HTMLElement)
    expect(container.querySelector('[data-zenmux-quota-window="five-hour"]')?.textContent).toContain(en.windowResetPending)
  })
})

describe('ZenMuxQuotaIndicator non-value states', () => {
  const text = (container: HTMLElement): string => container.querySelector('[data-zenmux-quota-text]')?.textContent ?? ''
  const cases: [string, QuotaSnapshot, string][] = [
    ['loading', { state: 'loading' }, 'ZM ···'],
    ['not-configured', { state: 'not-configured' }, 'ZM ⚙'],
    ['unauthorized', { state: 'unauthorized' }, 'ZM !'],
    ['upstream-error without data', { state: 'upstream-error' }, 'ZM —'],
    ['rate-limited without data', { state: 'rate-limited' }, 'ZM —'],
    ['invalid-data', { state: 'invalid-data' }, 'ZM —'],
    ['forbidden', { state: 'forbidden' }, 'ZM —'],
  ]
  it.each(cases)('shows a neutral placeholder for %s and never a bar', (_name, snapshot, expected) => {
    const { container } = mount('zenmux-anthropic', quotaStub(snapshot))
    expect(text(container)).toBe(expected)
    expect(container.querySelector('[data-zenmux-quota-progress]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).not.toBe('')
  })

  it('hides when the host routes are missing', () => {
    expect(root(mount('zenmux-anthropic', quotaStub({ state: 'route-missing' })).container)).toBeNull()
  })

  it('shows zero capacity as text, not as an empty red bar', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({ fiveHour: windowDto(0, 0), sevenDay: windowDto(0, 0) })))
    expect(container.querySelector('[data-zenmux-quota-progress]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('no subscription quota')
  })
})

describe('ZenMuxQuotaIndicator interaction', () => {
  it('shows the tooltip on hover and focus and hides it again', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready()))
    const control = container.querySelector('[role="status"]') as HTMLElement
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
    fireEvent.mouseEnter(control)
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('ZenMux Ultra')
    fireEvent.mouseLeave(control)
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
    fireEvent.focus(control)
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull()
  })

  it('opens the detail dialog with both windows, the monthly cap and the console link', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready()))
    const control = container.querySelector('[role="status"]') as HTMLElement
    fireEvent.click(control)
    const detail = container.querySelector('[data-zenmux-quota-detail]') as HTMLElement
    expect(detail.getAttribute('role')).toBe('dialog')
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
    expect(detail.querySelectorAll('[data-zenmux-quota-window]')).toHaveLength(2)
    expect(detail.querySelector('[data-zenmux-quota-monthly]')?.textContent).toContain(en.monthlyNoRealtime)
    const link = detail.querySelector('a[data-zenmux-quota-console]') as HTMLAnchorElement
    expect(link.href).toBe('https://zenmux.ai/platform/subscription')
    expect(link.rel).toContain('noopener')
    expect(link.target).toBe('_blank')
    expect(control.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes the dialog on Escape and on an outside press, and opens from the keyboard', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready()))
    const control = container.querySelector('[role="status"]') as HTMLElement
    fireEvent.keyDown(control, { key: 'Enter' })
    expect(container.querySelector('[data-zenmux-quota-detail]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(container.querySelector('[data-zenmux-quota-detail]')).toBeNull()
    fireEvent.click(control)
    fireEvent.pointerDown(document.body)
    expect(container.querySelector('[data-zenmux-quota-detail]')).toBeNull()
  })

  it('calls refresh from the dialog and clears the busy look', async () => {
    const quota = quotaStub(ready())
    const { container } = mount('zenmux-anthropic', quota)
    fireEvent.click(container.querySelector('[role="status"]') as HTMLElement)
    const button = container.querySelector('[data-zenmux-quota-refresh]') as HTMLButtonElement
    fireEvent.click(button)
    expect(quota.refresh).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    await waitFor(() => { expect(button.disabled).toBe(false) }, { timeout: 4000 })
  })

  it('explains how to configure the key when it is missing', () => {
    const { container } = mount('zenmux-anthropic', quotaStub({ state: 'not-configured' }))
    fireEvent.click(container.querySelector('[role="status"]') as HTMLElement)
    const message = container.querySelector('[data-zenmux-quota-message]')?.textContent ?? ''
    expect(message).toContain('ZENMUX_MANAGEMENT_API_KEY')
  })

  it('flags a raised effective rate in the detail', () => {
    const { container } = mount('zenmux-anthropic', quotaStub(ready({ baseUsdPerFlow: 0.03, effectiveUsdPerFlow: 0.05 })))
    fireEvent.click(container.querySelector('[role="status"]') as HTMLElement)
    expect(container.querySelector('[data-zenmux-quota-rate-raised]')).not.toBeNull()
  })
})
