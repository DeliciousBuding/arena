# Arena Agent 协作说明

最后更新：2026-08-06。

Arena 正式运行链为 TS-only。遵循原生设计：优先 Node 标准能力、现有 SDK/lock/JSONL，不引入第二套进程框架、控制面或配置系统。

## 权威入口

- 当前状态：`docs/progress/MASTER.md`
- 协作快照（跨 Agent 通信文件，仓外）：`D:\Code\Projects\arena-mail.md`
- 运维：`docs/ops/supervisor-runbook.md`
- 服务器：`docs/ops/server-deployment.md`
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
npm run server:check
python scripts/gen-status.py --check
python scripts/docs_health.py --check

npx tsx packages/arena-agent/src/cli/run-tenant.ts --doctor --config=runtime/configs/t1.json
npm run arena:supervisor -- --configs=t1,t2,t3,t4 --mode=deterministic --shadow --port=8120
```

## 本地运行形态（2026-08-06 起）

us1 已关闭，t1/t2 本地 live（deterministic + submitEnabled=true，baseDir=runtime）：
```bash
npm run arena:supervisor -- --configs=t1,t2 --mode=deterministic --live --record-calibration --port=8120
```
- 看护：Windows 计划任务 `ArenaWatchdog`（每分钟，重建命令见下）+ `scripts/arena-watchdog.sh`（异常自动恢复：确认死透 → 清死锁 → 带 `--record-calibration` 重启，日志 `~/arena-watchdog.log`）；
- t3/t4 不得使用（用户裁决——让位给外部实现）。

### 租户始终运行 + 数据收集线保障（2026-08-06）

- **数据收集线 = supervisor `--record-calibration` 旁路**（calibration cases 持续落盘 `runtime/<t>/calibration/<runId>/cases/`，看护重启命令已含该参数）；
- **计划任务丢失恢复**：ArenaWatchdog 曾丢失（2026-08-06 发现）——重建命令：
  ```bash
  MSYS_NO_PATHCONV=1 schtasks /create /tn ArenaWatchdog /sc minute /mo 1 /ru Ding /f /tr 'C:\Program Files\Git\bin\bash.exe -lc "/d/Code/Projects/arena/scripts/arena-watchdog.sh"'
  ```
  验证：`MSYS_NO_PATHCONV=1 schtasks /query /tn ArenaWatchdog /fo LIST`；
- **操作纪律（防误杀数据线）**：清理实验/后台进程只按**命令行匹配**杀特定 PID（`wmic process where "name='node.exe'" get processid,commandline | grep 匹配`），**严禁 `taskkill` 全部 node 进程树**——会误杀 supervisor/tenant 造成数据线中断（2026-08-06 实测教训：误杀后看护 26s 恢复，但产生中断窗口）；需要杀 supervisor 时按 8120 端口找 PID 定向杀。

## 模拟器真实性（稳定知识）

- 官方 refill 是 **server-secret**（rules manifest `constraints.refill.status=server-secret`，永久 seed 不可预测）——模拟器默认不实现（unknown-by-design，绝不伪装 MATCH）；实验可用 `EpisodeConfig.refill`（近似：按 cadence 补回原始资源格，unknown note 标注 approximate）。
- 策略约束（模拟器实证 + prompt 已落地）：**militaryRatio 0.3-0.4 是拐点、>0.5 纯损耗禁止**；**workerTarget 8 是平衡区**（6 保守、10 upkeep 负担）。
- 策略搜索工具：`packages/arena-agent/scripts/strategy-search.mts`（两阶段：单人全网格 + top4 对打）、`scripts/military-ratio-experiment.mts`（结果文件落盘）。

## 不可违反

- 未获明确授权不得启动真实 live writer；
- 同租户只能一个 writer，活锁不得抢占；
- Pi 只提交候选，不直接 submit；
- 不把 `INCONCLUSIVE` 写成 `MATCH`；
- 不把 micro-Golden 写成 Runtime-Golden；
- 不自动重启 live writer（本地看护例外：用户授权自主维护，`arena-watchdog.sh` 严格确认旧进程死透后拉起）；
- 不恢复 Python runtime/pyproject/uv.lock；
- 不在日志、fixture、manifest 或文档写入 token；
- 不为形式上的路线图提前实现 MapStore worker、控制面写接口或 RL。

改动完成后必须更新生成状态和 SSOT；生产事实必须附 run/manifest/JSONL 或可复现测试证据。
