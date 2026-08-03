# Arena Agent 协作说明

最后更新：2026-08-04。

Arena 正式运行链为 TS-only。遵循原生设计：优先 Node 标准能力、现有 SDK/lock/JSONL，不引入第二套进程框架、控制面或配置系统。

## 权威入口

- 当前状态：`docs/progress/MASTER.md`
- 运维：`docs/ops/supervisor-runbook.md`
- 架构：`docs/ts-architecture.md`
- 迁移边界：`docs/migration-plan.md`
- 测试数字：`docs/generated/status.md`

## 标准命令

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts
python scripts/gen-status.py --check
python scripts/docs_health.py --check

npx tsx packages/arena-agent/src/cli/run-tenant.ts --doctor --config=runtime/configs/t1.json
npm run arena:supervisor -- --configs=t1,t2,t3,t4 --mode=deterministic --shadow --port=8120
```

## 不可违反

- 未获明确授权不得启动真实 live writer；
- 同租户只能一个 writer，活锁不得抢占；
- Pi 只提交候选，不直接 submit；
- 不把 `INCONCLUSIVE` 写成 `MATCH`；
- 不把 micro-Golden 写成 Runtime-Golden；
- 不自动重启 live writer；
- 不恢复 Python runtime/pyproject/uv.lock；
- 不在日志、fixture、manifest 或文档写入 token；
- 不为形式上的路线图提前实现 MapStore worker、控制面写接口或 RL。

改动完成后必须更新生成状态和 SSOT；生产事实必须附 run/manifest/JSONL 或可复现测试证据。
