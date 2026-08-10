# Network Resilience v1 — SDK 请求层综合设计（antibot / 轮询 / Cloudflare）

状态：2026-08-10 设计定稿（实现随本文档逐项落地）
范围：`arena-hero-ts`（生产唯一实现线）客户端请求层；`arena-hero-sdk-py`
fork 同步原则（能力注入统一在 SDK fork 层，第三方 agent 零感知）。

## 0. 现状与实测基线（2026-08-10）

| 项目 | 现状 |
|---|---|
| 事件流 | WebSocket `wss://api.arenahero.io/api/v1/game/ws`（服务端推 Tick，无客户端轮询） |
| 命令提交 | HTTP POST `/api/v1/game/commands`（Node `fetch`/undici） |
| UA | `arena-hero-ts/0.1.0`（显性 bot 指纹） |
| HTTP 重试 | `requestRetries=2`，退避 `min(0.1×2^n, 0.5)`，无抖动、无 Retry-After 尊重 |
| WS 重连 | `reconnectMinDelay=0.25 → max 5.0` 指数 + `jitter(0.8-1.2)` |
| WS 保活 | 无 ping 帧；`idleTimeoutMs=120000` 消息级兜底（2026-08-07 stall 修复） |
| Cloudflare | `api.arenahero.io` 在 CF 后（`server: cloudflare` + `cf-ray`），实测返回应用
  404 而非质询页——**当前无 JS/managed challenge**；curl 默认指纹可达 |

结论：当前"CF 绕过"的真实需求不是破解质询（质询未开），而是**不触发 CF 的
bot 评分/WAF/速率限制**（UA 指纹、请求节奏、429/403 处理）。设计目标 = 让
agent 请求与"正常在线游戏客户端"不可区分 + 被限时优雅退避不硬撞。

## 1. 设计原则

1. **防御性而非对抗性**：不做 TLS 指纹伪造（undici ja3 固定、Node 生态无成熟
   模拟器；硬刚质询 = 高风险），做 UA/头/节奏/退避的"不像 bot"。
2. **慢变量分层**：游戏事件天然 tick 节流（一次提交/tick），无需客户端额外
   轮询；重连/退避才是请求节奏主战场。
3. **CF 可观测**：命中质询/429 时遥测标记 + 冷却退避，**不狂撞**（狂撞 =
   触发 IP 封禁的最快路径）。
4. **降级零回归**：所有新参数带生产默认（= 现状行为），未配置不改行为。

## 2. 分项设计

### 2.1 UA 指纹（antibot 基础）

- 现状：`arena-hero-ts/0.1.0`——CF bot 评分直接给低分。
- 设计：`ClientOptions.userAgent` 可注入；默认改为浏览器式中性 UA
  （Chrome/Windows），WS 握手与 HTTP 统一携带。**不做**每次请求随机 UA
  （随机 = 更高阶 bot 特征）。
- 生效：HTTP fetch headers + `ws` 握手 headers。

### 2.2 HTTP 命令提交（频率与重试）

- 现状：每 tick 1 次 POST（天然低频）；失败重试 2 次、退避上限 0.5s。
- 设计：
  - **Full jitter 退避**（AWS 推荐算法）：`delay = random(0, min(maxDelay, base×2^n))`，
    上限 `retryMaxDelayMs=2000`——重试风暴概率低，多租户天然错峰。
  - **Retry-After 尊重**：429 响应头 `retry-after`（秒/HTTP-date）存在时，退避
    到该时刻，不指数递增。
  - **CF 质询检测**：403 + `cf-mitigated` 头 / 响应体含 `cf-chl`/`challenge-platform`
    → 归类 `cf_challenge`，冷却 `cfChallengeCooldownMs=60000`，期间**不重试**，
    直接失败上抛（下一 tick 自然重试）；遥测 `status: "cf_challenge"`。
  - **403 非质询**（policy/权限）：不重试（现状已如此——403 走 `_classifyError`）。
  - **超时分级**：`requestTimeout=5s` 保持；重试仅限 TransportError/5xx/429。

### 2.3 WebSocket 保活与重连（"轮询"语义的落点）

- 现状：无 ping；空闲 120s 消息级兜底；重连 0.25→5s 指数 + 0.8-1.2 抖动。
- 设计：
  - **ping 保活**：连接建立后每 `wsPingIntervalMs=30_000` 发 `ws.ping()`（ws 包
    原生）；`pong` 超时 `wsPongTimeoutMs=10_000` 无响应 → 视为半开连接走重连
    （与 idleTimeout 互补：idle 管"服务端停推"，ping 管"网络层半开"）。
  - **重连 full jitter**：`delay = random(0, min(reconnectMaxDelay, base×2^n))`，
    成功连接后重置 base——多租户（t1-t4 同机）重连天然错峰，避免 4 个 WS
    同时撞 CF。
  - **错峰启动**：连接建立前 `jitter(0, 2s)` 随机偏移（首次连接也抖，防 4 租户
    启动同刻握手）。
  - 1008（policy violation）/1000（正常结束）语义不变。

### 2.4 遥测（network 事件扩展）

- 现有 telemetry 已有 `connection`（up/error）。扩展：
  - `submit` 事件：attempt 数、状态码、耗时 ms、退避 ms；
  - `connection` error 附加分类：`cf_challenge` / `rate_limited`(429) /
    `transport` / `protocol`；
  - 连续 N 次 `cf_challenge`（默认 5）→ 附加 `sustained` 标记（供 watchdog
    巡检告警，提示人工介入检查 IP 健康）。
- 数据出口：现 telemetry sink（runtime.jsonl / command-center）不动。

### 2.5 Cloudflare"绕过"的边界（诚实声明）

- **不实现**：质询破解（JS challenge 需真实浏览器引擎）、TLS 指纹伪造、
  IP 池轮换（无合规代理基础设施；2026-08-07 HTTP_PROXY TLS 失败教训）。
- **已实现**：质询检测 + 冷却 + 遥测（不硬撞 = 不加速封禁）；
  若未来 CF 真开质询：正确路径是人工浏览器验证或官方 SDK 更新，agent 侧
  只做"检测 + 降级告警"。

## 3. 参数表（ClientOptions 扩展，全部带默认 = 现状）

| 参数 | 默认 | 说明 |
|---|---|---|
| `userAgent` | 浏览器式 Chrome UA | WS + HTTP 统一 |
| `retryMaxDelayMs` | 2000 | 重试退避上限（原硬编码 0.5s） |
| `retryJitter` | "full" | full jitter 退避 |
| `cfChallengeCooldownMs` | 60000 | 质询冷却，期间不重试 |
| `wsPingIntervalMs` | 30000 | ping 保活间隔（0 = 关闭） |
| `wsPongTimeoutMs` | 10000 | pong 超时判定半开 |
| `connectStaggerMaxMs` | 2000 | 首连/重连错峰随机上限 |

## 4. 测试与验收

- client.test.ts：UA 注入（WS+HTTP 头断言）、Retry-After 尊重、CF 质询检测
  （403+cf-mitigated → 单次尝试不重试）、full jitter 区间断言、ping 间隔
  （fake ws 定时器）、429 退避上限。
- 门禁：`pnpm -r check` / `pnpm -r test` 全绿。
- 生产：v3 分支部署后观察 runtime.jsonl network 事件（无 429/cf_challenge
  即为健康基线）。

## 5. 落地顺序（PR 拆分）

1. P0：UA 注入 + full jitter + Retry-After（低风险，立即上生产）；
2. P1：CF 质询检测 + 冷却（行为只在异常路径，零回归）；
3. P1：WS ping 保活 + 错峰（异常路径，零回归）；
4. P2：遥测扩展 + watchdog 巡检标记。
