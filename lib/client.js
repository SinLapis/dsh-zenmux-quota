window.__ModuleLoader__.load({
	id: "dsh-zenmux-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name2 in all)
		    __defProp(target, name2, { get: all[name2], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject,
		  name: () => name
		});
		module.exports = __toCommonJS(index_exports);

		// src/client/ZenMuxQuotaIndicator.tsx
		var import_react = require("react");

		// src/paths.ts
		var ZENMUX_QUOTA_CONFIG_PATH = "/plugins/dsh-zenmux-quota/config";
		var ZENMUX_QUOTA_SUBSCRIPTION_PATH = "/plugins/dsh-zenmux-quota/subscription";
		var ZENMUX_CONSOLE_URL = "https://zenmux.ai/platform/subscription";
		var ZENMUX_DISPLAY_MODES = ["binding", "five-hour", "weekly", "dual"];

		// src/client/quota-view.ts
		var QUOTA_CONTAINER_HEIGHT_PX = 28;
		var QUOTA_PROGRESS_WIDTH_PX = 48;
		var QUOTA_PROGRESS_TRACK_HEIGHT_PX = 6;
		var RESET_REFRESH_GRACE_MS = 2e3;
		function nextResetDelay(dto, nowMs) {
		  let earliest;
		  for (const window2 of [dto.fiveHour, dto.sevenDay]) {
		    const at = window2?.resetsAt;
		    if (at === null || at === void 0 || at <= nowMs) continue;
		    if (earliest === void 0 || at < earliest) earliest = at;
		  }
		  return earliest === void 0 ? void 0 : earliest - nowMs + RESET_REFRESH_GRACE_MS;
		}
		function clampPercent(value) {
		  return Math.min(100, Math.max(0, value));
		}
		function remainingPercentOf(window2) {
		  if (window2.maxFlows <= 0) return void 0;
		  const tolerance = Math.max(0.01, window2.maxFlows * 5e-3);
		  const consistent = Math.abs(window2.usedFlows + window2.remainingFlows - window2.maxFlows) <= tolerance;
		  return clampPercent(consistent ? window2.remainingFlows / window2.maxFlows * 100 : (1 - window2.usagePercentage) * 100);
		}
		function viewOf(kind, window2, nowMs) {
		  if (window2 === void 0) return void 0;
		  const measured = remainingPercentOf(window2);
		  if (measured === void 0) return void 0;
		  const notStarted = window2.resetsAt === null;
		  const resetElapsed = window2.resetsAt !== null && window2.resetsAt <= nowMs;
		  return {
		    kind,
		    remainingPercent: measured,
		    remainingFlows: window2.remainingFlows,
		    maxFlows: window2.maxFlows,
		    usedValueUsd: window2.usedValueUsd,
		    maxValueUsd: window2.maxValueUsd,
		    resetsAt: window2.resetsAt,
		    notStarted,
		    resetElapsed
		  };
		}
		function selectLeadingWindow(dto, display, nowMs) {
		  const fiveHour = viewOf("five-hour", dto.fiveHour, nowMs);
		  const sevenDay = viewOf("weekly", dto.sevenDay, nowMs);
		  const reported = [dto.fiveHour, dto.sevenDay].filter((window2) => window2 !== void 0);
		  const zeroCapacity = reported.length > 0 && reported.every((window2) => window2.maxFlows === 0);
		  const summary = { ...fiveHour === void 0 ? {} : { fiveHour }, ...sevenDay === void 0 ? {} : { sevenDay } };
		  if (display === "five-hour" || display === "weekly") {
		    const forced = display === "five-hour" ? fiveHour : sevenDay;
		    if (forced === void 0) {
		      const raw = display === "five-hour" ? dto.fiveHour : dto.sevenDay;
		      return { available: false, reason: raw !== void 0 && raw.maxFlows === 0 ? "zero-capacity" : "no-window" };
		    }
		    const other = display === "five-hour" ? sevenDay : fiveHour;
		    return { available: true, window: forced, ...other === void 0 ? {} : { other }, ...summary, reason: "forced" };
		  }
		  if (fiveHour === void 0 && sevenDay === void 0) {
		    return { available: false, reason: zeroCapacity ? "zero-capacity" : "no-window" };
		  }
		  if (fiveHour !== void 0 && sevenDay !== void 0) {
		    const tighter = sevenDay.remainingPercent < fiveHour.remainingPercent ? sevenDay : fiveHour;
		    const other = tighter === fiveHour ? sevenDay : fiveHour;
		    return { available: true, window: tighter, other, ...summary, reason: "binding" };
		  }
		  const only = fiveHour ?? sevenDay;
		  return { available: true, window: only, ...summary, reason: "binding" };
		}
		function quotaColor(remainingPercent) {
		  const bounded = clampPercent(remainingPercent);
		  if (bounded >= 60) return { name: "green", value: "var(--dsw-alias-state-success-primary, #22c55e)" };
		  if (bounded >= 40) return { name: "yellow", value: "var(--dsw-alias-state-warn-primary, #eab308)" };
		  if (bounded >= 20) return { name: "orange", value: "#f97316" };
		  return { name: "red", value: "var(--dsw-alias-state-error-primary, #ef4444)" };
		}
		function statusSeverity(status) {
		  switch (status) {
		    case "healthy":
		      return "none";
		    case "monitored":
		      return "warn";
		    case "abusive":
		    case "suspended":
		    case "banned":
		      return "error";
		    case "unknown":
		      return "neutral";
		  }
		}
		function isBlockedStatus(status) {
		  return status === "suspended" || status === "banned";
		}
		function isRateRaised(dto) {
		  return dto.baseUsdPerFlow !== void 0 && dto.effectiveUsdPerFlow !== void 0 && dto.effectiveUsdPerFlow > dto.baseUsdPerFlow + 1e-9;
		}
		function decimal(value, digits) {
		  return new Intl.NumberFormat(void 0, { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value);
		}
		function formatFlows(value) {
		  return value > 0 && value < 0.1 ? "<0.1" : decimal(value, 1);
		}
		function formatPercent(value) {
		  return decimal(clampPercent(value), 1);
		}
		function formatUsd(value) {
		  return new Intl.NumberFormat(void 0, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
		}
		function formatRate(value) {
		  return `$${decimal(value, 5)}`;
		}
		function formatDate(ms) {
		  return new Intl.DateTimeFormat(void 0, { dateStyle: "medium" }).format(new Date(ms));
		}
		function formatRelative(targetMs, nowMs) {
		  const diffSeconds = (targetMs - nowMs) / 1e3;
		  const abs = Math.abs(diffSeconds);
		  const formatter = new Intl.RelativeTimeFormat(void 0, { numeric: "auto" });
		  if (abs < 45) return formatter.format(Math.round(diffSeconds), "second");
		  if (abs < 90 * 60) return formatter.format(Math.round(diffSeconds / 60), "minute");
		  if (abs < 36 * 3600) return formatter.format(Math.round(diffSeconds / 3600), "hour");
		  return formatter.format(Math.round(diffSeconds / 86400), "day");
		}
		var compiled = /* @__PURE__ */ new Map();
		function matchesProvider(provider, config) {
		  if (provider === null || provider === void 0 || provider === "") return false;
		  if (config.providers.length > 0) return config.providers.includes(provider);
		  let pattern = compiled.get(config.providerPattern);
		  if (pattern === void 0) {
		    try {
		      pattern = new RegExp(config.providerPattern, "i");
		    } catch {
		      pattern = null;
		      console.warn("[dsh-zenmux-quota] providerPattern is not a valid regular expression; no provider matches");
		    }
		    compiled.set(config.providerPattern, pattern);
		  }
		  return pattern !== null && pattern.test(provider);
		}

		// src/client/ZenMuxQuotaIndicator.tsx
		var import_jsx_runtime = require("react/jsx-runtime");
		var NEUTRAL_COLOR = "var(--dsw-alias-label-dimmed, #9aa0a6)";
		var DOT_COLORS = {
		  warn: "var(--dsw-alias-state-warn-primary, #eab308)",
		  error: "var(--dsw-alias-state-error-primary, #ef4444)",
		  neutral: NEUTRAL_COLOR
		};
		var TICK_MS = 3e4;
		var REFRESH_FALLBACK_MS = 2500;
		function planLabel(t, tier) {
		  switch (tier) {
		    case "free":
		      return t("planFree");
		    case "pro":
		      return t("planPro");
		    case "max":
		      return t("planMax");
		    case "ultra":
		      return t("planUltra");
		    case "unknown":
		      return t("planUnknown");
		  }
		}
		function periodLabel(t, window2) {
		  return window2.kind === "five-hour" ? t("windowFiveHour") : t("windowWeekly");
		}
		function presentationOf(snapshot, display, nowMs) {
		  const { state, data } = snapshot;
		  if (state === "idle" || state === "loading") return { kind: "loading" };
		  if (state === "route-missing") return { kind: "hide" };
		  if (state === "forbidden" || state === "not-configured" || state === "unauthorized") {
		    return { kind: "placeholder", reason: state };
		  }
		  if (data === void 0) {
		    return { kind: "placeholder", reason: state === "ready" ? "invalid-data" : state };
		  }
		  const leading = selectLeadingWindow(data, display, nowMs);
		  if (!leading.available) return { kind: "placeholder", reason: leading.reason };
		  return { kind: "bar", leading, data };
		}
		function placeholderText(reason, t) {
		  const brand = t("brand");
		  switch (reason) {
		    case "not-configured":
		      return t("notConfigured", { brand });
		    case "unauthorized":
		      return t("unauthorized", { brand });
		    case "rate-limited":
		      return t("rateLimited", { brand });
		    case "upstream-error":
		      return t("upstreamError", { brand });
		    case "invalid-data":
		      return t("invalidData", { brand });
		    case "forbidden":
		      return t("forbidden", { brand });
		    case "zero-capacity":
		      return t("zeroCapacity", { brand });
		    case "no-window":
		      return t("noWindow", { brand });
		  }
		}
		function shortText(view, t) {
		  const brand = t("brandShort");
		  if (view.kind === "loading") return `${brand} ${t("loadingShort")}`;
		  if (view.kind === "placeholder") {
		    if (view.reason === "not-configured") return `${brand} ⚙`;
		    if (view.reason === "unauthorized") return `${brand} !`;
		    return `${brand} ${t("unavailableShort")}`;
		  }
		  return brand;
		}
		function resetText(window2, nowMs, t) {
		  if (window2.notStarted) return t("windowNotStarted");
		  if (window2.resetElapsed) return t("windowResetPending");
		  return t("resetIn", { time: formatRelative(window2.resetsAt ?? nowMs, nowMs) });
		}
		function statusText(data, t) {
		  switch (data.accountStatus) {
		    case "healthy":
		      return void 0;
		    case "monitored":
		      return t("statusMonitored");
		    case "abusive":
		      return t("statusAbusive");
		    case "suspended":
		      return t("statusSuspended");
		    case "banned":
		      return t("statusBanned");
		    case "unknown":
		      return t("statusUnknown", { status: data.rawAccountStatus ?? "?" });
		  }
		}
		function barSummary(view, snapshot, nowMs, t) {
		  const { leading, data } = view;
		  const window2 = leading.window;
		  const parts = [
		    t("summaryHead", { brand: t("brand"), plan: planLabel(t, data.plan.tier) }),
		    t("summaryWindow", {
		      period: periodLabel(t, window2),
		      percent: formatPercent(window2.remainingPercent),
		      remaining: formatFlows(window2.remainingFlows),
		      max: formatFlows(window2.maxFlows)
		    }),
		    resetText(window2, nowMs, t)
		  ];
		  if (leading.other !== void 0) {
		    parts.push(t("summaryOther", { period: periodLabel(t, leading.other), percent: formatPercent(leading.other.remainingPercent) }));
		  }
		  const status = statusText(data, t);
		  if (status !== void 0) parts.push(status);
		  if (snapshot.stale === true) {
		    parts.push(snapshot.state === "rate-limited" ? t("rateLimited", { brand: t("brand") }) : t("staleNote"));
		  }
		  return parts.join(" · ");
		}
		function Track({ percent, height, colorOverride, attr }) {
		  const color = quotaColor(percent);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		    "span",
		    {
		      "aria-hidden": "true",
		      "data-zenmux-quota-track": attr ?? "",
		      style: { display: "block", width: "100%", height, borderRadius: "999px", backgroundColor: "var(--dsw-alias-border-l2)", overflow: "hidden" },
		      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "span",
		        {
		          "aria-hidden": "true",
		          "data-zenmux-quota-progress": attr ?? "",
		          "data-zenmux-quota-color": color.name,
		          style: {
		            display: "block",
		            width: `${Math.min(100, Math.max(0, percent))}%`,
		            height: "100%",
		            borderRadius: "inherit",
		            backgroundColor: colorOverride ?? color.value
		          }
		        }
		      )
		    }
		  );
		}
		function WindowRow({ window: window2, nowMs, t }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { "data-zenmux-quota-window": window2.kind, style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600 }, children: periodLabel(t, window2) }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Track, { percent: window2.remainingPercent, height: QUOTA_PROGRESS_TRACK_HEIGHT_PX }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("detailRemaining", {
		      percent: formatPercent(window2.remainingPercent),
		      remaining: formatFlows(window2.remainingFlows),
		      max: formatFlows(window2.maxFlows),
		      remainingUsd: formatUsd(Math.max(0, window2.maxValueUsd - window2.usedValueUsd)),
		      maxUsd: formatUsd(window2.maxValueUsd)
		    }) }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: resetText(window2, nowMs, t) })
		  ] });
		}
		function ZenMuxQuotaIndicator({ directory, quota, t }) {
		  const directoryState = (0, import_react.useSyncExternalStore)(
		    (0, import_react.useCallback)((listener) => directory.subscribe(listener), [directory]),
		    (0, import_react.useCallback)(() => directory.getSnapshot(), [directory]),
		    (0, import_react.useCallback)(() => directory.getSnapshot(), [directory])
		  );
		  const usable = directoryState.status === "ready" || directoryState.status === "selecting" || directoryState.status === "loading";
		  const provider = usable ? directoryState.current?.provider ?? void 0 : void 0;
		  const store = (0, import_react.useSyncExternalStore)(quota.subscribe, quota.getSnapshot, quota.getSnapshot);
		  (0, import_react.useEffect)(() => {
		    if (provider !== void 0) quota.ensureConfig();
		  }, [quota, provider]);
		  const config = store.config;
		  const matched = config !== void 0 && matchesProvider(provider, config);
		  (0, import_react.useEffect)(() => {
		    if (!matched) return;
		    return quota.retain();
		  }, [quota, matched]);
		  const [hovered, setHovered] = (0, import_react.useState)(false);
		  const [focused, setFocused] = (0, import_react.useState)(false);
		  const [expanded, setExpanded] = (0, import_react.useState)(false);
		  const [refreshing, setRefreshing] = (0, import_react.useState)(false);
		  const [, setTick] = (0, import_react.useState)(0);
		  const refreshBaseRef = (0, import_react.useRef)(void 0);
		  const rootRef = (0, import_react.useRef)(null);
		  const tooltipId = (0, import_react.useId)();
		  const detailId = (0, import_react.useId)();
		  const tooltipVisible = hovered || focused;
		  (0, import_react.useEffect)(() => {
		    if (!tooltipVisible && !expanded) return;
		    const timer = window.setInterval(() => {
		      setTick((tick) => tick + 1);
		    }, TICK_MS);
		    return () => {
		      window.clearInterval(timer);
		    };
		  }, [tooltipVisible, expanded]);
		  (0, import_react.useEffect)(() => {
		    if (!expanded) return;
		    const onKeyDown = (event) => {
		      if (event.key === "Escape") {
		        event.stopPropagation();
		        setExpanded(false);
		      }
		    };
		    const onPointerDown = (event) => {
		      const node = rootRef.current;
		      if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
		      setExpanded(false);
		    };
		    document.addEventListener("keydown", onKeyDown);
		    document.addEventListener("pointerdown", onPointerDown, true);
		    return () => {
		      document.removeEventListener("keydown", onKeyDown);
		      document.removeEventListener("pointerdown", onPointerDown, true);
		    };
		  }, [expanded]);
		  (0, import_react.useEffect)(() => {
		    if (!matched) setExpanded(false);
		  }, [matched]);
		  (0, import_react.useEffect)(() => {
		    if (!refreshing) return;
		    if (store.quota !== refreshBaseRef.current) {
		      setRefreshing(false);
		      return;
		    }
		    const timer = window.setTimeout(() => {
		      setRefreshing(false);
		    }, REFRESH_FALLBACK_MS);
		    return () => {
		      window.clearTimeout(timer);
		    };
		  }, [refreshing, store.quota]);
		  if (!matched || config === void 0) return null;
		  const nowMs = Date.now();
		  const snapshot = store.quota;
		  const view = presentationOf(snapshot, config.display, nowMs);
		  if (view.kind === "hide") return null;
		  const brand = t("brand");
		  const label = view.kind === "loading" ? t("loading", { brand }) : view.kind === "placeholder" ? placeholderText(view.reason, t) : barSummary(view, snapshot, nowMs, t);
		  const leading = view.kind === "bar" ? view.leading : void 0;
		  const dual = leading !== void 0 && config.display === "dual" && leading.fiveHour !== void 0 && leading.sevenDay !== void 0;
		  const blocked = view.kind === "bar" && isBlockedStatus(view.data.accountStatus);
		  const severity = view.kind === "bar" ? statusSeverity(view.data.accountStatus) : "none";
		  const onRefresh = () => {
		    refreshBaseRef.current = snapshot;
		    setRefreshing(true);
		    quota.refresh();
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		    "span",
		    {
		      ref: rootRef,
		      "data-zenmux-quota": leading?.window.kind ?? "placeholder",
		      "data-zenmux-quota-state": snapshot.state,
		      "data-zenmux-quota-status": view.kind === "bar" ? view.data.accountStatus : "none",
		      "data-zenmux-quota-pending": leading?.window.resetElapsed === true ? "reset" : void 0,
		      style: { display: "inline-flex", position: "relative", alignItems: "center" },
		      children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		          "span",
		          {
		            role: "status",
		            "aria-label": label,
		            "aria-describedby": tooltipVisible && !expanded ? tooltipId : void 0,
		            "aria-expanded": expanded,
		            "aria-controls": expanded ? detailId : void 0,
		            tabIndex: 0,
		            "data-zenmux-quota-control": "",
		            onClick: () => {
		              setExpanded((open) => !open);
		            },
		            onKeyDown: (event) => {
		              if (event.key === "Enter" || event.key === " ") {
		                event.preventDefault();
		                setExpanded((open) => !open);
		              }
		            },
		            onMouseEnter: () => {
		              setHovered(true);
		            },
		            onMouseLeave: () => {
		              setHovered(false);
		            },
		            onFocus: () => {
		              setFocused(true);
		            },
		            onBlur: () => {
		              setFocused(false);
		            },
		            style: {
		              position: "relative",
		              display: "inline-flex",
		              alignItems: "center",
		              justifyContent: "center",
		              height: `${QUOTA_CONTAINER_HEIGHT_PX}px`,
		              padding: leading === void 0 ? "0 6px" : "0 2px",
		              border: 0,
		              borderRadius: 8,
		              background: "transparent",
		              color: "var(--dsw-alias-label-secondary)",
		              font: "inherit",
		              fontSize: 12,
		              lineHeight: "18px",
		              whiteSpace: "nowrap",
		              cursor: "pointer"
		            },
		            children: [
		              leading === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", "data-zenmux-quota-text": "", style: { color: NEUTRAL_COLOR }, children: shortText(view, t) }) : dual ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		                "span",
		                {
		                  "aria-hidden": "true",
		                  style: { display: "flex", flexDirection: "column", gap: 2, width: `${QUOTA_PROGRESS_WIDTH_PX}px`, opacity: blocked ? 0.5 : 1 },
		                  children: [
		                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Track, { percent: leading.fiveHour.remainingPercent, height: 2, attr: "five-hour" }),
		                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Track, { percent: leading.sevenDay.remainingPercent, height: 2, attr: "weekly" })
		                  ]
		                }
		              ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", style: { display: "block", width: `${QUOTA_PROGRESS_WIDTH_PX}px`, opacity: blocked ? 0.5 : 1 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		                Track,
		                {
		                  percent: leading.window.remainingPercent,
		                  height: QUOTA_PROGRESS_TRACK_HEIGHT_PX,
		                  attr: leading.window.kind,
		                  ...blocked ? { colorOverride: NEUTRAL_COLOR } : {}
		                }
		              ) }),
		              severity === "none" ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		                "span",
		                {
		                  "aria-hidden": "true",
		                  "data-zenmux-quota-dot": severity,
		                  style: {
		                    position: "absolute",
		                    top: 3,
		                    right: 0,
		                    width: 4,
		                    height: 4,
		                    borderRadius: "50%",
		                    backgroundColor: DOT_COLORS[severity]
		                  }
		                }
		              )
		            ]
		          }
		        ),
		        tooltipVisible && !expanded ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          "span",
		          {
		            id: tooltipId,
		            role: "tooltip",
		            "data-zenmux-quota-tooltip": "",
		            style: {
		              position: "absolute",
		              bottom: "calc(100% + 6px)",
		              left: "50%",
		              transform: "translateX(-50%)",
		              zIndex: 1e3,
		              maxWidth: 320,
		              padding: "4px 8px",
		              borderRadius: 6,
		              backgroundColor: "var(--dsw-specific-tip, #1f2329)",
		              color: "var(--dsw-alias-label-primary, #ffffff)",
		              boxShadow: "var(--dsw-shadow-lv2, 0 4px 12px rgb(0 0 0 / 12%))",
		              fontSize: 12,
		              lineHeight: "18px",
		              textAlign: "center",
		              whiteSpace: "normal",
		              pointerEvents: "none"
		            },
		            children: label
		          }
		        ) : null,
		        expanded ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		          "span",
		          {
		            id: detailId,
		            role: "dialog",
		            "aria-label": t("detailHeading"),
		            "data-zenmux-quota-detail": "",
		            style: {
		              position: "absolute",
		              right: 0,
		              bottom: "calc(100% + 8px)",
		              zIndex: 1001,
		              display: "flex",
		              flexDirection: "column",
		              gap: 8,
		              width: 300,
		              maxWidth: "90vw",
		              padding: "10px 12px",
		              border: "1px solid var(--dsw-alias-border-l2)",
		              borderRadius: 8,
		              background: "var(--dsw-alias-bg-layer-1, #ffffff)",
		              boxShadow: "var(--dsw-shadow-lv2, 0 4px 12px rgb(0 0 0 / 12%))",
		              color: "var(--dsw-alias-label-primary)",
		              fontSize: 12,
		              lineHeight: "18px",
		              whiteSpace: "normal"
		            },
		            children: [
		              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600 }, children: t("detailHeading") }),
		              view.kind === "bar" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailBody, { view, snapshot, nowMs, t }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { "data-zenmux-quota-message": "", children: [
		                view.kind === "loading" ? t("loading", { brand }) : placeholderText(view.reason, t),
		                view.kind === "placeholder" && view.reason === "not-configured" ? ` ${t("notConfiguredHint")}` : ""
		              ] }),
		              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }, children: [
		                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		                  "a",
		                  {
		                    href: ZENMUX_CONSOLE_URL,
		                    target: "_blank",
		                    rel: "noopener noreferrer",
		                    "data-zenmux-quota-console": "",
		                    style: { color: "var(--dsw-alias-label-secondary)", marginRight: "auto" },
		                    children: [
		                      t("openConsole"),
		                      " ↗"
		                    ]
		                  }
		                ),
		                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		                  "button",
		                  {
		                    type: "button",
		                    "data-zenmux-quota-refresh": "",
		                    disabled: refreshing || snapshot.state === "loading",
		                    onClick: onRefresh,
		                    style: {
		                      padding: "3px 10px",
		                      border: "1px solid var(--dsw-alias-border-l2)",
		                      borderRadius: 6,
		                      background: "transparent",
		                      color: "inherit",
		                      font: "inherit",
		                      fontSize: 12,
		                      cursor: refreshing ? "default" : "pointer"
		                    },
		                    children: refreshing ? t("refreshing") : t("refresh")
		                  }
		                )
		              ] })
		            ]
		          }
		        ) : null
		      ]
		    }
		  );
		}
		function DetailBody({ view, snapshot, nowMs, t }) {
		  const { data, leading } = view;
		  const status = statusText(data, t);
		  const windows = [leading.fiveHour, leading.sevenDay].filter((window2) => window2 !== void 0);
		  const plan = planLabel(t, data.plan.tier);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { "data-zenmux-quota-plan": "", children: [
		      data.plan.amountUsd === void 0 ? plan : t("detailPlan", { plan, price: formatUsd(data.plan.amountUsd) }),
		      data.plan.expiresAt === void 0 ? "" : ` · ${t("detailExpires", { date: formatDate(data.plan.expiresAt) })}`
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { "data-zenmux-quota-account": "", style: { color: status === void 0 ? void 0 : "var(--dsw-alias-state-warn-primary, #eab308)" }, children: [
		      t("statusLabel"),
		      ": ",
		      status ?? t("statusHealthy")
		    ] }),
		    isBlockedStatus(data.accountStatus) ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("blockedNote") }) : null,
		    snapshot.stale === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "data-zenmux-quota-stale": "", children: snapshot.state === "rate-limited" ? t("rateLimited", { brand: t("brand") }) : t("staleNote") }) : null,
		    windows.map((window2) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WindowRow, { window: window2, nowMs, t }, window2.kind)),
		    data.monthly === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { "data-zenmux-quota-monthly": "", children: [
		      t("monthlyCap"),
		      ": ",
		      formatFlows(data.monthly.maxFlows),
		      " Flows (",
		      formatUsd(data.monthly.maxValueUsd),
		      ") — ",
		      t("monthlyNoRealtime")
		    ] }),
		    isRateRaised(data) ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "data-zenmux-quota-rate-raised": "", style: { color: "var(--dsw-alias-state-warn-primary, #eab308)" }, children: t("rateRaised", { effective: formatRate(data.effectiveUsdPerFlow ?? 0), base: formatRate(data.baseUsdPerFlow ?? 0) }) }) : data.effectiveUsdPerFlow === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("rate", { rate: formatRate(data.effectiveUsdPerFlow) }) }),
		    snapshot.receivedAtMs === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: t("detailUpdated", { time: formatRelative(snapshot.fetchedAt ?? snapshot.receivedAtMs, nowMs) }) })
		  ] });
		}

		// src/client/route-adapter.ts
		var TIERS = ["free", "pro", "max", "ultra", "unknown"];
		var STATUSES = ["healthy", "monitored", "abusive", "suspended", "banned", "unknown"];
		function isRecord(value) {
		  return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function num(value) {
		  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
		}
		function windowOf(value) {
		  if (!isRecord(value)) return void 0;
		  const usagePercentage = num(value["usagePercentage"]);
		  const maxFlows = num(value["maxFlows"]);
		  const usedFlows = num(value["usedFlows"]);
		  const remainingFlows = num(value["remainingFlows"]);
		  const usedValueUsd = num(value["usedValueUsd"]);
		  const maxValueUsd = num(value["maxValueUsd"]);
		  const rawReset = value["resetsAt"];
		  const resetsAt = rawReset === null ? null : num(rawReset);
		  if (usagePercentage === void 0 || maxFlows === void 0 || usedFlows === void 0 || remainingFlows === void 0 || usedValueUsd === void 0 || maxValueUsd === void 0 || resetsAt === void 0) return void 0;
		  return { usagePercentage, resetsAt, maxFlows, usedFlows, remainingFlows, usedValueUsd, maxValueUsd };
		}
		function dtoOf(value) {
		  if (!isRecord(value)) return void 0;
		  const fiveHour = windowOf(value["fiveHour"]);
		  const sevenDay = windowOf(value["sevenDay"]);
		  if (fiveHour === void 0 && sevenDay === void 0) return void 0;
		  const plan = isRecord(value["plan"]) ? value["plan"] : {};
		  const tier = TIERS.find((candidate) => candidate === plan["tier"]) ?? "unknown";
		  const amountUsd = num(plan["amountUsd"]);
		  const expiresAt = num(plan["expiresAt"]);
		  const accountStatus = STATUSES.find((candidate) => candidate === value["accountStatus"]) ?? "unknown";
		  const rawStatus = value["rawAccountStatus"];
		  const baseUsdPerFlow = num(value["baseUsdPerFlow"]);
		  const effectiveUsdPerFlow = num(value["effectiveUsdPerFlow"]);
		  const monthlyRaw = value["monthly"];
		  let monthly;
		  if (isRecord(monthlyRaw)) {
		    const maxFlows = num(monthlyRaw["maxFlows"]);
		    const maxValueUsd = num(monthlyRaw["maxValueUsd"]);
		    if (maxFlows !== void 0 && maxValueUsd !== void 0) monthly = { maxFlows, maxValueUsd };
		  }
		  return {
		    plan: {
		      tier,
		      ...amountUsd === void 0 ? {} : { amountUsd },
		      ...expiresAt === void 0 ? {} : { expiresAt }
		    },
		    accountStatus,
		    ...typeof rawStatus === "string" ? { rawAccountStatus: rawStatus.slice(0, 16) } : {},
		    ...baseUsdPerFlow === void 0 ? {} : { baseUsdPerFlow },
		    ...effectiveUsdPerFlow === void 0 ? {} : { effectiveUsdPerFlow },
		    ...fiveHour === void 0 ? {} : { fiveHour },
		    ...sevenDay === void 0 ? {} : { sevenDay },
		    ...monthly === void 0 ? {} : { monthly }
		  };
		}
		function readyOf(value) {
		  if (!isRecord(value) || value["state"] !== "ready") return void 0;
		  const data = dtoOf(value["data"]);
		  const fetchedAt = num(value["fetchedAt"]);
		  return data === void 0 || fetchedAt === void 0 ? void 0 : { data, fetchedAt };
		}
		function parseRouteResult(value) {
		  if (!isRecord(value)) return void 0;
		  const state = value["state"];
		  switch (state) {
		    case "ready": {
		      const ready = readyOf(value);
		      return ready === void 0 ? void 0 : { state: "ready", ...ready };
		    }
		    case "not-configured":
		    case "unauthorized":
		      return { state };
		    case "rate-limited":
		    case "upstream-error":
		    case "invalid-data": {
		      const retryAfterMs = num(value["retryAfterMs"]);
		      if (retryAfterMs === void 0) return void 0;
		      const staleRaw = value["stale"];
		      const stale = staleRaw === void 0 ? void 0 : readyOf(staleRaw);
		      if (staleRaw !== void 0 && stale === void 0) return void 0;
		      return { state, retryAfterMs, ...stale === void 0 ? {} : { stale } };
		    }
		    default:
		      return void 0;
		  }
		}
		function parseConfigView(value) {
		  if (!isRecord(value)) return void 0;
		  const { configured, providers, providerPattern, display } = value;
		  if (typeof configured !== "boolean" || !Array.isArray(providers) || typeof providerPattern !== "string") return void 0;
		  if (!providers.every((entry) => typeof entry === "string")) return void 0;
		  const mode = ZENMUX_DISPLAY_MODES.find((candidate) => candidate === display);
		  if (mode === void 0) return void 0;
		  return { configured, providers, providerPattern, display: mode };
		}

		// src/client/quota-store.ts
		var POLL_INTERVAL_MS = 6e4;
		var MIN_MANUAL_REFRESH_MS = 1e4;
		var FOREGROUND_REFETCH_MS = 3e4;
		var CONFIG_REFRESH_MS = 5 * 6e4;
		var CONFIG_RETRY_MS = 3e4;
		var REQUEST_TIMEOUT_MS = 2e4;
		var CLIENT_BACKOFF_MS = [6e4, 12e4, 3e5];
		var INVALID_DATA_DELAY_MS = 3e5;
		var STALE_MAX_AGE_MS = 5 * 6e4;
		var MIN_SERVER_RETRY_MS = 1e4;
		var ZenMuxQuotaStore = class {
		  state = { configStatus: "unknown", quota: { state: "idle" } };
		  listeners = /* @__PURE__ */ new Set();
		  fetchImpl;
		  now;
		  random;
		  timeoutMs;
		  retainers = 0;
		  generation = 0;
		  timer;
		  controller;
		  configController;
		  lastRequestAt = Number.NEGATIVE_INFINITY;
		  lastConfigAttemptAt = Number.NEGATIVE_INFINITY;
		  lastConfigAt = Number.NEGATIVE_INFINITY;
		  failureCount = 0;
		  configMissing = false;
		  disposed = false;
		  onVisibility = () => {
		    this.handleVisibility();
		  };
		  constructor(options = {}) {
		    this.fetchImpl = options.fetch;
		    this.now = options.now ?? Date.now;
		    this.random = options.random ?? Math.random;
		    this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
		  }
		  /** `useSyncExternalStore` subscribe. */
		  subscribe = (listener) => {
		    this.listeners.add(listener);
		    return () => {
		      this.listeners.delete(listener);
		    };
		  };
		  /** `useSyncExternalStore` snapshot; identity changes only on real change. */
		  getSnapshot = () => this.state;
		  /**
		   * Load the Host config if it is missing or old. Cheap and idempotent: every
		   * mounted indicator calls it, and only one request is ever in flight.
		   */
		  ensureConfig() {
		    if (this.disposed || this.configController !== void 0) return;
		    if (this.configMissing) return;
		    const now = this.now();
		    if (this.state.config !== void 0 && now - this.lastConfigAt < CONFIG_REFRESH_MS) return;
		    if (now - this.lastConfigAttemptAt < CONFIG_RETRY_MS) return;
		    this.lastConfigAttemptAt = now;
		    void this.loadConfig();
		  }
		  /**
		   * Keep data fresh while a ZenMux model is selected.
		   * @returns the release function; call it exactly once.
		   */
		  retain() {
		    if (this.disposed) return () => {
		    };
		    this.retainers += 1;
		    if (this.retainers === 1) this.start();
		    let released = false;
		    return () => {
		      if (released) return;
		      released = true;
		      this.retainers -= 1;
		      if (this.retainers === 0) this.stop();
		    };
		  }
		  /** Manual refresh: a forced Host refresh, throttled to once per 10 seconds. */
		  refresh() {
		    if (this.disposed || this.controller !== void 0) return;
		    if (this.now() - this.lastRequestAt < MIN_MANUAL_REFRESH_MS) return;
		    this.clearTimer();
		    void this.request(true);
		  }
		  /** Tear everything down; late responses can no longer write. */
		  dispose() {
		    this.disposed = true;
		    this.generation += 1;
		    this.clearTimer();
		    this.controller?.abort();
		    this.configController?.abort();
		    this.controller = void 0;
		    this.configController = void 0;
		    this.listeners.clear();
		    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
		  }
		  publish(next) {
		    if (this.disposed) return;
		    this.state = { ...this.state, ...next };
		    for (const listener of [...this.listeners]) listener();
		  }
		  hidden() {
		    return typeof document !== "undefined" && document.visibilityState === "hidden";
		  }
		  clearTimer() {
		    if (this.timer !== void 0) clearTimeout(this.timer);
		    this.timer = void 0;
		  }
		  /**
		   * Arm the one poll timer.
		   * @param delayMs - delay until the next request.
		   * @param forced - ask the Host to bypass its TTL cache (used right after a
		   * window reset, when the cached answer is known to be out of date).
		   */
		  schedule(delayMs, forced = false) {
		    this.clearTimer();
		    if (this.disposed || this.retainers === 0 || this.hidden()) return;
		    this.timer = setTimeout(() => {
		      this.timer = void 0;
		      void this.request(forced);
		    }, Math.max(0, delayMs));
		  }
		  start() {
		    this.generation += 1;
		    if (this.hidden()) return;
		    const elapsed = this.now() - this.lastRequestAt;
		    if (this.state.quota.state === "ready" && elapsed < FOREGROUND_REFETCH_MS) {
		      this.schedule(POLL_INTERVAL_MS - elapsed);
		      return;
		    }
		    void this.request(false);
		  }
		  stop() {
		    this.generation += 1;
		    this.clearTimer();
		    this.controller?.abort();
		    this.controller = void 0;
		  }
		  handleVisibility() {
		    if (this.disposed || this.retainers === 0) return;
		    if (this.hidden()) {
		      this.clearTimer();
		      return;
		    }
		    this.ensureConfig();
		    const halted = this.state.quota.state === "route-missing";
		    if (halted || this.controller !== void 0) return;
		    const elapsed = this.now() - this.lastRequestAt;
		    if (elapsed >= FOREGROUND_REFETCH_MS) void this.request(false);
		    else if (this.timer === void 0) this.schedule(POLL_INTERVAL_MS - elapsed);
		  }
		  async fetchJson(url, signal) {
		    const doFetch = this.fetchImpl ?? globalThis.fetch.bind(globalThis);
		    const local = new AbortController();
		    const onAbort = () => {
		      local.abort();
		    };
		    signal.addEventListener("abort", onAbort);
		    const timer = setTimeout(onAbort, this.timeoutMs);
		    try {
		      const response = await doFetch(url, {
		        method: "GET",
		        credentials: "same-origin",
		        cache: "no-store",
		        headers: { accept: "application/json" },
		        signal: local.signal
		      });
		      if (response.status === 404) return { kind: "missing" };
		      if (response.status === 403) return { kind: "forbidden" };
		      if (!response.ok) return { kind: "failed" };
		      return { kind: "json", value: await response.json().catch(() => void 0) };
		    } catch {
		      return { kind: "failed" };
		    } finally {
		      clearTimeout(timer);
		      signal.removeEventListener("abort", onAbort);
		    }
		  }
		  async loadConfig() {
		    const controller = new AbortController();
		    this.configController = controller;
		    this.publish({ configStatus: this.state.config === void 0 ? "loading" : this.state.configStatus });
		    const outcome = await this.fetchJson(ZENMUX_QUOTA_CONFIG_PATH, controller.signal);
		    if (this.disposed || this.configController !== controller) return;
		    this.configController = void 0;
		    if (outcome.kind === "json") {
		      const config = parseConfigView(outcome.value);
		      if (config !== void 0) {
		        this.lastConfigAt = this.now();
		        this.configMissing = false;
		        this.publish({ config, configStatus: "ready" });
		        return;
		      }
		    }
		    if (outcome.kind === "missing") {
		      this.configMissing = true;
		      console.warn("[dsh-zenmux-quota] host routes are missing; is the dsh-zenmux-quota host plugin enabled?");
		    }
		    this.publish({ configStatus: this.state.config === void 0 ? "unavailable" : "ready" });
		  }
		  async request(refresh) {
		    if (this.disposed || this.controller !== void 0) return;
		    const controller = new AbortController();
		    this.controller = controller;
		    const generation = this.generation;
		    this.lastRequestAt = this.now();
		    if (this.state.quota.data === void 0) this.publish({ quota: { state: "loading" } });
		    const url = refresh ? `${ZENMUX_QUOTA_SUBSCRIPTION_PATH}?refresh=1` : ZENMUX_QUOTA_SUBSCRIPTION_PATH;
		    const outcome = await this.fetchJson(url, controller.signal);
		    if (this.disposed || generation !== this.generation || this.controller !== controller) return;
		    this.controller = void 0;
		    const now = this.now();
		    if (outcome.kind === "missing") {
		      this.publish({ quota: { state: "route-missing" } });
		      return;
		    }
		    if (outcome.kind === "forbidden") {
		      this.publish({ quota: { state: "forbidden" } });
		      return;
		    }
		    const result = outcome.kind === "json" ? parseRouteResult(outcome.value) : void 0;
		    if (outcome.kind === "failed") {
		      this.failureCount += 1;
		      this.publish({ quota: this.degraded("upstream-error", now) });
		      this.schedule(this.clientBackoff());
		      return;
		    }
		    if (result === void 0) {
		      this.publish({ quota: this.degraded("invalid-data", now) });
		      this.schedule(INVALID_DATA_DELAY_MS);
		      return;
		    }
		    switch (result.state) {
		      case "ready":
		        this.failureCount = 0;
		        this.publish({ quota: { state: "ready", data: result.data, fetchedAt: result.fetchedAt, receivedAtMs: now } });
		        this.scheduleAfterReady(result.data, now);
		        return;
		      case "not-configured":
		      case "unauthorized":
		        this.failureCount = 0;
		        this.publish({ quota: { state: result.state, receivedAtMs: now } });
		        return;
		      case "rate-limited":
		      case "upstream-error":
		      case "invalid-data":
		        this.publish({
		          quota: {
		            state: result.state,
		            receivedAtMs: now,
		            ...result.stale === void 0 ? {} : { data: result.stale.data, fetchedAt: result.stale.fetchedAt, stale: true }
		          }
		        });
		        this.schedule(Math.max(result.retryAfterMs, MIN_SERVER_RETRY_MS));
		        return;
		    }
		  }
		  /**
		   * Next poll after a good answer: the regular interval, or a forced refresh
		   * just after the earliest window reset when that comes sooner. The 10 s floor
		   * matches the Host's forced-refresh floor, so the request is never wasted.
		   */
		  scheduleAfterReady(data, now) {
		    const untilReset = nextResetDelay(data, now);
		    if (untilReset !== void 0 && untilReset < POLL_INTERVAL_MS) {
		      this.schedule(Math.max(untilReset, MIN_MANUAL_REFRESH_MS), true);
		      return;
		    }
		    this.schedule(POLL_INTERVAL_MS);
		  }
		  /** A failure snapshot that keeps the previous data (marked stale) if any. */
		  degraded(state, now) {
		    const previous = this.state.quota;
		    const usable = previous.data !== void 0 && previous.fetchedAt !== void 0 && now - previous.fetchedAt <= STALE_MAX_AGE_MS;
		    return !usable || previous.data === void 0 ? { state, receivedAtMs: now } : {
		      state,
		      receivedAtMs: now,
		      data: previous.data,
		      stale: true,
		      ...previous.fetchedAt === void 0 ? {} : { fetchedAt: previous.fetchedAt }
		    };
		  }
		  clientBackoff() {
		    const base = CLIENT_BACKOFF_MS[Math.min(this.failureCount, CLIENT_BACKOFF_MS.length) - 1] ?? CLIENT_BACKOFF_MS[2];
		    return Math.round(base * (0.9 + this.random() * 0.2));
		  }
		};

		// src/client/locales.ts
		var en = {
		  brand: "ZenMux",
		  brandShort: "ZM",
		  planFree: "Free",
		  planPro: "Pro",
		  planMax: "Max",
		  planUltra: "Ultra",
		  planUnknown: "plan",
		  windowFiveHour: "5-hour window",
		  windowWeekly: "7-day window",
		  monthlyCap: "Monthly cap",
		  monthlyNoRealtime: "the API reports no real-time monthly usage",
		  summaryHead: "{brand} {plan}",
		  summaryWindow: "{period}: {percent}% left ({remaining} / {max} Flows)",
		  summaryOther: "{period}: {percent}% left",
		  resetIn: "resets {time}",
		  windowNotStarted: "window not started",
		  windowResetPending: "reset time has passed; figures shown are from before it and are being refreshed",
		  loading: "{brand} quota: loading",
		  loadingShort: "···",
		  notConfigured: "{brand} Management API key is not configured",
		  notConfiguredHint: "Create a Management API key in the ZenMux console and set it in the ZENMUX_MANAGEMENT_API_KEY environment variable, then restart dsh.",
		  unauthorized: "{brand} Management API key is invalid or not a Management key",
		  rateLimited: "{brand} quota endpoint is rate limited; it will update later",
		  upstreamError: "{brand} quota is temporarily unavailable",
		  invalidData: "{brand} quota response was not in a recognizable form",
		  forbidden: "This way of reaching dsh is not supported for {brand} quota",
		  routeMissing: "{brand} quota endpoint is unavailable. Check that the dsh-zenmux-quota host plugin is enabled.",
		  zeroCapacity: "{brand} plan includes no subscription quota",
		  noWindow: "{brand} quota window is not available",
		  unavailableShort: "—",
		  staleNote: "Showing the last known value",
		  statusMonitored: "Unusual usage detected; service remains available",
		  statusAbusive: "Abusive usage detected; restrictions applied",
		  statusSuspended: "Account suspended",
		  statusBanned: "Account banned",
		  statusUnknown: "Account status: {status}",
		  statusHealthy: "Normal",
		  statusLabel: "Status",
		  blockedNote: "The figures below are shown for reference; the quota is not usable.",
		  rateRaised: "Effective rate {effective} per Flow (base {base})",
		  rate: "Rate {rate} per Flow",
		  detailHeading: "ZenMux subscription",
		  detailPlan: "{plan} ({price}/month)",
		  detailExpires: "Renews or expires {date}",
		  detailRemaining: "{percent}% · {remaining} / {max} Flows ({remainingUsd} / {maxUsd})",
		  detailUpdated: "Updated {time}",
		  refresh: "Refresh",
		  refreshing: "Refreshing…",
		  openConsole: "Open console"
		};
		var zh = {
		  brand: "ZenMux",
		  brandShort: "ZM",
		  planFree: "Free",
		  planPro: "Pro",
		  planMax: "Max",
		  planUltra: "Ultra",
		  planUnknown: "套餐",
		  windowFiveHour: "5 小时窗口",
		  windowWeekly: "7 天窗口",
		  monthlyCap: "月度上限",
		  monthlyNoRealtime: "接口不提供月度实时用量",
		  summaryHead: "{brand} {plan}",
		  summaryWindow: "{period}剩余 {percent}%（{remaining} / {max} Flows）",
		  summaryOther: "{period}剩余 {percent}%",
		  resetIn: "{time}重置",
		  windowNotStarted: "尚未开始计时",
		  windowResetPending: "已过重置时间，以下为重置前的数值，正在更新",
		  loading: "{brand} 额度：加载中",
		  loadingShort: "···",
		  notConfigured: "{brand} Management API Key 未配置",
		  notConfiguredHint: "请在 ZenMux 控制台创建 Management API Key，设置到环境变量 ZENMUX_MANAGEMENT_API_KEY，然后重启 dsh。",
		  unauthorized: "{brand} Management API Key 无效，或不是 Management 类型",
		  rateLimited: "{brand} 额度接口被限流，稍后更新",
		  upstreamError: "{brand} 额度暂不可用",
		  invalidData: "{brand} 额度数据格式无法识别",
		  forbidden: "当前访问 dsh 的方式不支持 {brand} 额度",
		  routeMissing: "{brand} 额度接口不可用，请检查 dsh-zenmux-quota 主机插件是否已启用",
		  zeroCapacity: "{brand} 当前套餐无订阅额度",
		  noWindow: "{brand} 额度窗口不可用",
		  unavailableShort: "—",
		  staleNote: "显示的是最近一次的数值",
		  statusMonitored: "检测到用量异常，服务仍可用",
		  statusAbusive: "检测到滥用，已限制",
		  statusSuspended: "账号已暂停",
		  statusBanned: "账号已封禁",
		  statusUnknown: "账号状态：{status}",
		  statusHealthy: "正常",
		  statusLabel: "状态",
		  blockedNote: "以下数字仅供参考，当前额度不可用。",
		  rateRaised: "实际费率 {effective} / Flow（基础 {base}）",
		  rate: "费率 {rate} / Flow",
		  detailHeading: "ZenMux 订阅",
		  detailPlan: "{plan}（{price}/月）",
		  detailExpires: "订阅到期 {date}",
		  detailRemaining: "{percent}% · {remaining} / {max} Flows（{remainingUsd} / {maxUsd}）",
		  detailUpdated: "更新于 {time}",
		  refresh: "刷新",
		  refreshing: "刷新中…",
		  openConsole: "打开控制台"
		};

		// src/client/index.tsx
		var name = "dsh-zenmux-quota-client";
		var inject = ["slots", "locale"];
		var NAMESPACE = "zenmux.quota";
		function apply(ctx) {
		  try {
		    const quota = new ZenMuxQuotaStore();
		    ctx.effect(() => () => {
		      quota.dispose();
		    }, "dsh-zenmux-quota: quota store");
		    ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "dsh-zenmux-quota: composer copy");
		    ctx.inject(["slots", "modelDirectories"], (scope) => {
		      scope.slots.inject("conversation.input.right", () => scope.slots.register({
		        name: "conversation.input.right",
		        id: "zenmux-quota",
		        // Same order as the Codex and WorkBuddy indicators; each renders only for
		        // its own provider, so at most one is visible at a time.
		        order: 20,
		        locale: NAMESPACE,
		        inject: (sessionId) => ({
		          directory: scope.modelDirectories.directoryFor(sessionId).store,
		          quota
		        })
		      }, ZenMuxQuotaIndicator));
		    });
		  } catch (error) {
		    console.error("[dsh-zenmux-quota] composer indicator failed to load (model selection unaffected):", error);
		  }
		}
		return module.exports;
	}
});
