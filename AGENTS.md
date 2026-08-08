# Arena Agent 协作说明

最后更新：2026-08-08。

（TS 线）与 `arena-rs`（Rust 线）曾各自独立实现引擎与策略，共享数据层
（`ARENA_DATA_ROOT`、共享 schema、calibration case、数据集），在同一套
真实数据上正面比较（2026-08-07 用户裁决 RS 线赛马认输，本仓成为唯一实现线）。
真实数据采集执行采用单一 writer 纪律（防双 schema/撕裂写）：**t1/t2/t3/t4
全部由本线（TS）采集**；Rust 看护 `ArenaWatchdogRust`/`ArenaWatchdogT34` 已禁用。
本线遵循原生设计：优先 Node 标准能力、现有 SDK/lock/JSONL，不引入
第二套进程框架、控制面或配置系统。

## 权威入口

- 当前状态：`../docs/progress/MASTER.md`
- 运维：`../docs/ops/supervisor-runbook.md`
- 服务器：`../docs/ops/server-deployment.md`
- 架构：`../docs/ts-architecture.md`
- 迁移系统：`../docs/design/migration-system-v1.md`（模块设计/M1-M5 实现状态）+ `../docs/design/core-rejoin-v1.md`（t1/t2 会合应用计划）；红线：`data/runtime/migration/` 唯一 writer = conductor 进程，旧 `core-migrate-driver` 直写 human-commands 路径已淘汰（存在计划时拒绝运行）
- 测试数字：`../docs/generated/status.md`
- 外部参考（第二名，经常更新，涉及策略追赶先拉）：`../reference/arena-hero-agent`——同步 `git -C ../reference/arena-hero-agent pull`；差距清单与版本差异见共享 MASTER.md「外部参考仓库」章节
- 官方参考源（规则更新追踪）：`../reference/arena-hero-doc`——同步 `git -C ../reference/arena-hero-doc pull && git -C ../reference/arena-hero-doc log --oneline -3`；官方版本事实与对照见共享 MASTER.md「外部参考仓库」首段

## 并行 Agent / Git 工作树纪律

- 并行修改 `arena-ts` 的 Agent 必须各自使用独立 `git worktree` + 独立分支；主工作树用于集成与生产，不作为多个 Agent 的共享编辑区。
- 每个 Agent 只 stage 自己任务的路径；提交前必须用 `git diff --cached --name-only` 复核范围。并行开发期间禁止 `git add -A` / `git add .` 吞入其他 Agent 的改动。
- 发现目标路径已 dirty、已 staged 或由其他活跃 worktree 占用时，保持只读或切换到新的独立 worktree；不得 reset、stash、checkout、restore 或格式化他人的 WIP。
- 合回 `main` 前先完成分支自验，并确认主线没有同路径冲突；遇到冲突按当前 `main` 语义重放改动，不机械覆盖较新的实现。
## 标准命令

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts

npx tsx packages/arena-agent/src/cli/run-tenant.ts --doctor --config=../data/runtime/configs/t1.json
npm run arena:supervisor -- --configs=t1,t2,t3,t4 --mode=deterministic --shadow --port=8120
```

## 本地运行形态（2026-08-06 起；t3/t4 收回 TS 线 2026-08-07）

us1 已关闭，t1/t2/t3/t4 本地 live（deterministic + submitEnabled=true，data root 默认 `../data`，baseDir=runtime）：
```bash
npm run arena:supervisor -- --configs=t1,t2,t3,t4 --mode=deterministic --live --record-calibration --port=8120
```
- 看护：Windows 计划任务 `ArenaWatchdog`（每分钟，t1-t4，重建命令见下）+ `scripts/arena-watchdog.sh`（异常自动恢复：确认死透 → 清死锁 → 带 `--record-calibration` 重启，日志 `~/arena-watchdog.log`）；
- 生产租户为四线 `t1`/`t2`/`t3`/`t4`（用户 2026-08-06 裁决；t3/t4 2026-08-07 收回 TS 线，
  Rust 线退役、看护已禁用）；supervisor 跑 `--configs=t1,t2,t3,t4`，
  `scripts/arena-watchdog.sh` 看护四线（含 t3/t4 锁清理与拉起）。

### 租户始终运行 + 数据收集线保障（2026-08-06；t3/t4 收回 TS 线 2026-08-07）

- **数据根优先级**：CLI `--data-root` > `ARENA_DATA_ROOT` > 仓库同级 `../data`；supervisor 未显式覆盖时使用 `../data/runtime/configs` 与 `../data/runtime`，模拟器输出严格限制在 `../data/runs/sim`；
- **数据收集线 = supervisor `--record-calibration` 旁路**（只记录 accepted plan、相邻 raw state 与 receipt，cases 持续落盘 `../data/runtime/<t>/calibration/<runId>/cases/`；校准/分析只离线执行，看护重启命令已含该参数）；
- **计划任务链路（v3，实测验证）**：ArenaWatchdog（每分钟）→ `scripts/arena-watchdog-hide.vbs`（**wscript.exe //B，GUI 子系统，无控制台窗口不闪屏**——2026-08-06 由 bat 直跑改为 vbs，消除每分钟闪窗）→ PowerShell `Start-Process` 完全分离 bash → `arena-watchdog.sh`（确认死透 → 清死锁 → 带 `--record-calibration` 重启）。**故障注入演练通过**（2026-08-06 23:42 杀 supervisor → 31s 自动恢复 → 超过任务会话杀进程窗口 1.5 分钟仍存活）；v1 直接 `bash -lc` 有缺陷（任务会话结束回收进程树，supervisor 拉起 16s 后被 ^C 杀——实测捕获）；`scripts/arena-watchdog.bat` 保留为手动回退入口（内容与 vbs 等价，不再被计划任务引用）；
- **脚本编码约束（防闪窗回归）**：`arena-watchdog.bat` 与 `arena-watchdog-hide.vbs` 必须保持**纯 ASCII**——cmd 按 GBK 代码页解析 bat，UTF-8 中文注释会让行解析错位，实测每次任务运行都闪 `'...' 不是内部或外部命令` 报错窗（2026-08-06 已改为英文注释，中文设计说明在 `.sh` 与本文件）；改脚本时不得再引入非 ASCII 字符；
- **计划任务丢失恢复**：ArenaWatchdog 曾丢失（2026-08-06 发现）——重建命令（动作 = wscript 跑 vbs，无闪窗）：
  ```bash
    MSYS_NO_PATHCONV=1 schtasks /create /tn ArenaWatchdog /sc minute /mo 1 /ru Ding /f /tr "wscript.exe //B $(cygpath -w "$PWD/scripts/arena-watchdog-hide.vbs")"
  ```
  验证：`MSYS_NO_PATHCONV=1 schtasks /query /tn ArenaWatchdog /fo LIST`；
- **操作纪律（防误杀数据线）**：清理实验/后台进程只按**命令行匹配**杀特定 PID（`wmic process where "name='node.exe'" get processid,commandline | grep 匹配`），**严禁 `taskkill` 全部 node 进程树**——会误杀 supervisor/tenant 造成数据线中断（2026-08-06 实测教训：误杀后看护恢复，但产生中断窗口）；需要杀 supervisor 时按 8120 端口找 PID 定向杀。

## 模拟器真实性（稳定知识）

- 官方 refill 是 **server-secret**（rules manifest `constraints.refill.status=server-secret`，永久 seed 不可预测）——模拟器默认不实现（unknown-by-design，绝不伪装 MATCH）；实验可用 `EpisodeConfig.refill`（近似：按 cadence 补回原始资源格，unknown note 标注 approximate）。
- **Beacon fog 语义**（官方协议 "Public position and, when visible, carrier state"）：视野外 beacon 的 status/carrier_id 投影为 null。**校准 fixture 的 beacon 必须放核心视野内**（Manhattan ≤ core.visionRadius=5），否则 before.status=null → beaconUnknown 吞掉全部差异分类（校准测试全变 INCONCLUSIVE——2026-08-08 实证）。详见 `../docs/simulator.md` §11.6。
- **对抗平台**（2026-08-08 平台化）：对手接入走注册中心 `src/sim/opponent/registry.ts`（reference-python 内置 farmer/core + `http://` 端点）；Python 新对手 = `scripts/python-agents.json` 加条目（契约：decide 用官方 SDK turn 方法填 builder）；通用对抗矩阵用 `scripts/vs-arena.mts`（--opponents/--seeds/--refill/--scenario/--record-dir）；真实测绘场景 `src/sim/opponent/survey-scenario.ts`。详见 `../docs/simulator.md` §11。
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
