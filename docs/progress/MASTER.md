# MASTER — Arena 项目进度总表

> 跟踪模式：LOCAL_ONLY（代码 + 文档 + git 为准）。最后更新：2026-08-03。
> 权威路线图：`docs/migration-plan.md`（切片 0-6）+ `docs/roadmap-long-term.md`（W7-W18）。

## 当前阶段：切片 4（真实 Pi Adapter + 真机开闸）

**主线优先级（Leader 裁决）**：正确性 → 可恢复性 → 可观测性 → 确定性算法收益 → 数据质量 → 模拟器 → ML → RL。

**执行链**：4D-pre（完成）→ Agent A/B/C/D 并行 → Leader tenant-runtime 集成 → 真机 Safety Canary。

## 切片 4 状态

| 项 | 状态 | 提交 |
|----|------|------|
| 3E 接口勘误（runId 单源/启动失败/SEL deadline） | ✅ | 20a5a5c |
| P0-2 跨 generation 竞态修复（15 测试） | ✅ | 9c6314a |
| P0-1 DecisionMode/SubmissionMode 拆分（execution/observation，5 新暗卷） | ✅ | 95b24ce |
| 运行入口（config/lock/manifest/doctor，11 测试） | ✅ | e601019 |
| 遥测（decision-trace/jsonl/schema，10 测试） | ✅ | 98ae0e0 |
| ResourcePlanner 骨架（13 测试） | ✅ | 6e3cbc3 |
| 4-preflight（CandidateSink 契约/status/依赖 pin/4C 修正） | ✅ | 63632d0/d6231e1/7aaae58 |
| 4A 会话工厂（6 测试） | ✅ | 7e61c5d |
| 4B 工具层（11 测试，slot + 严格解析） | ✅ | 764ebf1/11874cf |
| 4C prompt + StrategyMemory（11 测试） | ✅ | c0060f6/7aaae58 |
| 4D-pre 协议封口（slot/严格解析/source 统一/runId 格式） | ✅ | 11874cf |
| PiAgentRuntime stub 层（11 测试，生命周期/abort/rotation） | ✅ | 09cdada |
| PiAgentRuntime 真实嵌入冒烟（fake stream） | 🔄 待做（leader 地界） |
| Leader tenant-runtime 集成（锁/manifest/三流遥测/优雅关闭，6 暗卷） | ✅ | bf7c963 |
| 真机 Canary（Safety 20 Tick → shadow → hybrid） | ⏳ 下一步 |

## 并行任务（4 份，地界互斥）

| Agent | 地界（只允许改这些） | 依赖 |
|-------|----------------------|------|
| A | `src/infrastructure/pi/pi-agent-runtime.ts` + `test/pi-agent-runtime.test.ts`（补真实嵌入冒烟 + 1000 runs 泄漏） | 无 |
| B | `src/app/runtime-config.ts` `single-writer-lock.ts` `run-manifest.ts` + `src/cli/doctor.ts` + 各自测试 | 无 |
| C | `src/telemetry/decision-trace.ts` `jsonl-writer.ts` `schema` + 测试 | 无 |
| D | `src/planning/planning-snapshot.ts` `task.ts` `worker-task-planner.ts` + 测试 | 无 |
| Leader | `src/app/tenant-runtime.ts`、`src/cli/run-tenant.ts`、loop/coordinator 契约、真机开闸 | A+B+C 完成后 |

## 全量门禁（每次提交前必跑）

```bash
cd packages/arena-agent && npm test && npx tsc --noEmit
cd .. && npm run replay:check && uv run pytest -q
uv run python scripts/gen-status.py --check
```

当前基线：TS 201 / SDK 48 / Python 168 / replay 硬差异 0。

## 风险与红线

- 挂死教训：`tsx --test` 进程曾挂死 59 分钟（open handle）——测试命令一律带 `timeout`，>2 分钟无输出即杀。
- 单写者红线：同一租户 Python/TS 只能一个提交者（进程锁 + PID 验证，Agent B 实现）。
- 凭据红线：token 只进 `.env`（gitignore）；日志脱敏。
- Agent 死亡协议：并行 agent 无提交/无输出 >30 分钟 → 杀掉重派或 leader 接管。
