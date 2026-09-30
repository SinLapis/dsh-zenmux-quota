import type { Context } from '@deepseek-ai/cordis';
/** Stable host plugin name. */
export declare const name = "dsh-zenmux-quota";
export type ZenMuxDisplayMode = "binding" | "five-hour" | "weekly" | "dual";
export interface Config {
  managementKeyEnv?: string;
  providers?: string[];
  providerPattern?: string;
  display?: ZenMuxDisplayMode;
  cacheTtlSeconds?: number;
  baseURL?: string;
}
export declare const Config: unknown;
/** Register the quota routes once the web server is available. */
export declare function apply(ctx: Context, config: Config): void;
