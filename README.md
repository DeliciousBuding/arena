# Arena Hero — 4 账号 LLM 自动游玩工作区

用官方 Python SDK（`arena-hero` 0.2.6）自动游玩 Arena Hero（规则 **v0.11**）：
**4 个账号并行**，每账号由 **LLM（pi → NewAPI → deepseek-v4-flash）逐 Tick 决策**，
确定性策略（balance）兜底。

**目标**：攒 Core 资源 → 商店兑换公益站注册码（30/50 资源；容量 = max(10, 人口×5)）。

## 架构

```
experiments/*.yaml ──▶ run.py（调度器：按实验定义 spawn 租户进程）
                            │
        ┌───────────────────┼───────────────────┐
      t1 进程             t2 进程            t3/t4 进程（同构）
        │ 每 15s 一个 Tick（游戏窗口）
        ├─ ArenaHeroClient 连接 + 提交
        ├─ LLMStrategy：pi RPC 长驻进程 ──▶ NewAPI ──▶ deepseek-v4-flash
        │    ├─ arena_plan 工具（原生 tool calling 提交计划）
        │    └─ arena_map 工具（HTTP 代理查共享地图）
        ├─ balance 兜底（LLM 超时/失败 → 确定性策略）
        ├─ Debug API（/state /command /map/query，外部控制）
        ├─ Watchdog（4 类停滞告警 → alerts/*.jsonl）
        └─ Telemetry（JSONL：全 Tick 遥测，outcome=submitted/paused/empty/tick_mismatch/error）
              │
        mapstore/arena_map.db（SQLite WAL，4 进程共享测绘：障碍/盟友）
```

> **TS 迁移进行中**：SDK 已 fork 为 TS 版（DeliciousBuding/arena-hero-ts，public），
> 编排层将重写为 TS 并直接嵌入 pi-coding-agent（RPC 桥消失）。当前 Python 版继续
> 稳定运行 4 租户 burn-in（数据收集，供 TS 侧差分验证）。方案见 [docs/migration-plan.md](docs/migration-plan.md)，
> 迁移进度：W0 嵌入闸门 ✅ · W1 wire schema+Golden Replay ✅ · TS 编排层最小闭环（loop）✅ · W4 决策桥 → W6 删 Python。

## 快速开始

```bash
uv sync                          # 装依赖（arena-hero 0.2.6）
# 秘钥：.env 设 ARENA_HERO_API_KEY_1..4（gitignore，永不入仓）
uv run pytest tests/ -q          # 135 例无凭据决策测试
uv run python -m arena_bot.run --experiment exp-llm-4   # 4 账号 LLM 并发实验
curl http://127.0.0.1:8123/state # 调试端点：t1 状态快照（8123-8126 各租户）
```

## 目录结构

| 路径 | 用途 |
|------|------|
| `src/arena_bot/run.py` | 调度器：YAML 实验定义 → 多租户进程（Ctrl-C 统一清理） |
| `src/arena_bot/tenant.py` | 单租户入口（CLI 参数 → 主循环） |
| `src/arena_bot/main.py` | 主循环：turns → 状态 → 决策 → 提交（409 容错） |
| `src/arena_bot/strategies/` | 策略注册表：`balance`（确定性）/ `llm`（LLM 指挥官） |
| `src/arena_bot/llm/` | LLM 桥：PiRpcBackend（进程自愈/总预算超时）、RULES 三变体、严格解析 |
| `src/arena_bot/map_store.py` | 共享地图（SQLite WAL）：障碍/盟友，4 进程协同测绘 |
| `src/arena_bot/debug_api.py` | 外部控制：/state /command /map/query |
| `src/arena_bot/watchdog.py` | 停滞告警（卡死/循环/经济停滞） |
| `src/arena_bot/telemetry.py` | 遥测 JSONL（每 Tick，runs/<run_id>/telemetry/）+ evaluate.py 报告 |
| `experiments/*.yaml` | 实验定义（租户/策略/参数覆盖） |
| `docs/` | 权威文档：规则/交接/架构/目标 |
| `scripts/pi_rpc_bridge.py` | LLM 桥离线验证（不烧游戏） |

## 策略

- **LLM 三变体**（`llm_rules` 参数，RULES 注入 prompt）：
  `standard`（平衡+巡逻探索）/ `aggressive`（军备优先）/ `economic`（种田积累）
- **决策链路**：原生 tool calling（arena_plan）→ 文本 JSON 兼容 → balance 兜底；
  瞬态失败指数退避重试；LLM 进程崩溃自动重启
- **地图**：LLM 可经 arena_map 工具查询共享地图（障碍/盟友/统计），按需调用
- **决策闭环**：上轮执行结果（采集成功/失败等事件）注入 prompt

## 规则版本与更新

当前 **v0.11**（2026-08-02）：未付 upkeep 改伤"多余单位"（Core 受保护）。
规则变更源：`docs/reference-changelog.md`（arena-hero-doc 仓库）。
**规则更新流程**：拉取 changelog → 更新 `docs/game-rules.md` → 检查 balance/LLM RULES 适配。

## 相关仓库

- 本仓库：arena（主工作区，4 账号自动游玩；Python 运行时退役中）
- arena-hero-ts：TS SDK（wire schema 单源，追官方 Python SDK 上游）
- arena-pr-verify：TS 编排层（arena-agent，PR 验证工作区）

## 文档索引

`docs/game-rules.md` 全量规则 · `docs/GOAL.md` 商店目标 · `docs/LIMITS.md` 限流分析 ·
`docs/handoff-pi-llm-bridge.md` LLM 桥交接 · `docs/ARCHITECTURE.md` 架构
