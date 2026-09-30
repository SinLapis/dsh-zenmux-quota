# dsh-zenmux-quota

在 DSH 对话输入框、模型选择器左侧显示 **ZenMux 订阅剩余额度**的条形进度条（与 `dsh-codex` 的额度条同一位置和尺寸）。悬停或键盘聚焦显示摘要，点击打开详情（5 小时 / 7 天窗口、月度上限、套餐、账号状态、费率、刷新）。

数据来自 ZenMux 的 [Get Subscription Detail](https://zenmux.ai/docs/api/platform/subscription-detail)。该接口只接受 **Management API Key**，所以本插件由 DSH 主机端代为请求，**Key 不会进入浏览器**。

## 安装

```powershell
# 从 GitHub 安装（仓库里提交了构建产物 lib/）
dsh plugin --profile web add github:SinLapis/dsh-zenmux-quota
# 开发期：链接本地目录
dsh plugin --profile web add link:D:\dsh\zenmux-bal\dsh-zenmux-quota
```

然后在 [ZenMux 控制台 Management](https://zenmux.ai/platform/management) 创建一把 Management Key（建议只给本插件用，泄露后可单独吊销），写入 `C:\Users\<you>\.dsh\.env`：

```text
ZENMUX_MANAGEMENT_API_KEY=...
```

重启 dsh，刷新页面。卸载：`dsh plugin --profile web remove dsh-zenmux-quota`。

## 配置（可选）

在自己 profile 的 `cordis.patch.yml` 中覆盖（均支持热更新）：

```yaml
- id: zenmux-quota
  config:
    providers: [zenmux-anthropic, zenmux-openai]  # 精确列出属于「订阅 Key」的 provider
    display: binding        # binding | five-hour | weekly | dual
    cacheTtlSeconds: 60     # 主机端缓存，最小 30
    managementKeyEnv: ZENMUX_MANAGEMENT_API_KEY
```

| 选项 | 说明 |
|---|---|
| `providers` | 非空时精确匹配 provider id；为空时用 `providerPattern`（默认 `^zenmux`，不区分大小写）。**订阅额度只约束订阅 API Key**：如果某个 `zenmux-*` provider 用的是按量付费（PAYG）Key，请不要把它列进来。 |
| `display` | `binding`（默认）显示 5 小时与 7 天中**剩余较少**的那个；`five-hour` / `weekly` 固定窗口，缺失时不会换成另一个；`dual` 上下两条细条。 |
| `baseURL` | 仅测试用；只接受 `https://zenmux.ai/...`，否则忽略，避免 Key 发往别处。 |

## 显示说明

- 三个额度（5 小时、7 天、月度）**同时生效**，任一用完都会被限流。月度只有上限、没有实时用量，所以只在详情里列出，不画条。
- 窗口 `resets_at` 为 `null` 表示尚未开始计时。重置时间已过时**仍显示原数值**（滚动窗口过了重置时间不代表额度全部恢复），标注「已过重置时间，正在更新」，并在重置后立即强制刷新一次。
- 未配置 Key、Key 无效、被限流、数据异常都用中性灰占位（`ZM ⚙` / `ZM !` / `ZM —`），不会画成红色空条冒充「额度耗尽」。限流或短暂故障时，最近 5 分钟内的旧值会继续显示并标注。
- 账号状态非 `healthy` 时，条旁有状态圆点；`suspended` / `banned` 时条变灰，数值仅供参考。
- 只支持 Web，且只接受本机（loopback）同源访问；远程域名或反向代理访问会得到 403。

## 请求频率

主机端对上游做 60 秒缓存、合并并发请求；手动刷新最少间隔 10 秒，且不会缩短任何退避期；422/429 按 `Retry-After`（至少 60 秒）加倍退避至 5 分钟，5xx/网络错误按 60/120/300 秒退避；403 不自动重试。页面隐藏时浏览器端暂停轮询，没人看就没有上游流量。所有请求日志只记状态分类、耗时和 `X-ZenMux-RequestId`，不记 Key 或响应体。

## 开发

```powershell
pnpm install
pnpm run check   # typecheck + vitest + build（lib/ 需提交，DSH 安装时需要 lib/client.js）
```

| 目录 | 内容 |
|---|---|
| `src/index.ts` | 主机端：Config、路由注册 |
| `src/parse.ts` | 上游响应白名单解析 |
| `src/upstream.ts` · `service.ts` · `routes.ts` | 上游客户端、缓存/合并/退避、路由与同源校验 |
| `src/client/` | 浏览器端：插槽注册、共享 store、纯函数视图、组件 |

设计依据与开发指南见 [docs/DEVELOPMENT_GUIDE.md](docs/DEVELOPMENT_GUIDE.md)。
