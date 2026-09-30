import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, apply, name } from '../src/index.ts'
import { ZENMUX_QUOTA_CONFIG_PATH, ZENMUX_QUOTA_SUBSCRIPTION_PATH } from '../src/paths.ts'
import { jsonResponse, rawDetail } from './fixtures.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>

describe('package manifest', () => {
  it('declares a web client bundle with the four host packages it needs', () => {
    expect(manifest['dsh'].client.platform).toBe('web')
    expect(manifest['dsh'].client.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-model-selection',
      '@deepseek-ai/dsh-client-locale',
    ])
    expect(manifest['exports']['./client']).toBe('./lib/client.js')
    expect(manifest['dsh'].bundle.patch).toBe('./cordis.patch.yml')
  })

  it('registers only itself in the patch', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('name: dsh-zenmux-quota')
    expect(patch).not.toMatch(/provider:|model:/u)
  })
})

describe('built artifacts', () => {
  const read = (file: string): string | undefined => {
    try { return readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8') } catch { return undefined }
  }

  it('wraps the client in the module-loader envelope and shares the host React', () => {
    const client = read('client.js')
    if (client === undefined) return // built by `npm run check`; skipped on a fresh checkout
    expect(client.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(client).toContain('require("react")')
    expect(client).not.toContain('react.production')
    expect(client).not.toContain('scheduler')
  })

  it('bundles the host half with only schemastery and node builtins as imports', () => {
    const host = read('index.js')
    if (host === undefined) return
    const imports = [...host.matchAll(/^import .* from "([^"]+)"/gmu)].map(match => match[1])
    expect(imports.every(spec => spec === '@deepseek-ai/schemastery' || spec?.startsWith('node:'))).toBe(true)
  })
})

describe('host apply', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  interface Registered { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }

  function fakeContext() {
    const registered: Registered[] = []
    const disposed: string[] = []
    const effects: (() => (() => void) | void)[] = []
    const cleanups: (() => void)[] = []
    const ctx = {
      effect: (fn: () => (() => void) | void) => { effects.push(fn); const cleanup = fn(); if (cleanup) cleanups.push(cleanup) },
      inject: (_names: string[], cb: (scope: unknown) => void) => { cb(ctx) },
      webServer: {
        register: (route: Registered & { kind: string }) => {
          registered.push(route)
          return () => { disposed.push(route.path) }
        },
      },
    }
    return { ctx, registered, disposed, cleanups }
  }

  function respond(): { res: ServerResponse; body: () => unknown } {
    let body = ''
    return {
      res: { writeHead: () => {}, end: (text: string) => { body = text } } as unknown as ServerResponse,
      body: () => JSON.parse(body),
    }
  }

  const localRequest = { method: 'GET', url: '/', headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage

  it('exports the plugin name and a config schema with safe defaults', () => {
    expect(name).toBe('dsh-zenmux-quota')
    expect(Config).toBeDefined()
  })

  it('registers both routes and removes them on teardown', () => {
    const { ctx, registered, disposed, cleanups } = fakeContext()
    apply(ctx as never, {} as never)
    expect(registered.map(route => route.path).sort()).toEqual([ZENMUX_QUOTA_CONFIG_PATH, ZENMUX_QUOTA_SUBSCRIPTION_PATH].sort())
    for (const cleanup of cleanups) cleanup()
    expect(disposed).toHaveLength(2)
  })

  it('reads the key from the configured environment variable, per request', async () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, { managementKeyEnv: 'MY_ZENMUX_KEY' } as never)
    const config = registered.find(route => route.path === ZENMUX_QUOTA_CONFIG_PATH)!
    const before = respond()
    await config.handler(localRequest, before.res)
    expect(before.body()).toMatchObject({ configured: false, providerPattern: '^zenmux', display: 'binding', providers: [] })
    vi.stubEnv('MY_ZENMUX_KEY', 'mk-env-secret')
    const after = respond()
    await config.handler(localRequest, after.res)
    const parsed = after.body() as Record<string, unknown>
    expect(parsed['configured']).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain('mk-env-secret')
  })

  it('reports not-configured from the subscription route without contacting ZenMux', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(rawDetail()))
    const { ctx, registered } = fakeContext()
    apply(ctx as never, { managementKeyEnv: 'DEFINITELY_UNSET_ZENMUX_KEY' } as never)
    const route = registered.find(entry => entry.path === ZENMUX_QUOTA_SUBSCRIPTION_PATH)!
    const out = respond()
    await route.handler(localRequest, out.res)
    expect(out.body()).toEqual({ state: 'not-configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('serves live data end to end when a key is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(rawDetail()))
    vi.stubEnv('ZENMUX_MANAGEMENT_API_KEY', 'mk-e2e')
    const { ctx, registered } = fakeContext()
    apply(ctx as never, {} as never)
    const route = registered.find(entry => entry.path === ZENMUX_QUOTA_SUBSCRIPTION_PATH)!
    const out = respond()
    await route.handler(localRequest, out.res)
    expect(out.body()).toMatchObject({ state: 'ready', data: { plan: { tier: 'ultra' } } })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://zenmux.ai/api/v1/management/subscription/detail')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer mk-e2e')
    fetchSpy.mockRestore()
  })

  it('ignores a baseURL that would send the key to another host', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(rawDetail()))
    vi.stubEnv('ZENMUX_MANAGEMENT_API_KEY', 'mk-e2e')
    const { ctx, registered } = fakeContext()
    apply(ctx as never, { baseURL: 'https://evil.example/api/v1' } as never)
    const route = registered.find(entry => entry.path === ZENMUX_QUOTA_SUBSCRIPTION_PATH)!
    await route.handler(localRequest, respond().res)
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0]).startsWith('https://zenmux.ai/')).toBe(true)
    fetchSpy.mockRestore()
  })
})
