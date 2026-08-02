# LIMITS — 限流与并发边界（协议契约 + 实测分析）

最后更新：2026-08-02（核对上游 commit ad6fc27 文档 + sdk 4a29585 源码）

## 协议层限制（权威契约）

| 限制 | 数值 | 触发后果 | 我们的余量 |
|---|---:|---|---|
| 每 `(player, tick, source)` 新提交 | 64 | `429 COMMAND_RATE_LIMITED`，保留最后有效计划 | 每 Tick 只提交 1 次 → 余量 64× |
| 每 `(player, credential kind)` 并发命令体 | 4 | `429 COMMAND_CONCURRENCY_LIMIT` + Retry-After: 1 | 单进程单提交 → 永不触发 |
| 每 Tick 每 source 的提交全部计入（含无效请求） | — | 无效请求也消耗 64 配额 | 计划经本地校验，无效请求极少 |
| WebSocket 入站帧 | 1024 字节 | 超限断连 | SDK 只发小帧，安全 |
| WebSocket 握手实时连接 | 部署配置（未公开） | `429 REALTIME_CONNECTION_LIMIT` + Retry-After: 1 | 每账号仅 1 连接 |
| 幂等 key | 8-128 可见 ASCII | 不合规拒绝 | SDK 自动生成 |

关键：**所有协议层限流都按 player（账号）隔离**——3 账号并行 = 3 份独立配额，互不消耗。

## SDK 内置保护（源码核对 _client_common.py）

- 429 响应：`max(1.0, Retry-After)` 延迟后重试
- WebSocket 断线：250ms → 5s 抖动指数退避自动重连
- 不确定的提交：相同字节 + 相同幂等 key 安全重试
- close code 1008（策略违规）：停止重连，抛 PolicyViolationError

## 多账号并行的实际风险

- **同 IP 限流**：协议无 IP 级条款（服务器内部实现未知）。实际请求频率：每账号 15 秒 1 次 HTTP 提交 + 1 条 WS 消息——远低于任何合理 IP 阈值。风险低，但不可从协议侧 100% 排除。
- **同账号多客户端**：战术脚本 + direct bridge 同时提交会互相替换计划（AGENT 槽唯一）——不是限流问题，是计划覆盖问题；多租户进程各自独立账号，无此问题。
- **并发命令体**：同一账号多个进程同时提交可能触发 CONCURRENCY_LIMIT——我们的设计每账号一进程，规避。

## 结论

3 账号并行安全。设计约束只有一条硬规则：**每账号同时只跑一个提交方**（进程级隔离天然满足）。
