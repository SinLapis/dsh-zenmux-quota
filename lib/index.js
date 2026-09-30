// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/key-source.ts
import { createHash } from "node:crypto";
function readManagementKey(env, name2) {
  const raw = env[name2];
  if (raw === void 0) return void 0;
  const key = raw.trim();
  if (key.length === 0 || !/^[\x21-\x7e]+$/u.test(key)) return void 0;
  return key;
}
function fingerprintOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// src/paths.ts
var ZENMUX_QUOTA_CONFIG_PATH = "/plugins/dsh-zenmux-quota/config";
var ZENMUX_QUOTA_SUBSCRIPTION_PATH = "/plugins/dsh-zenmux-quota/subscription";
var DEFAULT_MANAGEMENT_KEY_ENV = "ZENMUX_MANAGEMENT_API_KEY";
var DEFAULT_PROVIDER_PATTERN = "^zenmux";

// src/routes.ts
function loopbackHost(rawHost) {
  if (/[\\/@?#]/u.test(rawHost)) return false;
  try {
    const parsed = new URL(`http://${rawHost}`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      return false;
    }
    const bracketless = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
    const hostname = bracketless.toLowerCase().replace(/\.$/u, "");
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "::ffff:127.0.0.1";
  } catch {
    return false;
  }
}
function effectiveOrigin(req, host) {
  try {
    const encrypted = req.socket.encrypted === true;
    return new URL(`${encrypted ? "https" : "http"}://${host}`).origin;
  } catch {
    return void 0;
  }
}
function isTrustedRequest(req) {
  const remote = req.socket.remoteAddress;
  const localPeer = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const fetchSite = req.headers["sec-fetch-site"];
  const values = Array.isArray(fetchSite) ? fetchSite : [fetchSite];
  if (values.some((value) => typeof value === "string" && value.trim().toLowerCase() === "cross-site")) return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  const origin = effectiveOrigin(req, host);
  if (origin === void 0) return false;
  const claimed = req.headers.origin;
  if (claimed !== void 0) {
    if (typeof claimed !== "string") return false;
    try {
      if (new URL(claimed).origin !== origin) return false;
    } catch {
      return false;
    }
  }
  return localPeer && loopbackHost(host);
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function createHandlers(deps) {
  const guard = (req, res) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return false;
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { error: "forbidden" });
      return false;
    }
    return true;
  };
  return {
    config: async (req, res) => {
      if (!guard(req, res)) return;
      const settings = deps.settings();
      json(res, 200, {
        ...deps.service.keyStatus(),
        providers: [...settings.providers],
        providerPattern: settings.providerPattern,
        display: settings.display
      });
    },
    subscription: async (req, res) => {
      if (!guard(req, res)) return;
      let refresh = false;
      try {
        refresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
      } catch {
        refresh = false;
      }
      try {
        json(res, 200, await deps.service.get(refresh));
      } catch {
        json(res, 500, { error: "internal error" });
      }
    }
  };
}

// src/parse.ts
var TIERS = ["free", "pro", "max", "ultra"];
var STATUSES = ["healthy", "monitored", "abusive", "suspended", "banned"];
var RAW_STATUS_MAX = 16;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function isoToMs(value) {
  if (typeof value !== "string" || value.length === 0) return void 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : void 0;
}
function parseWindow(value) {
  if (!isRecord(value)) return void 0;
  const usagePercentage = num(value["usage_percentage"]);
  const maxFlows = num(value["max_flows"]);
  const usedFlows = num(value["used_flows"]);
  const remainingFlows = num(value["remaining_flows"]);
  const usedValueUsd = num(value["used_value_usd"]);
  const maxValueUsd = num(value["max_value_usd"]);
  if (usagePercentage === void 0 || maxFlows === void 0 || usedFlows === void 0 || remainingFlows === void 0 || usedValueUsd === void 0 || maxValueUsd === void 0) return void 0;
  const rawReset = value["resets_at"];
  let resetsAt;
  if (rawReset === null) {
    resetsAt = null;
  } else {
    const ms = isoToMs(rawReset);
    if (ms === void 0) return void 0;
    resetsAt = ms;
  }
  return { usagePercentage, resetsAt, maxFlows, usedFlows, remainingFlows, usedValueUsd, maxValueUsd };
}
function parseSubscriptionDetail(value) {
  if (!isRecord(value) || value["success"] !== true) return void 0;
  const data = value["data"];
  if (!isRecord(data)) return void 0;
  const fiveHour = parseWindow(data["quota_5_hour"]);
  const sevenDay = parseWindow(data["quota_7_day"]);
  if (fiveHour === void 0 && sevenDay === void 0) return void 0;
  const plan = isRecord(data["plan"]) ? data["plan"] : {};
  const tierRaw = plan["tier"];
  const tier = TIERS.find((candidate) => candidate === tierRaw) ?? "unknown";
  const amountUsd = num(plan["amount_usd"]);
  const expiresAt = isoToMs(plan["expires_at"]);
  const statusRaw = data["account_status"];
  const knownStatus = STATUSES.find((candidate) => candidate === statusRaw);
  const accountStatus = knownStatus ?? "unknown";
  const rawAccountStatus = knownStatus === void 0 && typeof statusRaw === "string" ? statusRaw.slice(0, RAW_STATUS_MAX) : void 0;
  const baseUsdPerFlow = num(data["base_usd_per_flow"]);
  const effectiveUsdPerFlow = num(data["effective_usd_per_flow"]);
  const monthlyRaw = data["quota_monthly"];
  let monthly;
  if (isRecord(monthlyRaw)) {
    const maxFlows = num(monthlyRaw["max_flows"]);
    const maxValueUsd = num(monthlyRaw["max_value_usd"]);
    if (maxFlows !== void 0 && maxValueUsd !== void 0) monthly = { maxFlows, maxValueUsd };
  }
  return {
    plan: {
      tier,
      ...amountUsd === void 0 ? {} : { amountUsd },
      ...expiresAt === void 0 ? {} : { expiresAt }
    },
    accountStatus,
    ...rawAccountStatus === void 0 ? {} : { rawAccountStatus },
    ...baseUsdPerFlow === void 0 ? {} : { baseUsdPerFlow },
    ...effectiveUsdPerFlow === void 0 ? {} : { effectiveUsdPerFlow },
    ...fiveHour === void 0 ? {} : { fiveHour },
    ...sevenDay === void 0 ? {} : { sevenDay },
    ...monthly === void 0 ? {} : { monthly }
  };
}

// src/upstream.ts
var DEFAULT_BASE_URL = "https://zenmux.ai/api/v1";
var UPSTREAM_TIMEOUT_MS = 15e3;
var MAX_BODY_CHARS = 64 * 1024;
function resolveBaseURL(candidate) {
  if (candidate === void 0 || candidate.trim() === "") return DEFAULT_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.hostname !== "zenmux.ai" || url.username !== "" || url.password !== "") {
      return DEFAULT_BASE_URL;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return DEFAULT_BASE_URL;
  }
}
function retryAfterMs(header, nowMs) {
  if (header === null) return void 0;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1e3);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : void 0;
}
async function fetchSubscription(key, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseURL ?? DEFAULT_BASE_URL;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const signal = options.signal === void 0 ? timeout : AbortSignal.any([options.signal, timeout]);
  let response;
  try {
    response = await doFetch(`${base}/management/subscription/detail`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal
    });
  } catch {
    return { kind: "upstream-error" };
  }
  const requestId = response.headers.get("x-zenmux-requestid") ?? void 0;
  const withId = requestId === void 0 ? {} : { requestId };
  const status = response.status;
  if (status === 401 || status === 403) return { kind: "unauthorized", ...withId };
  if (status === 422 || status === 429) {
    const wait = retryAfterMs(response.headers.get("retry-after"), Date.now());
    return { kind: "rate-limited", ...wait === void 0 ? {} : { retryAfterMs: wait }, ...withId };
  }
  if (!response.ok) return { kind: "upstream-error", ...withId };
  let text;
  try {
    text = await response.text();
  } catch {
    return { kind: "upstream-error", ...withId };
  }
  if (text.length > MAX_BODY_CHARS) return { kind: "invalid-data", ...withId };
  let json2;
  try {
    json2 = JSON.parse(text);
  } catch {
    return { kind: "invalid-data", ...withId };
  }
  const data = parseSubscriptionDetail(json2);
  return data === void 0 ? { kind: "invalid-data", ...withId } : { kind: "ok", data, ...withId };
}

// src/service.ts
var MIN_REFRESH_INTERVAL_MS = 1e4;
var STALE_MAX_AGE_MS = 5 * 6e4;
var MIN_CACHE_TTL_MS = 3e4;
var DEFAULT_CACHE_TTL_MS = 6e4;
var ERROR_BACKOFF_MS = [6e4, 12e4, 3e5];
var RATE_LIMIT_FLOOR_MS = 6e4;
var RATE_LIMIT_CAP_MS = 3e5;
var INVALID_DATA_DELAY_MS = 3e5;
function read(value, fallback) {
  if (value === void 0) return fallback;
  return typeof value === "function" ? value() : value;
}
var SubscriptionService = class {
  options;
  now;
  random;
  controller = new AbortController();
  inflight;
  cache;
  failure;
  /** Consecutive 5xx/network failures; drives the 60/120/300 s ladder. */
  errorCount = 0;
  /** Consecutive 422/429 answers; drives the rate-limit doubling. Kept apart from errorCount. */
  rateLimitCount = 0;
  lastUpstreamAt = Number.NEGATIVE_INFINITY;
  fingerprint;
  disposed = false;
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }
  /** Current cache TTL, never below the 30 s floor. */
  ttl() {
    const value = read(this.options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    return Number.isFinite(value) ? Math.max(MIN_CACHE_TTL_MS, value) : DEFAULT_CACHE_TTL_MS;
  }
  /** Whether a usable key is currently configured, and its fingerprint. */
  keyStatus() {
    const key = this.options.keySource();
    return key === void 0 ? { configured: false } : { configured: true, keyFingerprint: fingerprintOf(key) };
  }
  /**
   * Current subscription state.
   *
   * A refresh skips the TTL cache (at most every 10 seconds) and retries an
   * `unauthorized` key, but it never shortens a rate-limit, error, or
   * invalid-data backoff: repeated clicks must not hammer a limited endpoint.
   *
   * @param refresh - a user-requested refresh.
   * @returns a result; never rejects.
   */
  async get(refresh = false) {
    if (this.disposed) return { state: "upstream-error", retryAfterMs: ERROR_BACKOFF_MS[0] };
    const key = this.options.keySource();
    if (key === void 0) {
      this.reset();
      this.fingerprint = void 0;
      return { state: "not-configured" };
    }
    const fingerprint = fingerprintOf(key);
    if (fingerprint !== this.fingerprint) {
      this.reset();
      this.fingerprint = fingerprint;
    }
    const now = this.now();
    const failure = this.failure;
    if (failure !== void 0 && now < failure.until) {
      const retryable = failure.state === "unauthorized" && refresh && now - this.lastUpstreamAt >= MIN_REFRESH_INTERVAL_MS;
      if (!retryable) return this.failureResult(now, fingerprint);
    }
    const forced = refresh && now - this.lastUpstreamAt >= MIN_REFRESH_INTERVAL_MS;
    if (!forced && this.cache !== void 0 && now - this.cache.fetchedAt < this.ttl()) return this.cache;
    const inflight = this.inflight;
    if (inflight !== void 0 && inflight.fingerprint === fingerprint) return inflight.promise;
    const promise = this.fetchOnce(key, fingerprint).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = void 0;
    });
    this.inflight = { fingerprint, promise };
    return promise;
  }
  /** Abort any in-flight request and drop cached state. */
  dispose() {
    this.disposed = true;
    this.controller.abort();
    this.reset();
  }
  reset() {
    this.cache = void 0;
    this.failure = void 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
    this.lastUpstreamAt = Number.NEGATIVE_INFINITY;
    this.inflight = void 0;
  }
  staleFor(now) {
    const cache = this.cache;
    return cache !== void 0 && now - cache.fetchedAt <= STALE_MAX_AGE_MS ? cache : void 0;
  }
  failureResult(now, fingerprint) {
    const failure = this.failure;
    if (failure === void 0 || failure.state === "unauthorized") {
      return { state: "unauthorized", keyFingerprint: fingerprint };
    }
    const stale = this.staleFor(now);
    return {
      state: failure.state,
      retryAfterMs: Math.max(0, failure.until - now),
      ...stale === void 0 ? {} : { stale }
    };
  }
  /** Jittered step of the 60 / 120 / 300 s ladder. */
  errorDelay() {
    const base = ERROR_BACKOFF_MS[Math.min(this.errorCount, ERROR_BACKOFF_MS.length) - 1] ?? ERROR_BACKOFF_MS[2];
    return Math.round(base * (0.9 + this.random() * 0.2));
  }
  async fetchOnce(key, fingerprint) {
    this.lastUpstreamAt = this.now();
    const fetchOptions = {
      baseURL: read(this.options.baseURL, DEFAULT_BASE_URL),
      signal: this.controller.signal,
      ...this.options.fetch === void 0 ? {} : { fetch: this.options.fetch },
      ...this.options.timeoutMs === void 0 ? {} : { timeoutMs: this.options.timeoutMs }
    };
    const startedAt = this.now();
    const outcome = await fetchSubscription(key, fetchOptions);
    const now = this.now();
    this.options.log?.("upstream", {
      kind: outcome.kind,
      ms: now - startedAt,
      ...outcome.requestId === void 0 ? {} : { requestId: outcome.requestId }
    });
    if (this.disposed) return { state: "upstream-error", retryAfterMs: ERROR_BACKOFF_MS[0] };
    if (this.fingerprint !== fingerprint) return this.get();
    return this.apply(outcome, now, fingerprint);
  }
  apply(outcome, now, fingerprint) {
    switch (outcome.kind) {
      case "ok": {
        this.cache = { state: "ready", data: outcome.data, fetchedAt: now, keyFingerprint: fingerprint };
        this.failure = void 0;
        this.errorCount = 0;
        this.rateLimitCount = 0;
        return this.cache;
      }
      case "unauthorized": {
        this.cache = void 0;
        this.failure = { state: "unauthorized", until: Number.POSITIVE_INFINITY };
        return { state: "unauthorized", keyFingerprint: fingerprint };
      }
      case "rate-limited": {
        this.rateLimitCount += 1;
        const floor = Math.max(outcome.retryAfterMs ?? 0, RATE_LIMIT_FLOOR_MS);
        const cap = Math.max(RATE_LIMIT_CAP_MS, floor);
        const delay = Math.min(floor * 2 ** (this.rateLimitCount - 1), cap);
        return this.fail("rate-limited", now, delay);
      }
      case "upstream-error": {
        this.errorCount += 1;
        return this.fail("upstream-error", now, this.errorDelay());
      }
      case "invalid-data":
        return this.fail("invalid-data", now, INVALID_DATA_DELAY_MS);
    }
  }
  fail(state, now, delay) {
    this.failure = { state, until: now + delay };
    const stale = this.staleFor(now);
    return { state, retryAfterMs: delay, ...stale === void 0 ? {} : { stale } };
  }
};

// src/index.ts
var name = "dsh-zenmux-quota";
var Config = z.object({
  managementKeyEnv: z.string().default(DEFAULT_MANAGEMENT_KEY_ENV).volatile(),
  providers: z.array(z.string()).default([]).volatile(),
  providerPattern: z.string().default(DEFAULT_PROVIDER_PATTERN).volatile(),
  display: z.union(["binding", "five-hour", "weekly", "dual"]).default("binding").volatile(),
  cacheTtlSeconds: z.number().step(1).min(MIN_CACHE_TTL_MS / 1e3).default(DEFAULT_CACHE_TTL_MS / 1e3).volatile(),
  baseURL: z.string().default("").volatile()
});
function liveValue(value, fallback) {
  const candidate = value;
  if (typeof candidate === "object" && candidate !== null && "get" in candidate && typeof candidate.get === "function") {
    return candidate.get() ?? fallback;
  }
  return candidate ?? fallback;
}
function apply(ctx, config) {
  const settings = () => ({
    providers: liveValue(config.providers, []),
    providerPattern: liveValue(config.providerPattern, DEFAULT_PROVIDER_PATTERN),
    display: liveValue(config.display, "binding")
  });
  const reported = /* @__PURE__ */ new Set();
  const service = new SubscriptionService({
    keySource: () => readManagementKey(process.env, liveValue(config.managementKeyEnv, DEFAULT_MANAGEMENT_KEY_ENV)),
    // Both are volatile config: read on every use so a hot update takes effect
    // without the plugin being re-applied.
    cacheTtlMs: () => liveValue(config.cacheTtlSeconds, DEFAULT_CACHE_TTL_MS / 1e3) * 1e3,
    baseURL: () => resolveBaseURL(liveValue(config.baseURL, "")),
    // Only state changes worth a user's attention are printed, once each.
    log: (event, fields) => {
      const kind = String(fields["kind"]);
      if (event !== "upstream") return;
      if (kind === "ok") {
        reported.clear();
        return;
      }
      if (reported.has(kind)) return;
      reported.add(kind);
      const id = fields["requestId"] === void 0 ? "" : ` requestId=${String(fields["requestId"])}`;
      console.warn(`[dsh-zenmux-quota] upstream ${kind}${id}`);
    }
  });
  ctx.effect(() => () => {
    service.dispose();
  }, "dsh-zenmux-quota: subscription service");
  ctx.inject(["webServer"], (webCtx) => {
    const handlers = createHandlers({ service, settings });
    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({ kind: "exact", path: ZENMUX_QUOTA_CONFIG_PATH, handler: handlers.config }),
        webCtx.webServer.register({ kind: "exact", path: ZENMUX_QUOTA_SUBSCRIPTION_PATH, handler: handlers.subscription })
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-zenmux-quota: routes");
  });
}
export {
  Config,
  SubscriptionService,
  ZENMUX_QUOTA_CONFIG_PATH,
  ZENMUX_QUOTA_SUBSCRIPTION_PATH,
  apply,
  name,
  parseSubscriptionDetail
};
