# Arena 当前执行状态

> 最后更新：2026-08-04。代码、测试、run manifest、JSONL 与 Runtime-Golden 优先于聊天记录。

## 当前阶段

W6/W7 的代码硬层已完成；Issue #1 继续承载生产验收，不重做架构。

固定优先级：正确性 → 可恢复性 → 可观测性 → 确定性收益 → 数据质量 → 模拟器真实性 → ML。

## 已完成事实

- TS SDK、schema、协议归一化和 53 项 SDK 测试；
- DecisionLease、deadline、Coordinator、Arbiter、Validator 与 Safety fallback；
- DeterministicPlanner：BFS 绕障、资源唯一分配、跨 Tick 记忆、回仓与容量裁决；
- t1–t4 历史 deterministic 真机窗口各 100 live submit，合计 400/400 accepted；
- Pi `createAgentSession` 原生嵌入，builtin=0，仅 `arena_plan` / `arena_map`；
- Pi circuit breaker：可配置阈值/冷却、open 快速 fallback、half-open 单探测、结构化 telemetry；
- `runTenant` 正常和异常共用幂等 cleanup stack，关闭 runtime、signal/IPC listener、client、recorder、JSONL writers，最后释放 lock；
- `TenantSupervisor` 全量 preflight 后才 spawn；重复 config/tenant、路径越界、缺 secret 均 0 spawn；
- 部分 spawn 失败会回收已经启动的 child；
- readiness 每次读取 writer lock，只有 lock PID == child PID 才 ready；
- Debug API 端口在 spawn 前绑定；端口冲突 0 spawn；
- `/health` 与 `/ready` 分离，JSONL 只读取末尾 256 KiB，并能跳过截断尾行；
- Windows 使用 IPC 优雅关单 + `taskkill /T /F` 超时升级；POSIX 使用独立进程组 + `SIGKILL`；
- Windows/Linux 真实 child+grandchild 黑盒均为 orphan=0；
- Python 实时 runtime、仓库级 `pyproject.toml` / `uv.lock` 和失效入口已退役；
- 服务器部署基线：不可变 release、外置 config/runtime、systemd cgroup、shadow readiness 有界自恢复、live `Restart=no`、无密钥 health env、独立磁盘告警不重启 writer、有限 JSONL 轮转；
- Digital Twin S0–S12 / P06 / P12 与首份 Runtime-Golden 已落地。

## 自动化证据

- SDK：53/53；
- arena-agent：490/490；
- Supervisor Windows：19/19；
- Linux Node 24 定向：86/86；
- schema：6；
- TS replay：100 records；
- simulator economy 10,000 Tick 与 movement 随机 10,000 cases invariant 通过。

测试数的唯一生成源是 `docs/generated/status.md`。

## 真机证据边界

### Deterministic

四租户历史报告均包含 startup sync、100 accepted submit 和 outcome drain；合计 400/400 accepted、0 rejected、0 repair。该事实不等于 Supervisor 四租户长期 soak 已完成。

### Pi shadow

2026-08-04 t1 30 Tick：27 candidate、2 soft deadline、1 cold-start error；216 valid actions、0 invalid。第 4 Tick后稳定延迟约 4.4–5.9 秒。该证据只证明 adapter/shadow 路径，不授权 hybrid/live。

### Runtime-Golden

首份数据集 run `26600fea-e8c7-45da-98e8-5a4bc03919f9`：3 cases、hard mismatch=0、unclassified=0、已触发 known deterministic events 6/6。它主要覆盖 movement/economy/visibility。

combat、第四 Tick Unit/Core 争抢、Beacon pickup/drop/death、Core destruction/respawn 仍需专项 Runtime-Golden。服务端私有 respawn placement、UUID、refill 与不可观测对手 Plan 必须继续标记 unknown/inconclusive。

## 明确关闭的路线

- Python 不是生产回滚路径；回滚使用稳定 TS commit/config + doctor/shadow/canary。
- per-tick LLM 不作为生产主线；低频 MacroPolicy 只能异步输出有限战略参数。
- live writer 自动重启关闭。SDK 默认幂等键包含随机值，跨进程 last accepted tick 恢复完成前，重启可能造成重复提交。
- 不为了路线图形式创建第二套 control plane、配置中心或进程框架。

## 尚未完成

1. Provider/Pi 真实 agent-shadow 故障注入与 circuit telemetry 证据；
2. 四租户 Supervisor 分级真机运行与长期 soak；
3. 稳定 TS commit/config 回滚演练；
4. combat、Core migration、Beacon、respawn 专项 Runtime-Golden；
5. 在目标服务器实际安装 systemd 单元并完成 shadow 长期运行、重启/磁盘告警演练；
6. 基于真实净收益决定是否允许单租户 hybrid canary。

## 生产晋级顺序

```text
doctor
→ deterministic shadow
→ 单租户 bounded deterministic live
→ 四租户逐个加入 Supervisor
→ 长期 soak
→ rollback drill
→ Pi shadow fault injection
→ 只有净收益与红线同时成立才考虑 hybrid canary
```

任何阶段出现 rejected submit、writer-lock 异常、跨租户污染、orphan、凭据泄漏或未分类 mismatch，都立即停止晋级。

## 标准门禁

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts
python scripts/gen-status.py --check
python scripts/docs_health.py --check
```
