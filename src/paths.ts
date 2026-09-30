/** Node-free route constants shared by the Host and browser halves. */

/** Cheap config route: is a key configured, which providers are ZenMux, display mode. */
export const ZENMUX_QUOTA_CONFIG_PATH = '/plugins/dsh-zenmux-quota/config'
/** Subscription route: cached, coalesced access to the upstream Management API. */
export const ZENMUX_QUOTA_SUBSCRIPTION_PATH = '/plugins/dsh-zenmux-quota/subscription'

/** Console page opened from the detail popover (fixed constant, never user input). */
export const ZENMUX_CONSOLE_URL = 'https://zenmux.ai/platform/subscription'

/** Which window the compact bar leads with. */
export type ZenMuxDisplayMode = 'binding' | 'five-hour' | 'weekly' | 'dual'

/** Accepted `display` values, in declaration order. */
export const ZENMUX_DISPLAY_MODES: readonly ZenMuxDisplayMode[] = ['binding', 'five-hour', 'weekly', 'dual']

/** Default environment variable holding the Management API key. */
export const DEFAULT_MANAGEMENT_KEY_ENV = 'ZENMUX_MANAGEMENT_API_KEY'
/** Default provider-id pattern (case-insensitive) when no explicit list is given. */
export const DEFAULT_PROVIDER_PATTERN = '^zenmux'
