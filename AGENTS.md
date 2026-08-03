# AGENTS.md — Arena Hero 游戏接管项目

最后更新：2026-08-04

TS 编排层（arena-agent）已接管游戏接管主线；Python 运行时已于 2026-08-04 退役（`src/arena_bot/` 删除）。规则契约 **v0.11**（2026-08-02 changelog）。

> **迁移状态**：切片 4（真实 Pi Adapter）✅ 验收通过；切片 5（supervisor/debug API）✅ 完成；
> 切片 6（真机切换 + Python 删除）进行中——Python 运行链已删，单租户 TS live 验证中。
> 进度权威：`docs/migration-plan.md`。

## 项目目标（GOAL）

**攒 Core 资源 → 商店兑换公益站注册码**（30/50 资源一个，见 `docs/GOAL.md`）。
要点：
- 容量 = `max(10, 人口×5)`：攒 30 需人口≥4，攒 50 需人口≥8 —— **先扩人口再积累**
- 兑换需 Core 内资源 ≥ 价格，兑换动作用户在网页手动做，bot 攒到阈值提示
- **其他玩家会来攻打**：Core 被摧毁时库存归最高伤害者——资源越多越要守备（`guard_resources`/`guard_force`）
- 限流结论（`docs/LIMITS.md`）：4 账号并行安全，唯一硬规则是**每账号同时只跑一个提交方**
- 4 账号：delicious233 / buding / delicious23333 / deliciousbuding（互为盟友，绝不互攻）

## 结构速查（TS 主线）

| 路径 | 用途 |
|------|------|
| `packages/arena-hero-ts/` | TS SDK（wire schema 单源 + client/turn + contracts/ 契约产物） |
| `packages/arena-agent/src/domain/` | 领域层：state-reducer / world / plan-validator / phase-machine / nav |
| `packages/arena-agent/src/runtime/` | 决策核心：DecisionCoordinator / LeaseRegistry / loop.ts |
| `packages/arena-agent/src/strategies/` | 策略：safety-planner（确定性）/ deterministic |
| `packages/arena-agent/src/infrastructure/pi/` | 真实 Pi 决策桥（createAgentSession，仅 arena_plan/arena_map 工具） |
| `packages/arena-agent/src/app/` | 运行层：tenant-runtime / tenant-supervisor / debug-server / dotenv |
| `packages/arena-agent/src/cli/` | run-tenant（单租户）/ run-supervisor（四租户管家）/ run-sim / doctor |
| `packages/arena-agent/src/sim/` | Digital Twin 模拟器（15-phase 结算，含 combat/beacon/migration/respawn） |
| `runtime/configs/t1-4.json` | 租户配置（tenantId/token env 名/decisionMode/模型/deadlines） |
| `runtime/<tenant>/telemetry/` | runtime/decision/pi/outcome.jsonl（append-only） |
| `runtime/<tenant>/runs/<runId>/` | 每 run manifest + 产物 |
| `~/.secrets/arena.env` | 4 租户 Agent Token（仓外 secrets，public 化免疫；绝不入仓） |
| `reference/arena-hero-python/` | 官方 Python SDK 源码镜像（追上游对照，sync-log.md） |

## 命令

```bash
npx tsx packages/arena-agent/src/cli/run-tenant.ts --config=runtime/configs/t1.json --mode=deterministic --live --live-ticks=100   # 单租户真机 live（仓库根跑，缺省 repoRoot）
npx tsx packages/arena-agent/src/cli/run-tenant.ts --doctor --config=...      # 环境检查（只读）
npx tsx packages/arena-agent/src/cli/run-supervisor.ts --configs=t1,t2,t3,t4 --live --port=8120   # 四租户管家 + debug API
npx tsx --test "test/*.test.ts"      # TS 全测试（数量以 docs/generated/status.md 为准）
uv run python scripts/gen-status.py --check   # 状态门禁（CI 同款）
uv run python scripts/docs_health.py --check   # docs 健康门禁（CI 同款）
curl http://127.0.0.1:8120/health    # supervisor debug API（/health /state?tenant=t1 /events /tenants）
```

## 调试与人工介入

- supervisor debug API（`--port` 缺省 8120）：`GET /health`（租户存活）、`GET /state?tenant=t1`（最新决策）、`GET /events`
- 决策模式：`safety`（确定性兜底）/ `deterministic` / `agent-shadow`（LLM 只观察）/ `hybrid`
- 提交模式：`--live`（提交）/ `--shadow`（只观察，互斥）
- 阶段/参数：TS 侧由策略实现（SafetyPlanner 确定性）；`docs/ts-architecture.md` 权威

## 架构（TS 主线）

- 权威架构：`docs/ts-architecture.md`；迁移方案：`docs/migration-plan.md`（切片 1-5 ✅，6 进行中）
- 每 Tick：TickState → 决策核心（Safety 预计算 + deadline race + arbiter）→ validatePlan → submit
- 决策确定性：UUID 排序、固定轴优先、记忆只做线索、当前 Turn 永远权威
- 真实 LLM（agent-shadow）：PiAgentRuntime 生命周期机（warmup/abort/rotation），稳定期 4-6s/决策

## 红线

- 秘钥只在 `~/.secrets/arena.env`（或 .env 本地）；改代码后 grep 确认无 `ah_live` 字样
- 提交前自动拦截隐私内容：`scripts/hooks/pre-commit`（.env/密钥值/本机路径/个人邮箱/运行时产物，见 `scripts/hooks/README.md`）；clone/新 worktree 后先装 hook（`sh scripts/hooks/install-hooks.sh` 或复制 pre-commit 到对应 `.git/hooks/`）
- 不重建 SDK 的 WebSocket/重连/回执；协议异常先升 SDK
- 规则数值改动必须对照 `docs/game-rules.md`，禁止凭记忆猜
- 新功能一律走 TS 编排层；Python 运行链已退役，不复活
- 模拟器改动先跑 Digital Twin 验证（`packages/arena-agent/src/sim/`，策略改动秒级验证）再上线上
