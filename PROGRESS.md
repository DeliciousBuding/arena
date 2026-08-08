# PROGRESS — 任务书 E：v3→main 合并冲突解决（39 文件）

日期：2026-08-08
工作树：`arena-ts/.worktrees/tmp-reconcile-20260808`（分支 tmp/reconcile-20260808，HEAD=main f9b91fa）
merge-base = 3f3290c；merge 目标 production-runtime-v3 = eddb4f5。

## 分类策略总表（每文件一行）

### 类 1：vnext/swarm 文件 → 取 HEAD（先 diff 检查 v3 独有热修）

| 文件 | 状态 | 解决方式 | 理由 |
|------|------|---------|------|
| src/algorithms/min-cost-assignment.ts | AA | 取 HEAD | v3=旧 swarm 版缺生产回流注释，代码一致，HEAD 注释更全 |
| src/alliance/task-market.ts | AA | 取 HEAD | v3 仅删一行注释，功能一致 |
| src/alliance/local-fleet.ts | AA | 取 HEAD | v3=旧 swarm 版（LocalUnit 旧 API），HEAD=306105c 新契约 |
| src/alliance/director-policy.ts | UU | 取 HEAD | v3 缺 306105c 生产控制核回流，HEAD 超集 |
| src/alliance/runtime/central-shadow-runtime.ts | AA | 取 HEAD | v3 缺 strategic profile hot-switch（742c5c5），HEAD 超集 |
| src/alliance/runtime/shadow-policy-adapter.ts | AA | 取 HEAD | v3 缺 hot-switch；no-fire 在 HEAD 有等价实现（见备注） |
| src/sim/alliance/types.ts | UU | 取 HEAD | v3 仅删 taskForces 注释，功能一致 |
| src/intel/refill-predictions.ts | AA | 取 HEAD | v3 缺 P0 修复（d609326：3000 窗口 + avgAbsent SSOT），HEAD 超集 |
| src/planning/planning-snapshot.ts | UU | 取 HEAD | v3 删注释，功能一致 |
| src/planning/task.ts | UU | 取 HEAD | v3 删 freeze fix 注释，代码一致 |
| test/alliance-central-runtime.test.ts | AA | 取 HEAD | v3 少 72 行（hot-switch 测试缺失） |
| test/alliance-shadow-cli.test.ts | UU | 取 HEAD | HEAD 断言新战略 profile 行为；v3 独有 watchdog 断言视 watchdog 合并结果定 |
| test/local-fleet.test.ts | AA | 取 HEAD | v3 测旧 LocalUnit API，HEAD 测新契约 |
| test/min-cost-assignment.test.ts | AA | 取 HEAD | v3 旧 swarm 测试，HEAD 新 backport 测试 |
| test/refill-predictions.test.ts | AA | 取 HEAD | v3 少 27 行（P0 断言缺失） |

### 类 2：生产热修核心文件 → 双向合并（逐冲突块判断）

| 文件 | 冲突块 | 解决方式 | 理由 |
|------|--------|---------|------|
| src/strategies/safety-planner.ts | 31 | 双向合并 | v3：clearance/幽灵矿/ranger/巡逻转方位；HEAD：匈牙利/Hungarian 接线 |
| src/strategies/safety-planner-config.ts | - | 双向合并 | v3 独有 harvestMemoryFreshTicks 参数必须保留 |
| src/strategies/variant-registry.ts | - | 双向合并 | 必须 45 项（3 孤儿变体 + freshTicks 在案） |
| src/app/tenant-runtime.ts | - | 双向合并 | v3：command-plane；HEAD：central shadow |
| src/app/tenant-supervisor.ts | - | 双向合并 | v3：单租户自重启 ca679d2；HEAD：central shadow |
| src/cli/run-supervisor.ts | - | 双向合并 | v3：no-fire roster 通道；HEAD：hot-switch |
| src/app/debug-server.ts | - | 双向合并 | 待读块 |
| src/planning/deterministic-planner.ts | - | 双向合并 | RECOVERY 产兵同主题双实现→核对等价 |
| src/planning/mission-planner.ts | - | 双向合并 | v3：工人外出/ranger 打野风筝；HEAD：migration-scout |
| src/planning/worker-task-planner.ts | - | 双向合并 | v3：ranger 打野/风筝 da4c24f；HEAD：匈牙利 backport |
| src/domain/world.ts | - | 双向合并 | 待读块 |
| src/domain/nav.ts | - | 双向合并 | 远距 goto 同主题双实现→HEAD 为主核对 |
| scripts/arena-watchdog.sh | - | 双向合并 | v3：watchdog 枚举 f7d77eb + 单租户自重启 ca679d2 |

### 类 3：command-center → 优先 HEAD，v3 独有修复手工带入

| 文件 | 解决方式 | 理由 |
|------|---------|------|
| packages/command-center/lib/map.ts | HEAD 为主 + v3 幽灵矿过滤若在 | v3 仅同步合并提交，HEAD 领先 |
| packages/command-center/server.ts | HEAD 为主 | v3 有 command-plane（已由 HEAD 侧实现？需核对） |
| packages/command-center/web/scripts/cc-regression.mjs | modify/delete | 看 v3 改动内容定 |

### 类 4：测试文件 → 内容合并

| 文件 | 解决方式 |
|------|---------|
| test/supervisor.test.ts | 双向合并（v3 watchdog 枚举适配必须保留） |
| test/deterministic-planner.test.ts | 双向合并 |
| test/human-override.test.ts | 双向合并 |
| test/mission-planner.test.ts | 双向合并 |
| test/resource-routing.test.ts | 双向合并 |
| test/worker-patrol-no-core.test.ts | 双向合并 |

### 类 5：杂项

| 文件 | 解决方式 |
|------|---------|
| packages/arena-agent/package.json | diff 后合并两边独有项 |
| packages/arena-agent/scripts/core-migrate-driver.mts | 双向合并（v3 让位单步化 9fc107b 等） |

## 遗留（拿不准/待定）

（空）
