# DSH ZenMux 订阅额度插件开发指南

> 状态：**已按本指南实现**，代码即本仓库（包名 `dsh-zenmux-quota`），`pnpm run check` 通过（144 个测试）。尚未安装进真实 profile，也未在浏览器中做过目视验证。与指南的出入：详情浮层合并在 `ZenMuxQuotaIndicator.tsx` 内；新增 `src/client/route-adapter.ts` 做浏览器端校验；浏览器端不用 `AbortSignal.any`（部分内嵌浏览器没有）；review 后修复了换 Key 卡死、刷新绕过退避、`cacheTtlSeconds`/`baseURL` 热更新不生效、退避计数混用，并把"过重置时间显示 100%"改为保留原值并强制刷新；设置页保存 Key 和对话结束后刷新未做。
>
> 依据（本机静态核对，未发起真实请求，也未验证浏览器布局）：
> - ZenMux 文档 [Get Subscription Detail](https://zenmux.ai/docs/api/platform/subscription-detail) 与 [API Error Codes](https://zenmux.ai/docs/guide/advanced/error-codes.html)
> - `D:\dsh\dsh-bal\dsh-codex`：额度条 `src/client/OpenAICodexQuotaIndicator.tsx`、插槽注册 `src/client/index.tsx:85-103`、同源路由 `src/auth-routes.ts:439-470,788-836`
> - `D:\dsh\dsh-bal\dsh-workbuddy-quota`：已实现的同类插件（构建脚本、客户端 envelope、UI-only 清单），以及 `D:\dsh\dsh-bal\workbuddy-quota-plugin-design.md`
> - 本机 profile `C:\Users\SinLa\.dsh\profiles\desktop\cordis.patch.yml`：ZenMux 由 `llm-pi-ai` 自定义 provider `zenmux-anthropic` / `zenmux-openai` 接入
>
> 文中的默认值、路径、类型草图都是设计建议，不是现有接口。

---

## 1. 目标与范围

在对话输入框工具栏、**模型选择器左侧**，用与 Codex 相同的紧凑条形进度条显示当前 ZenMux 订阅剩余额度；悬停或键盘聚焦时显示明细。

**要做：**
- 当前会话的模型属于 ZenMux provider 时，显示 ZenMux 订阅额度条；否则隐藏，也不发请求。
- 主条显示**当前最紧的滚动窗口**（5 小时和 7 天两个窗口中剩余比例较低的那个），tooltip 同时列出两个窗口、月度上限、套餐和账号状态。
- 用 Node 端代理访问 Management API，**Management API Key 只放在 Host，不进入浏览器**。

**不做：**
- 不注册 LLM provider，不改模型、默认模型或发送行为，不拦截请求。
- 不估算"还能发几条消息"，不做充值、升级套餐入口（最多加一个打开控制台的链接）。
- 首期不做 PAYG 余额（`/management/payg/balance`）和 Flow Rate，只在第 11 节列为扩展。
- 首期只支持 Web；Desktop 等客户端加载和同源路由都验证过后再声明支持；不支持 TUI。

## 2. 为什么和 WorkBuddy 额度插件不一样

`dsh-workbuddy-quota` 只有客户端，因为 `dsh-workbuddy-connect` 已经在 Host 提供了带额度的同源 GET。**ZenMux 没有这样的现成路由**，而且：

1. 接口只认 **Management API Key**（在 [ZenMux 控制台 Management](https://zenmux.ai/platform/management) 创建）。普通 API Key 不能用，所以不能直接复用 `ZENMUX_ANTHROPIC_API_KEY` 这类模型调用 Key。
2. Management Key 权限很高（可以读用量、账单等），**不能下发给浏览器**，也不能让浏览器直接跨域调用 `zenmux.ai`。
3. 接口按分钟限流，超限返回 `422`。多个标签页、多个会话一起轮询时，需要由 Host 统一缓存和合并请求。

所以本插件是 **Host + Client 双端插件**：Host 负责拿 Key、调上游、校验和缓存；Client 只负责展示。

## 3. 上游接口要点

```http
GET https://zenmux.ai/api/v1/management/subscription/detail
Authorization: Bearer <ZENMUX_MANAGEMENT_API_KEY>
```

成功响应 `{ success: true, data: {...} }`，字段如下：

| 字段 | 含义 | 在插件中的用途 |
|---|---|---|
| `plan.tier` | `free` / `pro` / `max` / `ultra` | tooltip 显示套餐；未知值当作 `unknown`，不丢弃整份数据 |
| `plan.amount_usd`, `plan.interval` | 月费、周期（固定 `month`） | 仅详情展示 |
| `plan.expires_at` | 当前订阅周期到期时间（ISO 8601） | 详情显示"订阅到期"。**这不是额度重置时间** |
| `currency` | 固定 `usd` | 校验 |
| `base_usd_per_flow` / `effective_usd_per_flow` | 基础 / 实际每 Flow 单价 | effective > base 时提示"费率上调（检测到异常用量）" |
| `account_status` | `healthy` / `monitored` / `abusive` / `suspended` / `banned` | 非 healthy 时给主条加状态标记，详见 5.4 |
| `quota_5_hour` | 5 小时滚动窗口 | 主条候选 |
| `quota_7_day` | 7 天滚动窗口 | 主条候选 |
| `quota_monthly` | 月度上限：只有 `max_flows`、`max_value_usd`，**没有实时用量** | 只在详情中显示上限，**不能画进度条** |

窗口对象字段：`usage_percentage`（0 到 1，保留 4 位小数）、`resets_at`（ISO 或 `null`，`null` 表示窗口还没开始）、`max_flows`、`used_flows`、`remaining_flows`、`used_value_usd`、`max_value_usd`。

**三个窗口同时生效，任意一个用完都会被限流**。这就是主条应该显示"最紧窗口"，而不是像 Codex 那样按套餐固定选一个窗口的原因。

错误格式：`{ error: { code, type, message } }`。本插件需要区分：`403 access_denied`（Key 无效、类型不对或已吊销）、`422`（该端点限流）、`429`、`5xx`（可以退避重试）。`message` 只写日志（脱敏后），不原样显示给用户。

## 4. 总体架构

```text
┌──────────── Browser (client bundle) ────────────┐
│ conversation.input.right  (order 20)            │
│   ZenMuxQuotaIndicator                          │
│     ├─ 订阅 ModelDirectory.store → 当前 provider │
│     ├─ 订阅 ZenMuxQuotaStore（单例，共享轮询）   │
│     └─ quota-view 纯函数：选窗、百分比、颜色、文案│
└───────────────┬─────────────────────────────────┘
                │ same-origin GET（无 Key）
┌───────────────▼──────────── Host (Node) ────────┐
│ /plugins/dsh-zenmux-quota/config        廉价，不访问上游 │
│ /plugins/dsh-zenmux-quota/subscription  带 TTL 缓存与合并请求 │
│   ZenMuxSubscriptionService                     │
│     ├─ Key 解析（env / 设置）                    │
│     ├─ fetch + 超时 + 退避                       │
│     └─ parseSubscriptionDetail（白名单 DTO）     │
└───────────────┬─────────────────────────────────┘
                │ HTTPS + Bearer Management Key
         zenmux.ai/api/v1/management/subscription/detail
```

## 5. 展示设计

### 5.1 位置：沿用 Codex 的插槽

- 插槽：**`conversation.input.right`**。宿主工具栏的顺序是"right 插槽 → 模型选择器 → 上下文计量"，所以名字虽然叫 right，渲染出来就在模型选择器左边（见 `workbuddy-quota-plugin-design.md` 2.1 的核对结论）。
- `id: 'zenmux-quota'`，`order: 20`，与 `openai-codex-quota`、`workbuddy-quota` 相同。三者都只在自己的 provider 下渲染，同一时间最多显示一个。
- 不要用 `conversation.input.left` 或 `conversation.input.model`，也不要用 DOM 查询或 `MutationObserver` 硬插节点。

### 5.2 主视图

尺寸和颜色逐项沿用 `OpenAICodexQuotaIndicator.tsx:204-228, 386-456`：

| 项目 | 值 |
|---|---|
| 容器 | `inline-flex`，宽 48px，高 28px，`position: relative`，`tabIndex=0`，`role="status"` |
| 轨道 | 48×6px，`border-radius: 999px`，底色 `var(--dsw-alias-border-l2)` |
| 填充 | 宽度 = `clamp(remainingPercent, 0, 100)%` |
| 颜色（按剩余比例） | ≥60 绿 `var(--dsw-alias-state-success-primary,#22c55e)`；≥40 黄 `var(--dsw-alias-state-warn-primary,#eab308)`；≥20 橙 `#f97316`；其余红 `var(--dsw-alias-state-error-primary,#ef4444)` |
| Tooltip | 位置 `bottom: calc(100% + 6px)`，水平居中，背景 `var(--dsw-specific-tip,#1f2329)`，字号 12px，`pointer-events:none` |

```text
正常：         [━━━━━━━───] [ZenMux-Anthropic ▾]
5h 较紧：      [━━────────] [ZenMux-Anthropic ▾]   tooltip 标"5 小时窗口"
加载中：       [ ········ ]                        中性色骨架，不画 0%
未配置 Key：   [ ZM  ⚙ ]                          中性色，点开有配置说明
错误/过期：    [ ZM  — ]                          中性色，不用红色空条冒充耗尽
账号异常：     条形 + 右上角 4px 状态圆点（黄 monitored / 红 abusive·suspended·banned）
```

**不能只靠颜色表达状态**：`aria-label` 必须写全文，异常和未配置状态用文字或图形占位，不能只画一根灰条。

### 5.3 选择主窗口（纯函数 `selectLeadingWindow`）

```ts
type WindowKind = 'five-hour' | 'weekly'
interface WindowView {
  kind: WindowKind
  remainingPercent: number      // 0..100
  remainingFlows: number
  maxFlows: number
  resetsAt: number | null       // epoch ms
  notStarted: boolean           // resets_at === null
  resetElapsed: boolean         // resetsAt <= now：数据可能已过期
}
type Leading =
  | { available: true; window: WindowView; other?: WindowView; reason: 'binding' | 'forced' }
  | { available: false; reason: 'no-window' | 'zero-capacity' }
```

规则：
1. 先把每个窗口换算成 `remainingPercent`：
   - 优先用 `remaining_flows / max_flows * 100`，前提是 `max_flows > 0`，并且 `used + remaining ≈ max`（同时设绝对容差 0.01 和相对容差 0.5%）。
   - 不满足时回退到 `(1 - usage_percentage) * 100`。两种都算不出来，该窗口视为无效。
   - 两种算法差值大于 1 个百分点时，**以 flows 为准**，并在调试日志里记一次（不暴露给用户）。
2. `resets_at === null`：窗口还没开始，按剩余 100% 处理，tooltip 写"尚未开始计时"。
3. `resets_at` 已经过去：**保留上游报告的数值**，只标注"已过重置时间，正在更新"（`data-zenmux-quota-pending="reset"`）。滚动窗口的 `resets_at` 可能只表示最早一笔用量到期，不能据此推断额度全部恢复。浏览器端在最近一次重置时间后 2 秒（不早于 10 秒）发起一次强制刷新。
4. 默认 `display: 'binding'`：取两个有效窗口中 `remainingPercent` **较小**的；持平时优先 5 小时窗口（恢复更快，对用户更直接）。
5. 配置为 `'five-hour'` 或 `'weekly'` 时强制使用该窗口。该窗口缺失就返回 `available:false`，**不要偷偷换成另一个窗口**（与 Codex 的 `plan-window-missing` 语义一致）。
6. `max_flows === 0`（比如 free 或未订阅）：返回 `zero-capacity`，显示"当前套餐无订阅额度"，不画进度条。
7. `quota_monthly` 永远不参与选窗。

可选 `display: 'dual'`：在 48px 容器里上下叠两条 2px 细条（上 5h，下 7d），中间留 2px 间隙，总高仍为 6px。默认不开，只作为配置项。

### 5.4 账号状态

| `account_status` | 主视图 | 详情 |
|---|---|---|
| `healthy` | 正常 | 不显示 |
| `monitored` | 黄色圆点 | "检测到用量异常，服务仍可用"；effective > base 时另写"实际费率 X，基础费率 Y" |
| `abusive` | 红色圆点 | "检测到滥用，已限制" |
| `suspended` / `banned` | 条形改为中性灰，红点 | "账号已暂停 / 已封禁"。**额度数字仍然显示，但明确不可用** |
| 未知值 | 灰点 | 显示原始枚举（最多 16 个字符，纯文本） |

### 5.5 Tooltip 与详情

Hover/Focus tooltip 只放一行摘要（沿用 Codex 用 `·` 分隔的格式）：

```text
ZenMux Ultra · 5 小时剩余 92.8%（742.8 / 800 Flows）· 2 小时 13 分后重置 · 7 天剩余 93.3%
```

点击打开**可交互详情浮层**（与 tooltip 分开实现，`role="dialog"`，Esc 或点击外部关闭，触屏可用）：

```text
ZenMux 订阅 · Ultra（$200/月） · 到期 2026-04-12
状态  正常

5 小时窗口   ███████████████░  92.8%   742.8 / 800 Flows  ($24.39 / $26.27)
            重置：今天 16:35（2 小时 13 分后）
7 天窗口     ███████████████░  93.3%   5,765.9 / 6,182 Flows
            重置：3 月 26 日 10:15
月度上限     34,560 Flows ($1,134.33)   —— 接口不提供月度实时用量

费率 $0.03283 / Flow
更新于 12 秒前                      [刷新]  [打开 ZenMux 控制台 ↗]
```

- 数字统一用 `Intl.NumberFormat`：Flows 保留 1 位小数，USD 保留 2 位，百分比保留 1 位；小于 0.1 的正数显示 `<0.1`。
- 时间用本地时区；少于 24 小时显示相对时间 + 绝对时间，否则只显示日期和时间。
- "打开控制台"只链接固定常量 `https://zenmux.ai/platform/subscription`（或 `/platform`，实现时确认），加 `rel="noopener noreferrer"`。

### 5.6 状态矩阵

| 条件 | 主视图 | 请求行为 |
|---|---|---|
| directory 未 ready，或当前 provider 不是 ZenMux | 隐藏 | 不请求（config 已缓存则也不重复拉） |
| 首次加载 | 骨架 | 立即请求 |
| `ready` | 进度条 | 60 秒轮询 |
| `zero-capacity` | 文本"无订阅额度" | 300 秒轮询 |
| `not-configured`（Host 没有 Key） | `ZM ⚙` | 不轮询；进入设置或手动刷新时再试 |
| `unauthorized`（上游 403） | `ZM !`，"Management Key 无效或不是 Management 类型" | 停止轮询，手动重试 |
| `rate-limited`（422/429） | 如果有未过期的快照（≤ 5 分钟）就继续显示，并标"限流，稍后更新"；否则显示 `—` | 按 Host 返回的 `retryAfterMs` 退避 |
| `upstream-error`（5xx、超时、网络） | 同上 | 60 → 120 → 300 秒退避，加抖动 |
| `invalid-data`（校验失败） | `—`，"数据格式无法识别" | 300 秒 |
| 本插件路由 404 | 隐藏，`console.warn` 一次 | 不再轮询 |
| 路由 403（非受信 Origin） | `—`，"当前访问方式不受支持" | 不轮询 |

与 WorkBuddy 不同，ZenMux 一个 Host 只对应一把 Management Key，不存在"切账号后显示旧账号余额"的问题。因此**允许在限流或短暂故障时保留 5 分钟内的旧快照**，但必须标注更新时间。只有 Host 通过 `keyFingerprint` 报告换了 Key 时，才立即清空快照（见 6.4）。

## 6. Host 端设计

### 6.1 配置（schemastery）

```ts
export interface Config {
  /** 从哪个环境变量读取 Management Key（DSH 会加载 ~/.dsh/.env） */
  managementKeyEnv?: string          // 默认 'ZENMUX_MANAGEMENT_API_KEY'
  /** 精确列出属于 ZenMux 订阅的 provider id；为空时按 providerPattern 匹配 */
  providers?: string[]               // 默认 []
  /** providers 为空时使用的正则（不区分大小写） */
  providerPattern?: string           // 默认 '^zenmux'
  /** 主条显示哪个窗口 */
  display?: 'binding' | 'five-hour' | 'weekly' | 'dual'   // 默认 'binding'
  /** Host 端缓存 TTL（秒），下限 30 */
  cacheTtlSeconds?: number           // 默认 60
  /** 上游基础地址，仅用于测试；只允许 https 且 host 为 zenmux.ai */
  baseURL?: string                   // 默认 'https://zenmux.ai/api/v1'
}
```

- `display`、`providers`、`providerPattern` 标为 `.volatile()`，像 codex 那样通过 `loader/volatile-update` 热更新（参考 `dsh-codex/src/index.ts:255-310`）。
- **不要把 Key 本身写进 Config**，否则会以明文进入 `cordis.patch.yml`、设置导出和日志。Config 里只记环境变量名。

> **订阅 Key 与 PAYG Key：** 订阅额度只约束用**订阅 API Key** 发出的请求。如果某个 `zenmux-*` provider 用的是 PAYG Key，显示订阅额度会误导用户。README 中应说明：这种情况用 `providers` 明确只列出订阅 provider。插件没有办法从接口自动判断 Key 类型。

### 6.2 Key 来源

MVP 按以下顺序：
1. `process.env[managementKeyEnv]`（DSH 启动时会加载 `~/.dsh/.env`，与 `llm-pi-ai` 的 `apiKeyEnv` 机制一致）。
2. 都没有 → `not-configured`。

可选（第二阶段）：参考 `dsh-codex` 的 `settings.section`，加一个"ZenMux 额度"设置页，通过 `POST /plugins/dsh-zenmux-quota/key` 保存到 `~/.dsh/zenmux-quota.json`：
- Windows 上用 ACL 限制为当前用户，Unix 上权限 0600；
- 路由只允许 POST，并经过受信请求检查；
- 响应只返回 `configured: true` 和 fingerprint，**永远不回显 Key**。

每次请求前重新读取 env 或文件（开销很小），用户改了 Key 不需要重启。

Key 的 fingerprint：`sha256(key).slice(0, 8)`，只用于判断 Key 是否变更，不可逆，不含 Key 前缀。

### 6.3 上游客户端 `ZenMuxSubscriptionClient`

- 用全局 `fetch`，`AbortSignal.timeout(15_000)`，请求头 `Authorization`、`Accept: application/json`，**不带 cookie**，`redirect: 'error'`，避免重定向把 Key 带到别的主机。
- 代理：Node 自带的 fetch 默认不读 `HTTPS_PROXY`。首期在 README 中说明可以用 `NODE_USE_ENV_PROXY=1`（Node ≥ 24）；如果确实需要插件级代理，再参考 `dsh-codex/src/proxy.ts` 加 `proxyUrl`，首期不做。
- 响应体大小上限 64 KiB，超出按 `invalid-data` 处理。
- 响应头里的 `X-ZenMux-RequestId` 写进调试日志，方便用户联系支持。

### 6.4 解析与白名单 DTO（`parseSubscriptionDetail(unknown)`）

输入一律是 `unknown`，逐字段校验，禁止 `as` 强转整个对象：

```ts
interface QuotaWindowDTO {
  usagePercentage: number        // 0..1
  resetsAt: number | null        // epoch ms；非法日期 → 整个窗口无效
  maxFlows: number; usedFlows: number; remainingFlows: number
  usedValueUsd: number; maxValueUsd: number
}
interface SubscriptionDTO {
  plan: { tier: 'free'|'pro'|'max'|'ultra'|'unknown'; amountUsd?: number; expiresAt?: number }
  accountStatus: 'healthy'|'monitored'|'abusive'|'suspended'|'banned'|'unknown'
  rawAccountStatus?: string      // 仅 unknown 时保留，截断到 16 字符
  baseUsdPerFlow?: number; effectiveUsdPerFlow?: number
  fiveHour?: QuotaWindowDTO      // 缺失或无效时省略，不整份失败
  sevenDay?: QuotaWindowDTO
  monthly?: { maxFlows: number; maxValueUsd: number }
}
```

- 数字必须是有限数且 ≥ 0；不接受字符串数字和 `null`（`resets_at` 除外）。
- `success !== true` 或没有 `data` → `invalid-data`。
- 5h 和 7d **都**无效 → `invalid-data`；只有一个有效 → 仍然 `ready`，由客户端按 5.3 处理缺失。
- 未知 `tier` 或 `account_status` 降级为 `unknown`，不因此丢弃额度。

### 6.5 服务 `ZenMuxSubscriptionService`

```ts
type SubscriptionResult =
  | { state: 'ready'; data: SubscriptionDTO; fetchedAt: number; keyFingerprint: string }
  | { state: 'not-configured' }
  | { state: 'unauthorized'; keyFingerprint: string }
  | { state: 'rate-limited' | 'upstream-error' | 'invalid-data';
      retryAfterMs: number; stale?: Extract<SubscriptionResult,{state:'ready'}> }
```

- **合并请求**：同一时间只有一个上游请求，其他调用方 await 同一个 Promise；只复用**同一 Key 指纹**发起的请求，换 Key 时旧请求被丢弃。
- **TTL 缓存**：成功结果缓存 `cacheTtlSeconds`。浏览器带 `?refresh=1` 时，只要距离上次上游请求超过 10 秒就绕过 TTL 缓存（并允许重试 `unauthorized`），但**不会缩短**限流、上游错误、无效数据的退避期。
- **退避**：422/429 → `retryAfterMs = max(Retry-After, 60s)`，连续触发时翻倍（限流与上游错误分开计数），上限 5 分钟；5xx 和网络错误 → 60/120/300 秒加 ±10% 抖动；403 → 不自动重试，等 Key 指纹变化或手动刷新。
- 失败时，把最近一次 `ready`（≤ 5 分钟且 Key 指纹相同）作为 `stale` 返回。
- 发现 Key 指纹变化时立刻清空缓存和退避状态。
- `ctx.effect` 退出时中止进行中的请求，清空缓存。Host 端**不设定时器**，只有被请求时才拉取，页面没人看就没有上游流量。

### 6.6 路由

路径常量放在一个不依赖 Node 的文件 `src/paths.ts` 中，两端共用（参考 `dsh-codex/src/auth-paths.ts`）：

```ts
export const ZENMUX_QUOTA_CONFIG_PATH = '/plugins/dsh-zenmux-quota/config'
export const ZENMUX_QUOTA_SUBSCRIPTION_PATH = '/plugins/dsh-zenmux-quota/subscription'
```

用 `ctx.inject(['webServer'], …)` 加 `ctx.webServer.register({ kind: 'exact', path, handler })` 注册（同 `auth-routes.ts:826-836`）。

| 路由 | 方法 | 响应 |
|---|---|---|
| `config` | GET | `{ configured: boolean, providers: string[], providerPattern: string, display, keyFingerprint?: string }`，不访问上游 |
| `subscription` | GET，可带 `?refresh=1` | `SubscriptionResult`，HTTP 始终 200（业务状态放在 `state` 里）；只有路由级错误才用 403/405/500 |

安全要求：
- 非 GET → 405。
- **受信请求判断**照搬 `trustedRequestDecision` 的逻辑（`auth-routes.ts:439-470`）：拒绝 `Sec-Fetch-Site: cross-site`；`Origin` 存在时必须与 Host 完全同源；只默认信任 loopback 对端加 loopback Host。远程或反向代理访问首期一律 403，不提供可信 Origin 白名单（如果以后要支持，参考 codex 的 `trusted-origins.ts`）。
- 响应头：`Cache-Control: no-store`、`Content-Type: application/json; charset=utf-8`、`X-Content-Type-Options: nosniff`。
- 日志只记状态分类、耗时、RequestId；**不记 Key、Authorization、原始响应体**。

## 7. Client 端设计

### 7.1 注册（`src/client/index.tsx`）

直接套 `dsh-workbuddy-quota/src/client/index.tsx` 的骨架：

```ts
export const name = 'dsh-zenmux-quota-client'
export const inject = ['slots', 'locale']
export function apply(ctx) {
  try {
    const quota = new ZenMuxQuotaStore()
    ctx.effect(() => () => quota.dispose(), 'dsh-zenmux-quota: store')
    ctx.effect(() => ctx.locale.register('zenmux.quota', { zh, en }), 'dsh-zenmux-quota: copy')
    const t = ctx.locale.bind('zenmux.quota')
    ctx.inject(['slots', 'modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right', id: 'zenmux-quota', order: 20, locale: 'zenmux.quota',
        inject: (sessionId: string) => ({
          directory: scope.modelDirectories.directoryFor(sessionId as SessionId).store,
          quota,
        }),
      }, ZenMuxQuotaIndicator))
    })
  } catch (error) {
    console.error('[dsh-zenmux-quota] indicator failed to load (model selection unaffected):', error)
  }
}
```

注册过程用 try/catch 包住：宿主插槽 API 变化时只在控制台报错，不会让加载器弹出红色"Failed to load plugins"横幅。

### 7.2 是否显示（`isZenMuxSelection`）

```ts
state.status === 'ready' && current?.provider && matches(current.provider, config)
```

- `matches`：`config.providers` 非空时精确匹配 id；为空时用 `new RegExp(providerPattern, 'i')` 测试。正则编译失败就当作不匹配，并 `console.warn` 一次。
- 注意 `ModelDirectoryState.status` 在 `'selecting'` / `'loading'` 期间不是 ready。Codex 此时直接隐藏，会造成闪烁；建议**保留上一次的显示结果，直到 status 回到 ready**（用 `current` 已有值判断即可）。
- 只读 directory 状态，**不调用** `directory.select()` 或 `load()`。

### 7.3 共享 Store（`quota-store.ts`）

整个浏览器插件只有一个实例，所有会话的指示器共用：

- `subscribe(listener)` 和 `getSnapshot()` 符合 `useSyncExternalStore` 的要求，快照不可变、引用稳定。
- `acquire()` / `release()` 做订阅者计数：第一个可见的指示器触发首次拉取，最后一个离开时停止轮询并中止请求。
- `config` 在首次 `acquire` 时拉一次，之后每 5 分钟或窗口重新获得焦点时刷新。
- 调度：请求**结束后**才安排下一次（`setTimeout`，不用 `setInterval`），间隔取 `max(60s, retryAfterMs)`。
- `document.visibilitychange`：页面隐藏时暂停；重新可见时，距离上次成功超过 30 秒就立即拉取。
- 同时只有一个请求；每次生命周期变化 `generation += 1`，回调里先检查 generation 和是否已 dispose，再写入 state。
- 手动刷新 `refresh()`：加 `?refresh=1`，客户端 10 秒内最多一次。
- fetch 参数：`credentials: 'same-origin'`、`cache: 'no-store'`、`Accept: application/json`，客户端超时 20 秒（大于 Host 的 15 秒）。
- 404 → `route-missing` 且永久停止；403 → `forbidden`。

可选增强（非 MVP）：会话一轮对话结束后，延迟 3 秒触发一次 `refresh()`，更快反映本轮消耗。前提是先找到已验证的宿主事件，并且共用上面的节流逻辑，不能按 token 或工具调用触发。

### 7.4 纯函数模块（`quota-view.ts`）

以下函数都放在这里，便于单测：`remainingPercentOf(window, now)`、`selectLeadingWindow(dto, display, now)`、`quotaColor(percent)`、`formatFlows`、`formatUsd`、`formatPercent`、`formatResetAt(ms, now, locale)`、`statusBadge(accountStatus)`。组件内部不做任何数值计算。

组件每次渲染时根据当前时间重新计算 `resetElapsed`。另外设置一个 30 秒的 tick，只在显示相对时间的 tooltip 或详情打开时运行。

### 7.5 文案（`locales.ts`，zh/en）

至少需要以下 key：`brand`、`planFree|Pro|Max|Ultra|Unknown`、`windowFiveHour`、`windowWeekly`、`monthlyCap`、`monthlyNoRealtime`、`remaining`、`resetIn`、`resetAt`、`windowNotStarted`、`windowResetPending`、`summary`、`statusMonitored|Abusive|Suspended|Banned|Unknown`、`rateRaised`、`notConfigured`、`notConfiguredHint`（写明 env 变量名和控制台地址）、`unauthorized`、`rateLimited`、`upstreamError`、`invalidData`、`forbidden`、`zeroCapacity`、`updatedAgo`、`refresh`、`openConsole`、`stale`。

在 `declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `LocaleNamespaceMap` 中登记 `'zenmux.quota'`。

## 8. 工程结构

```text
dsh-zenmux-quota/
  package.json            exports: "." → lib/index.js, "./client" → lib/client.js
  cordis.patch.yml        只 insert 本插件，不带其他配置
  scripts/build.mjs       照搬 dsh-workbuddy-quota：用 esbuild 原生二进制，client 包在 __ModuleLoader__ 中
  src/
    index.ts              Host：Config schema、apply、注入 webServer
    paths.ts              两端共用的路由常量（不依赖 Node）
    key-source.ts         读 env/文件、fingerprint
    upstream.ts           ZenMuxSubscriptionClient
    parse.ts              parseSubscriptionDetail → SubscriptionDTO
    service.ts            合并请求、TTL、退避、stale
    routes.ts             注册路由、受信请求判断、JSON 输出
    client/
      index.tsx           注册
      ZenMuxQuotaIndicator.tsx
      QuotaDetailPopover.tsx
      quota-store.ts
      quota-view.ts
      locales.ts
  tests/                  见第 9 节
  tsconfig.json / tsconfig.client.json / vitest.config.ts
```

### 8.1 package.json 要点（在 workbuddy-quota 基础上修改）

- `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-model-selection", "@deepseek-ai/dsh-client-locale"], "platform": "web" } }`
- Host 端新增 peer：`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-host-webserver`（仅用于类型：`import type {} from '@deepseek-ai/dsh-host-webserver'`）。
- 构建 Host 时用 `--bundle --packages=external`，把 `src/*.ts` 打进 `lib/index.js`，依赖保持 external。workbuddy-quota 只有一个空 `apply`，所以没有打包，这里必须改。
- client 的 external 列表与 workbuddy-quota 相同（React、cordis、各 `dsh-client-*`）。**不能打进第二份 React。**
- 注意区分：清单 `dsh.client.inject` 填**包名**，运行时 `ctx.inject` 填**服务名**（`slots`、`modelDirectories`、`webServer`）。
- 版本范围对齐实际联调的 DSH（参考 workbuddy-quota：`^0.1.7-rc.2 || ^0.2.0-rc.1`），不要笼统写成兼容所有版本。

### 8.2 cordis.patch.yml

```yaml
- insert:
    - id: zenmux-quota
      name: dsh-zenmux-quota
```

需要改默认值时，用户在自己 profile 的 patch 里覆盖：

```yaml
- id: zenmux-quota
  config:
    providers: [zenmux-anthropic, zenmux-openai]
    display: binding
```

## 9. 测试清单（vitest + jsdom + @testing-library/react，fixture 全部是合成数据）

| 模块 | 必测场景 |
|---|---|
| `parse` | 文档示例原样通过；缺少 5h 或 7d 其中一个；两个都缺 → invalid；字符串数字、负数、NaN、非法 ISO；未知 tier/status 降级；`success:false`；超大响应体 |
| `quota-view` | flows 与 usage_percentage 一致和不一致；`max_flows=0`；`resets_at=null`；`resets_at` 已过；binding 选窗、持平选 5h；强制窗口缺失时不偷换；颜色边界 60/40/20；格式化小值 `<0.1` |
| `service` | 用假 fetch 和 fake timers：合并请求；TTL 命中；`refresh` 10 秒节流；422 带或不带 Retry-After 的退避；5xx 抖动退避；403 不重试；Key 指纹变化清空缓存；stale 只在 5 分钟内且 Key 相同时返回；dispose 时中止 |
| `upstream` | 请求头正确；`redirect:'error'`；15 秒超时；日志中不出现 Key（对 logger 输出断言） |
| `routes` | 405；cross-site → 403；Origin 不匹配 → 403；非 loopback → 403；响应中不出现 Key；`Cache-Control: no-store` |
| `quota-store` | 多个订阅者只有一个请求；最后一个 release 后停止；页面隐藏时暂停、可见时补拉；generation 防止旧响应写入；404 永久停止 |
| 组件 | 非 ZenMux provider 渲染 null；`selecting` 期间不闪烁；各状态的 `aria-label` 与 `data-zenmux-quota-*` 属性；Hover/Focus 出现 tooltip；详情 Esc 关闭；账号状态圆点；恶意 tier 字符串按纯文本渲染 |
| 打包 | `lib/client.js` 以 `window.__ModuleLoader__.load({` 开头；bundle 里不含 `react-dom` 源码；Host 入口能被 import 且导出 `name/apply/Config/inject` |

`data-*` 属性照 Codex 命名：`data-zenmux-quota={kind}`、`data-zenmux-quota-state`、`data-zenmux-quota-color`、`data-zenmux-quota-status`，供测试和用户 CSS 使用。

## 10. 构建、安装与验证

```powershell
pnpm install
pnpm run check            # typecheck + test + build
dsh plugin --profile web add link:D:\dsh\zenmux-bal\dsh-zenmux-quota
# 在 C:\Users\SinLa\.dsh\.env 中加一行：ZENMUX_MANAGEMENT_API_KEY=...
```

验证步骤（Host 插件有改动，需要重启 DSH，**然后刷新现有页面**；不要另起一个服务器就说当前页面已更新）：
1. 打开当前 DSH Web（本会话为 `http://127.0.0.1:19387`），检查 boot manifest 里有 `dsh-zenmux-quota` client，控制台没有加载错误或重复 React。
2. 在同一浏览器中 `GET /plugins/dsh-zenmux-quota/config`，确认 `configured:true` 并且没有 Key。
3. 切到 `zenmux-anthropic` 模型：模型选择器左侧出现额度条；切到 openai-codex：显示 Codex 自己的条，ZenMux 条消失；切到其他 provider：两个都不显示。
4. Hover、Tab 聚焦、点击详情、Esc 关闭；亮色和暗色主题；窄屏。
5. 删掉 Key 并刷新 → 显示 `ZM ⚙`；故意填错 Key → 显示 `unauthorized`，并确认 Host 日志中没有 Key。
6. 打开多个标签页，在 Host 侧确认上游请求频率 ≤ 每 TTL 一次。
7. 禁用或卸载插件后，控件消失，没有后台定时器残留。

## 11. 开发里程碑

1. **M0 骨架**：空 Host、静态占位条注册到插槽，确认位置和构建产物。
2. **M1 数据**：`parse`、`quota-view` 纯函数，先写 fixture 测试。
3. **M2 Host**：Key 来源、上游客户端、service、路由，加安全测试。
4. **M3 Client**：store、指示器、tooltip，打通真实数据。
5. **M4 完善**：详情浮层、账号状态、错误态、无障碍、主题。
6. **M5 交付**：README（包括 Management Key 的获取、订阅 Key 与 PAYG Key 的说明）、干净 profile 安装和卸载回归。
7. **扩展（可选）**：设置页保存 Key；详情里加 PAYG 余额（`/management/payg/balance`）；对话结束后刷新；Desktop 支持。

## 12. 风险与待确认

- **限流阈值未公开**（文档只写"平台级配置、超限 422"）。默认 60 秒 TTL 是保守估计，上线后按实际情况调整。
- 滚动窗口"只在请求后更新"，所以 `resets_at` 过去后显示的 100% 只是推断，文案必须写明"待确认"。
- 文档没有说明 `free` 套餐的具体返回（可能是全 0，也可能缺字段），由 `zero-capacity` 和 `invalid-data` 兜底，需要实测。
- provider 匹配依赖用户自定义 id（`zenmux-*`），默认正则可能误伤或漏掉，因此提供 `providers` 精确列表。
- Management Key 权限大于展示所需。README 应建议单独建一把只用于本插件的 Management Key，泄露后可以单独吊销。
- `conversation.input.right` 的"在模型选择器左侧"依赖宿主当前的布局顺序，宿主升级后需要复核（`dsh-client-ui-conversation` 的工具栏渲染）。
