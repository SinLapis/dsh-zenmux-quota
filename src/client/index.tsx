/**
 * Browser half: registers the ZenMux quota indicator in the composer tool row,
 * immediately to the left of the model selector.
 *
 * Placement comes from the `conversation.input.right` slot, whose host-side
 * order is "this list, then the model selector, then the context meter". No DOM
 * query, no `MutationObserver`, and no use of the model selector's own seat.
 *
 * Registration is wrapped so a host slot-API change degrades to a
 * `console.error` instead of raising the loader's "Failed to load plugins"
 * banner: this plugin is decoration and the models it annotates keep working.
 *
 * @module dsh-zenmux-quota/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ZenMuxQuotaIndicator } from './ZenMuxQuotaIndicator.tsx'
import type { ZenMuxQuotaIndicatorInjected } from './ZenMuxQuotaIndicator.tsx'
import { ZenMuxQuotaStore } from './quota-store.ts'
import { en, zh } from './locales.ts'
import type { ZenMuxQuotaKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ZenMux composer quota copy. */
    'zenmux.quota': ZenMuxQuotaKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-zenmux-quota-client'

/** Client services this contribution needs (`modelDirectories` is requested below). */
export const inject = ['slots', 'locale']

const NAMESPACE = 'zenmux.quota'

/**
 * Register the quota copy and the composer indicator.
 * @param ctx - the browser plugin's cordis context.
 */
export function apply(ctx: ClientContext): void {
  try {
    const quota = new ZenMuxQuotaStore()
    // The store owns a document listener and timers; both must go when the
    // plugin unloads, and neither may live at module scope.
    ctx.effect(() => () => { quota.dispose() }, 'dsh-zenmux-quota: quota store')

    ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-zenmux-quota: composer copy')

    ctx.inject(['slots', 'modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'zenmux-quota',
        // Same order as the Codex and WorkBuddy indicators; each renders only for
        // its own provider, so at most one is visible at a time.
        order: 20,
        locale: NAMESPACE,
        inject: (sessionId: string): ZenMuxQuotaIndicatorInjected => ({
          directory: scope.modelDirectories.directoryFor(sessionId as SessionId).store,
          quota,
        }),
      }, ZenMuxQuotaIndicator))
    })
  } catch (error) {
    console.error('[dsh-zenmux-quota] composer indicator failed to load (model selection unaffected):', error)
  }
}
