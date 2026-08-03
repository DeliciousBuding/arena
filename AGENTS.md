# AGENTS.md — Arena Hero 游戏接管项目

最后更新：2026-08-03

用官方 Python SDK 自动游玩 Arena Hero 的独立工作区（uv 管理）。规则契约 **v0.11**（2026-08-02 changelog），SDK **arena-hero 0.2.6**。

> **TS 迁移进行中**：主线是把 Python 运行时退役，改由 TS 编排层（arena-agent）直接嵌入 pi-coding-agent。
> - TS SDK：本仓库 `packages/arena-hero-ts/`（wire schema 单源；原 public fork 已合并入仓，追上游镜像在 `reference/arena-hero-python/`）
> - TS 编排层：本仓库 `packages/arena-agent/`（domain/ + runtime/loop.ts 最小闭环，已合并进 main）
> - Python 版继续跑 4 租户 burn-in 收集数据（供 TS 差分验证），不再加新功能
> - 迁移方案与进度：`docs/migration-plan.md`（W0 嵌入闸门 ✅ · W1 wire schema+Golden Replay ✅ · 最小闭环 ✅ · W4 决策桥 → W6 删 Python）

## 项目目标（GOAL）

**攒 Core 资源 → 商店兑换公益站注册码**（30/50 资源一个，见 `docs/GOAL.md`）。
要点：
- 容量 = `max(10, 人口×5)`：攒 30 需人口≥4，攒 50 需人口≥8 —— **先扩人口再积累**
- 兑换需 Core 内资源 ≥ 价格，兑换动作用户在网页手动做，bot 攒到阈值提示
- **其他玩家会来攻打**：Core 被摧毁时库存归最高伤害者——资源越多越要守备（`guard_resources`/`guard_force`）
- 限流结论（`docs/LIMITS.md`）：4 账号并行安全，唯一硬规则是**每账号同时只跑一个提交方**
- 4 账号：delicious233 / buding / delicious23333 / deliciousbuding（互为盟友，绝不互攻）

## 结构速查（Python 运行时，退役中）

| 路径 | 用途 |
|------|------|
| `src/arena_bot/run.py` | 调度器：YAML 实验定义 → 多租户进程（`--experiment`） |
| `src/arena_bot/main.py` | 主循环：连接 + 决策链路 + 调试端点 |
| `src/arena_bot/strategies/` | 策略注册表：`balance`（确定性）/ `llm`（LLM 指挥官） |
| `src/arena_bot/llm/` | LLM 桥：PiRpcBackend（进程自愈）、RULES 三变体、严格解析 |
| `src/arena_bot/map_store.py` | 共享地图（SQLite WAL）：障碍/盟友，4 进程协同测绘 |
| `src/arena_bot/debug_api.py` | 外部控制：/state /command /map/query（8123-8126 各租户） |
| `src/arena_bot/watchdog.py` | 停滞告警（alerts/*.jsonl） |
| `src/arena_bot/telemetry.py` | 遥测 JSONL（runs/<run_id>/telemetry/）+ evaluate.py 报告 |
| `tests/` | 无凭据 Python 测试（Fake TickState，零网络）；**数量以 `docs/generated/status.md` 为准** |
| `packages/arena-agent/` | TS 编排层（domain/ + runtime/loop.ts + strategies/，TS 迁移主线） |
| `packages/arena-hero-ts/` | TS SDK（wire schema 单源 + client/turn + contracts/ 契约产物） |
| `reference/arena-hero-python/` | 官方 Python SDK 源码镜像（追上游对照，sync-log.md） |
| `experiments/*.yaml` | 实验定义（租户/策略/参数覆盖） |
| `runs/<run_id>/` | 每实验运行产物：manifest.json + telemetry/ + raw-state/ |
| `.env` | API key（**已 gitignore，永不入仓**） |

## 命令

```bash
uv run python -m arena_bot.run --experiment exp-llm-4   # 4 账号 LLM 并发实验（legacy，见 experiments/README.md）
uv run pytest tests/ -q             # Python 测试；数量以 docs/generated/status.md 为准
uv run python -m arena_bot.evaluate --run <run_id>      # JSONL 评估报告
python scripts/sync_docs.py         # skill 文档 → docs/
python scripts/docs_health.py --check   # docs 健康门禁（CI 同款）
curl http://127.0.0.1:8123/state    # 调试端点：t1 状态快照
```

## 调试与人工介入

- 端点 `http://127.0.0.1:8123`：`GET /state`、`GET /strategies`、`POST /command`
- 指令白名单：`pause`（暂停提交=观察）、`resume`、`set_param {name,value}`、`set_phase {phase}`
- 阶段：early_expansion / balanced / military；参数：explore_radius、worker_target、pop_ceiling 等（config.py）

## 架构（TS 主线 + Python legacy）

- **权威架构**：TS 主线见 `docs/ts-architecture.md`；Python 退役参考见 `docs/ARCHITECTURE.md`
- Python 每 Tick：TickState → 事件→world → 阶段机 → Strategy.decide→Plan → apply_plan → submit
- 决策确定性：UUID 排序、固定轴优先、记忆只做线索、当前 Turn 永远权威
- Worker 意图状态机（PATROL/GO_HARVEST）跨 Tick；HARVEST_FAILED 格冷却 4 tick
- 策略接口可插拔：新策略继承 `Strategy` 实现 `decide()`

## TS 侧参考（迁移主线）

- SDK 事实：`arena-hero-ts`（wire schema 单源 → contracts/generated/*.schema.json；client/turn/协议）
- 编排层事实：本仓库 `packages/arena-agent/`（domain/ + runtime/loop.ts + strategies/safety-planner.ts）
- 测试：`npx tsx --test "test/*.test.ts"`（node --test 只能跑 12/21，勿用）

## 红线

- 秘钥只在 `.env`；改代码后 grep 确认无 `ah_live` 字样
- 不重建 SDK 的 WebSocket/重连/回执；协议异常先升 SDK（`uv sync` 后对比测试）
- 规则数值改动必须对照 `docs/game-rules.md`，禁止凭记忆猜
- Python 侧只做数据收集/参考，新功能一律走 TS 编排层（避免双轨分裂）
