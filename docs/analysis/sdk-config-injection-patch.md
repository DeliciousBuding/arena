# SDK 配置注入通道 — contestants.ts 变体接线（L-C patch，2026-08-09）

## 现状（v2 评测）
3 个变体条目（waaiging-agg / core-mil / farmer-eco）**无参数注入通道**，构造与
基座完全一致（仅 id 不同）——审计报告（bench-fairness-audit-2026-08-09）证明
它们是无效条目（同策略不同 id 的排名噪声高达 0.7 名量级）。

## 通道已落地（本次提交）
1. **SDK fork**（`reference/third-party/arena-hero-python-telemetry`，已 commit）：
   `config_overrides.py` —— `ARENA_CFG_*` 环境变量 + `arena-config.json` 文件双通道；
   `apply_config_overrides(instance=...)` 深合并（按现有类型转换、未知键跳过、
   静默降级）。`Turn.decision_ms` 决策耗时遥测。
2. **桥接线**（`scripts/opponent-bridge.py`）：agent 构造完成后调用
   `apply_config_overrides(instance=...)`，生效键打印 stderr；无 env = no-op。
3. **spawn env 透传**：`sync-bridge-worker.cjs`（spawn env）→ `sync-bridge.ts`
   （`SyncBridgeConfig.env` / `createReferenceBridge({env})`）→ `opponent-adapter.ts`
   （`PersistentReferenceConfig.env`）→ `registry.ts`（`opponentEntry(spec, seed, {env})`）。

## 端到端验证（探针，已跑）
2 玩家 300 tick 同 seed：默认 harvested=20/deposited=18 vs
`ARENA_CFG_WORKER_TARGET=6` harvested=14/deposited=13 —— **注入真实改变行为**；
无 env 时与基线一致（no-op 保证）。

## contestants.ts 变体接线 diff（总负责人收口时应用）

```diff
     pythonContestant(
       "waaiging-agg",
       "waaiging",
       "waaiging-agg（进攻变体）",
-      "降级：注册表 construct.kwargs=[] 且无 decide_kwargs；SmartTactic 仅接受 " +
-        "memory/control_path——无进攻参数可注入，entry 用默认构造",
+      "SDK 注入（config-injection）：ARENA_CFG_STRATEGY_AGGRO=0.8 进攻阈值（env 通道）",
+      // entry 需带 env：
+      //   entry: (seed) => opponentEntry(resolveOpponent("waaiging"), seed, {
+      //     id: `waaiging-agg-s${seed}`, desc: "waaiging-agg（进攻变体）",
+      //     env: { ARENA_CFG_STRATEGY_AGGRO: "0.8" },
+      //   }),
     ),
```

**注意**：SmartTactic 内部可覆盖字段需先静态确认（如 `strategy.aggro` 是否存在、
点分键是否可直达）——通道已支持点分键与未知键跳过，接线前用 1 场小探针验证
注入键确实改变行为（未知键会被跳过并打印 stderr 提示）。core/farmer 变体同理：

| 变体 | 建议注入 | 验证要点 |
|---|---|---|
| waaiging-agg | `ARENA_CFG_STRATEGY_AGGRO=0.8`（或等价进攻字段） | SmartTactic 属性路径 |
| core-mil | `ARENA_CFG_MODE=military`（若 plan_turn 支持）或 `ARENA_CFG_TARGET=50` | mode 枚举 |
| farmer-eco | `ARENA_CFG_WORKER_TARGET=8`（拉低 = 纯经济） | 已验证（harvested 差异） |

## 遗留
- contestants.ts 未接线（变体仍为降级默认）——上表 diff 应用后变体才真实差异化，
  届时重跑 v3 评测（v2 数据已含 3 无效条目噪声）。
- 内置条目（ts-aggressive/ts-safety）走桥同预算的改造属 v3 条目面工作（审计 §6.9）。
