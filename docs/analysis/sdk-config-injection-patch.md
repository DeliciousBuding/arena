# SDK 配置注入通道 — contestants.ts 变体接线（L-C patch，2026-08-09 定稿）

## 现状（v2 评测）
3 个变体条目（waaiging-agg / core-mil / farmer-eco）**无参数注入通道**，构造与
基座完全一致（仅 id 不同）——审计报告（bench-fairness-audit-2026-08-09）证明
它们是无效条目（同策略不同 id 的排名噪声高达 0.7 名量级）。

## 通道已落地（已 commit）
1. **SDK fork**（`reference/third-party/arena-hero-python-telemetry`）：
   - `config_overrides.py`：`ARENA_CFG_*` 环境变量 + `arena-config.json` 文件双通道；
     `apply_config_overrides(module=..., instance=...)` 深合并（按现有类型转换、
     点分键深钻、字典深合并、未知键跳过并一次性 stderr 提示、损坏静默降级）；
     `overridden_decide_kwargs(base, overrides)` 合并 decide 函数参数（core 用）。
   - telemetry-v2：`tick_summary` 补 `state_bytes`/`parse_ms`/`prev_decision_ms`；
     `Turn.decision_ms` 只读属性（首读 plan 计时）。向后兼容。
   - 全量 98 tests passed；README 有通道文档。
2. **桥接线**（`scripts/opponent-bridge.py`，已在 main）：agent 构造完成后调用
   `apply_config_overrides(instance=...)`，生效键打印 stderr；无 env = no-op。
3. **spawn env 透传**（已在 main）：`sync-bridge-worker.cjs`（spawn env）→
   `sync-bridge.ts`（`SyncBridgeConfig.env` / `createReferenceBridge({env})`）→
   `opponent-adapter.ts`（`PersistentReferenceConfig.env`）→ `registry.ts`
   （`opponentEntry(spec, seed, {env})`）。

**桥接缺口（core-mil 依赖）**：桥接目前只接 `apply_config_overrides`，core 的
`decide_kwargs`（mode/target 是 plan_turn 函数参数，不是实例/模块属性）未合并。
接线时需要：`decide_kwargs = overridden_decide_kwargs(base, config)` 后传给
plan_turn（探针 `probes/probe_tool.py` 的 `BuiltAgent` 里有完整示例）。

## 端到端验证（探针，已跑，证据如下）

同 seed（1）× 500 ticks × 6 玩家（mine + http 变体 + 4 内置基座）synthetic 场景，
基线（无 env）vs 注入（env 通道），`data/probe-rec/<agent>/*.jsonl` 留存状态实录。

| 变体 | env 注入键 | replay 同序列 plan 差异 | 真局差异（均资源等） |
|---|---|---|---|
| waaiging-agg | `ARENA_CFG_MEMORY_MODE=aggress` `ARENA_CFG_AGGRESS_TARGET_VANGUARDS=10` `ARENA_CFG_AGGRESS_TARGET_RANGERS=12` `ARENA_CFG_AGGRESS_BASE_WORKERS=3` | **231/500** | 均资源 6.0→4.0；popPeak 9→12；HARVEST_SUCCEEDED 51→60；BEACON_HARVEST_BONUS 0→38；世界翻转（内置 waaiging 均资源 13→3） |
| core-mil | `ARENA_CFG_MODE=harvest` `ARENA_CFG_TARGET=30`（decide_kwargs 通道；harvest=默认 core 语义，control=mil 语义） | 1/500（场景资源峰值<30，harvest 早停不触发；`TARGET=8` 时 119/500） | 均资源 9.0→19.0，harvest 版胜出 |
| farmer-eco | `ARENA_CFG_WORKER_TARGET=16` `ARENA_CFG_CORE_RESOURCE_RESERVE=5` `ARENA_CFG_EARLY_DEFENSE_RESERVE=10` | **142/500** | 均资源 23→12；popEnd 6→9；spawns W5→W7+V1；世界翻转（farmer 胜出） |

no-op 保证：无 env 时同序列 plan 逐字节一致（0/30 合成序列验证）。

**经验**（首轮探针踩坑，接线时注意）：
- waaiging 的 `AGGRESS_TARGET_*` 只在 aggress 模式生效，默认 `memory.mode=develop`
  → 只改 AGGRESS 常量 = 0 差异；必须连 `MEMORY_MODE=aggress` 一起注入（等价于它
  自带的 `load_control` 控制文件机制，走 SDK 通道不落盘、不改 agent 代码）。
- farmer 的 `WORKER_TARGET` 单独注入在资源匮乏场景 = 0 差异（spawn 被
  `CORE_RESOURCE_RESERVE` 卡住）；需连储备阈值一起拉低。
- core 的 mode 是 plan_turn 函数参数（走 `overridden_decide_kwargs`），
  `apply_config_overrides` 对模块/实例都打不进去（stderr 一次提示属预期）。

## 决策计时测量（SDK 侧开销占比，同序列 500 ticks 实况回放）

| agent | json_loads | pydantic | turn 构造 | plan dump | SDK 合计 | decide（策略） |
|---|---|---|---|---|---|---|
| waaiging | 0.023ms | 0.040ms | 0.013ms | 0.031ms | 0.108ms（7.3%） | 1.375ms（92.7%） |
| core | 0.021ms | 0.033ms | 0.013ms | 0.035ms | 0.103ms（13.1%） | 0.681ms（86.9%） |
| farmer | 0.022ms | 0.035ms | 0.013ms | 0.032ms | 0.102ms（14.4%） | 0.610ms（85.6%） |

**结论（Leader 裁决：SDK 侧 <15% 只做测量不做优化）**：决策周期大头是第三方
策略本身（decide 占 85-93%），SDK 侧 7-14%。唯一可无损优化点：桥接侧当前
`json.loads` + `model_validate` 双遍解析（0.04-0.06ms），可换 `model_validate_json`
单遍——属 L-A 桥接线改造，收益 <0.1ms/tick，建议不做（优先级低于评测主线）。

## contestants.ts 变体接线 diff（总负责人收口时应用）

```diff
      pythonContestant(
        "waaiging-agg",
        "waaiging",
        "waaiging-agg（进攻变体）",
-       "降级：注册表 construct.kwargs=[] 且无 decide_kwargs；SmartTactic 仅接受 " +
-         "memory/control_path——无进攻参数可注入，entry 用默认构造",
+       "SDK 注入（config-injection，2026-08-09 探针验证 231/500 plan 差异）：" +
+         "memory.mode=aggress + AGGRESS 目标放大（10/12/3）",
+       // entry 需带 env：
+       //   entry: (seed) => opponentEntry(resolveOpponent("waaiging"), seed, {
+       //     id: `waaiging-agg-s${seed}`, desc: "waaiging-agg（进攻变体）",
+       //     env: {
+       //       ARENA_CFG_MEMORY_MODE: "aggress",
+       //       ARENA_CFG_AGGRESS_TARGET_VANGUARDS: "10",
+       //       ARENA_CFG_AGGRESS_TARGET_RANGERS: "12",
+       //       ARENA_CFG_AGGRESS_BASE_WORKERS: "3",
+       //     },
+       //   }),
      ),
      pythonContestant(
        "core-mil",
        "core",
        "core-mil（军事变体）",
-       "降级：plan_turn(mode=control) 为桥接默认值，target=30 从未生效——与 " +
-         "core 默认条目完全同行为",
+       "SDK 注入（config-injection，decide_kwargs 通道，2026-08-09 探针验证）：" +
+         "mode=control（无限军事生产）",
+       // entry 需带 env：
+       //   entry: (seed) => opponentEntry(resolveOpponent("core"), seed, {
+       //     id: `core-mil-s${seed}`, desc: "core-mil（军事变体）",
+       //     env: { ARENA_CFG_MODE: "control" },
+       //   }),
      ),
```

> core 默认条目（harvest/target=30，configNote 声称的语义）在桥接默认 mode=control
> 下从未生效——**接线时同时给 core 默认条目注入** `ARENA_CFG_MODE=harvest` +
> `ARENA_CFG_TARGET=30`，让默认与 core-mil 真正分叉（探针：control=9.0 资源不赢 vs
> harvest=19.0 资源赢；`TARGET=8` 时 119/500 plan 差异）。
> **桥接前置**：opponent-bridge.py 需补 `overridden_decide_kwargs` 合并（见上）。

```diff
      pythonContestant(
        "farmer-eco",
        "farmer",
        "farmer-eco（纯经济变体）",
-       "降级：worker_target=12 为注册表默认值，CLI --worker-target 未接线——与 " +
-         "farmer 默认条目完全同行为",
+       "SDK 注入（config-injection，2026-08-09 探针验证 142/500 plan 差异）：" +
+         "worker_target=16（超默认 12）+ 储备阈值拉低（更早产兵）",
+       // entry 需带 env：
+       //   entry: (seed) => opponentEntry(resolveOpponent("farmer"), seed, {
+       //     id: `farmer-eco-s${seed}`, desc: "farmer-eco（纯经济变体）",
+       //     env: {
+       //       ARENA_CFG_WORKER_TARGET: "16",
+       //       ARENA_CFG_CORE_RESOURCE_RESERVE: "5",
+       //       ARENA_CFG_EARLY_DEFENSE_RESERVE: "10",
+       //     },
+       //   }),
      ),
```

## 遗留
- contestants.ts 未接线（变体仍为降级默认）——上表 diff 应用后变体才真实差异化，
  届时重跑 v3 评测（v2 数据已含 3 无效条目噪声）。
- 桥接 decide_kwargs 合并（core 变体前置）未在 main——补丁在
  `probes/probe_tool.py` 的 `BuiltAgent`（`overridden_decide_kwargs` 用法示例）。
- 内置条目（ts-aggressive/ts-safety）走桥同预算的改造属 v3 条目面工作（审计 §6.9）。
