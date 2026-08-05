# Arena 当前执行状态

> 最后更新：2026-08-05。代码、测试、run manifest、JSONL 与 Runtime-Golden 优先于聊天记录。

## 当前阶段

W6/W7 的代码硬层已完成；Issue #1 继续承载生产验收，不重做架构。

固定优先级：正确性 → 可恢复性 → 可观测性 → 确定性收益 → 数据质量 → 模拟器真实性 → ML。

当前 TS 主线不再以 W7-W18 的旧时间切片驱动；**执行 SSOT 为 `docs/ts-execution-plan.md`**。当前主序列：KPI report → TS experiment manifest → named PlannerVariant registry → baseline freeze → CandidateEvaluator → 扩展现有 runAB/ABReport → economy/clear-path candidates。并行上限为可靠性、Planner、评估各一项，生产/服务器轨道默认只占 20%。

## 已完成事实

- TS SDK、schema、协议归一化和 53 项 SDK 测试；
- DecisionLease、deadline、Coordinator、Arbiter、Validator 与 Safety fallback；
- DeterministicPlanner：BFS 绕障、资源唯一分配、跨 Tick 记忆、回仓与容量裁决；
- t1–t4 历史 deterministic 真机窗口各 100 live submit，合计 400/400 accepted；
- Pi `createAgentSession` 原生嵌入，builtin=0，仅 `arena_plan` / `arena_map`；
- Pi circuit breaker：可配置阈值/冷却、open 快速 fallback、half-open 单探测、结构化 telemetry；
- `runTenant` 正常和异常共用幂等 cleanup stack，关闭 runtime、signal/IPC listener、client、recorder、JSONL writers，最后释放 lock；
- `TenantSupervisor` 全量 preflight 后才 spawn；重复 config/tenant、路径越界、缺 secret 均 0 spawn；
- 部分 spawn 失败会回收已经启动的 child；
- readiness 每次读取 writer lock，只有 lock PID == child PID 才 ready；
- Debug API 端口在 spawn 前绑定；端口冲突 0 spawn；
- `/health` 与 `/ready` 分离，JSONL 只读取末尾 256 KiB，并能跳过截断尾行；
- Windows 使用 IPC 优雅关单 + `taskkill /T /F` 超时升级；POSIX 使用独立进程组 + `SIGKILL`；
- Windows/Linux 真实 child+grandchild 黑盒均为 orphan=0；
- Python 实时 runtime、仓库级 `pyproject.toml` / `uv.lock` 和失效入口已退役；
- 服务器部署基线：不可变 release、外置 config/runtime、systemd cgroup、shadow readiness 有界自恢复、live `Restart=no`、无密钥 health env、独立磁盘告警不重启 writer、有限 JSONL 轮转；
- **部署形态升级为 Docker（GHCR）+ systemd 编排**：CI 在 main push 构建推送 `ghcr.io/deliciousbuding/arena:<sha>/:main`；systemd 为生命周期唯一权威（shadow `Restart=on-failure`、live `Restart=no`）；容器 stop 销毁 PID namespace 无孤儿；健康探针宿主零 Node 依赖（compose exec + df）；
- **us1 生产 Docker shadow 已部署**：容器 healthy，`/health`/`/ready` 均 ready:true，t1 持续产出 run 与 telemetry，shadow/disk 健康计时器全绿；
- **us1 四租户 Docker shadow 已上线**：t1–t4 各自独立进程（pid 38/44/50/52）、独立锁（`/var/lib/arena/<t>/locks/<t>.lock`）、独立 run/manifest/telemetry；supervisor.jsonl 记录四租户 ready；健康 timer 验证四租户 ready=true（149ms）；
- **kill -9 故障注入演练完成并自愈**：演练暴露两个真实缺陷——(1) 单写者锁 PID 复用陷阱（旧容器锁残留 + 新容器同号 PID 误判活锁，PR #4 starttime 修复）；(2) compose 前台容器退出返回 exit 0 导致 systemd 不重启（PR #5 `--abort-on-container-exit --exit-code-from` 修复）；修复后重演 kill -9 → systemd 自动拉起 → 四租户自动 ready → 锁自动回收 → 数据恢复；
- **优雅停机/重启演练通过**：`systemctl stop` → 容器移除、0 残留进程、0 锁残留；`start` → 四租户 ready、数据持续产出；
- **磁盘告警演练通过**：模拟磁盘满（临时抬高 `ARENA_MIN_FREE_BYTES`）→ disk-health fail-closed → OnFailure 触发 daemon.crit 告警 → **writer 未被重启**（红线验证）；恢复门槛后 disk-health 恢复 exit=0；
- Digital Twin S0–S12 / P06 / P12 与首份 Runtime-Golden 已落地。
- **Pi 模型网关链路已验证（2026-08-04）**：`~/.pi/agent/{models.json, auth.json}` 原生配置（内置 openai provider + baseUrl 覆盖 newapi 网关 `api.tokendancelab.com`）；本地实测网关 200 OK 1.1s、简单 prompt 5.6s、生产形态 prompt 18–57s（agent 模型多步推理，超出 15s tick 窗口——印证 per-tick LLM 关闭路线）。
- **低频 MacroPolicy 已实现（PR #16/#17，v0.1.7）**：`MacroPolicy`（posture/workerTarget/militaryRatio/focusRegion/attackPriority）+ `MacroPolicyOrchestrator`（每 32 ticks 异步 Pi 产出，60s 超时不占 tick 窗口，失败 sticky 不轰炸）+ 独立策略 Pi session + `policy.jsonl` telemetry；SafetyPlanner 消费 posture→aggression（激进分支含 Vanguard 前压攻坚、Ranger 断经济）。
- **MacroPolicy 全模式启用（PR #21/#22，v0.1.9/v0.2.0）**：策略层在所有决策模式运行（deterministic 执行 + LLM 战略 = 原生设计）；DeterministicPlanner 透传 policy 给 Safety fallback；`PiSessionFactory` 原生支持空 customTools（策略层无工具，不再需要占位 hack）；策略初始化失败写入 `policy_init_error`（不再静默吞掉——修复根因：v0.1.9 生产 policy.jsonl 数小时 0 行）。
- **激进战斗策略已上线（PR #13）**：SafetyPlanner `aggression` 配置 + STABLE_RULES 攻击导向 prompt + A/B 对打证据（6 seeds×500 ticks：aggressive pop=6 存活 vs defensive 军队全灭，0 illegal）。
- **MacroPolicy 生产首次真实产出（2026-08-05）**：us1 live v0.2.0，tick 52055 四租户 policy_update（t1: harvest/workerTarget=12；t2-t4: harvest/workerTarget=16，militaryRatio=0）——LLM 战略层在生产 deterministic 模式真实运行（deepseek-v4-flash @ tokendancelab 网关，policy.jsonl 证据）。修复链：customTools:[] 校验拒绝（#22 原生空支持）→ 生产 config provider "newapi" vs auth.json "openai" 不匹配（服务器 config 修正）。

## 死锁攻坚（2026-08-05，v0.2.3 → v0.2.7）

生产 t1 实测 `capacity_wait:DEPOSIT` 死锁（40+ ticks 唯一意图、cargoTot 永不清零、经济停滞），逐层定位并破除：

1. **v0.2.3 守家锚点**：满血 Vanguard 回防目标从 Core 格改为 Core 相邻格（`homeCell`/`vanguard_home`），军事单位永不再占回仓通道。根因：`decideVanguard` 无敌人时 `target = core.position`。
2. **v0.2.4 SPAWN 解锁**：满载 Worker 在 Core 格不算"永久占位"（卸货等待），补员不再被 `unitsOnCore` 抑制。
3. **v0.2.5 资源满让位**：`resourceSpace=0` 时 DEPOSIT 不合法（validator 每 tick 修复移除，repairCount=1），满载 Worker 让出 Core 格（`yieldDirection`）→ SPAWN 消耗 5 资源 → 卸货通道恢复。**完整破锁闭环，生产验证：SPAWN 执行（res 10→5）、workerCount 2→3、cargo 卸下、delta>0**。
4. **v0.2.6 敌格绕行**：敌方格并入 `taskAction` 绕行障碍，回仓/采集路径自动绕开敌占格。
5. **v0.2.7 半径受限确定性 BFS**：`nav.stepTowardPath`（半径 24/预算 4096/3× 距离剪枝）——旧扩框 BFS 在敌群围堵时走出包围盒或给出必被容量拒绝的 MOVE；新 BFS 局部绕行输出第一步，`stepToward` = 新 BFS → 旧扩框 BFS → fail-safe 回退链。另加容量预检：本 tick 已占满（≥2 实体）格并入绕行障碍（capacity_wait 循环的另一来源）。
6. **v0.2.8 敌方 CORE 并入障碍**：`planning-snapshot.enemyCells`（全部可见敌人占用格，含敌方 CORE）——生产实测最后一层：w1 满载 @[-316,57] 被敌方 CORE @[-317,57] 挡在一步内，旧 avoidCells 只含 kind=UNIT 的敌方单位 → BFS 走被容量裁决拒绝的格 → capacity_wait 循环 300+ ticks。修复后生产验证：**maxDist 32→14 持续推进（w1 绕行回家）、capacity_wait 消失、DEPOSIT×2 正常回仓**。残余：w1 在敌区边缘 14-16 格徘徊（战场阻塞非死锁，BFS 剪枝 3× 放弃更长绕行——等敌群移动/清场，不调参防局部最优）。
7. **v0.2.9 fail-safe 不横跳**：旧 fail-safe 在墙前选第一个非障碍方向（含远离目标方向）→ w1 在敌区边缘 12↔16 格来回横跳。修复：fail-safe 只走"离目标更近"的格，否则 WAIT（敌群/障碍会移动）。生产验证：w1 dist 12→9 持续推进、waitCount=0、tick 53441 cargoTot=0（300+ tick 死锁的满载 Worker 全部卸完）+ delta=+1——经济循环完全恢复。
8. **v0.2.10 策略层清场证据**：生产 A/B 实测（500 ticks）——t2 aggressive 清场方资源均值 20 满仓 vs t1 defensive 被敌群压制 5（Worker 被赶远卡货、maxDistAvg 28.5 vs 1.9）。LLM 策略层 militaryRatio=0 不造兵 → 无清场能力 → 经济被压。policy prompt 注入军事价值证据，引导策略层产出合理 militaryRatio（执行层不变）。
9. **v0.2.11 militaryRatio 消费接线**：`selectDeterministicCoreAction` 重写——workers 达 target 且军事占比不足时产兵（VANGUARD/RANGER 交替、资源门禁 cost+reserve、经济优先）；满载 Worker 在 Core 格不算永久占位（卸货等待不阻塞 SPAWN）。策略层（0.35-0.4）首次被执行层消费。生产遥测：policy 演进至 `balanced/workerTarget=12/militaryRatio=0.35/attackPriority=workers`，10 Worker 全部 patrol/WAIT（资源采尽终局，非死锁：无 failedEvents、无 capacity_wait、提交 accepted 为主）。
10. **v0.2.12 模拟器 policy 注入 + 远距离导航自适应**：
    - `EpisodeTenant.policy`（可选 MacroPolicy）+ `PlanProvider.decide` 扩展 `policy?`——离线策略扫描闭环（root cause：episode.ts 原 decide 不传 policy → workerTarget=floor=2 → 模拟器无补员 → 经济恒死；注入后 SPAWN/采集/回仓正常，res 10→2-4、pop 2→4）。
    - `nav.adaptivePathOptions`：distance > 24 时放大 BFS 搜索半径（radius=min(64, distance+2)、nodeBudget=radius²×4）——生产实测满载 Worker 在 40+ 格外回仓时默认搜索窗直接不可达，退化为 fail-safe 卡死（stall_warning cargo_blocked 累计 26 次）。回仓/GO_RESOURCE 分支接线（确定性零回归：distance ≤ 24 返回默认对象）。
11. **v0.2.13 stall 检测误报修复**：远距离满载回仓途中（位置逐 tick 变化）也会 `delta=0 + cargo>0`，原判定 16 ticks 即误报（v0.2.12 部署后立即复现）。修复：满载 Worker 位置指纹（cargo>0 单位位置集合）不变才计 blocked；移动中 = 正常回仓不告警。真死锁（围死/占格）位置不变仍正确告警。
12. **v0.2.14 决策层优化 + 模拟器 Core 自毁时序修正**：
    - **OP3 防守 Ranger 目标排序**：`defensiveShotPriority`（距离 → 类型价值 → id）替代 id 字典序——1 格外即将 sweep 的 Vanguard 优先于 3 格外 Worker；同距离 WORKER 优先断经济。激进模式保持原价值排序。
    - **OP5 Vanguard 守家锚点按单位展开**：`homeCell(core, obstacles, index)`——第 n 只 Vanguard 从 UP→RIGHT→DOWN→LEFT 的第 n 个方向起选锚点。多只守家单位不再挤同一格（容量 2 下第 3 只起被拒/抖动），防线覆盖四向且不堵单条回仓通道。
    - **OP1 模拟器 Core SELF_DESTRUCT 时序**（P0 规则失真）：拆独立 phase（P10-core-self-destruct，combat 之后）——v0.12 生产语义要求移动与 combat 先结算：被集火时本 tick 已阵亡的 Core 由攻击方正常获得参与分/掠夺（CORE_RESOURCES_CAPTURED），幸存 Core 才在 heal/spawn 前自毁；自毁舰队已交 upkeep（P04）、已参与移动/攻击（P05/P09）。新增测试：攻击+自毁同 tick → 攻击方掠夺 7 资源、reasonCode=ATTACK、无 SELF_DESTRUCT。
    - **OP4 评估后跳过**（不做净收益下限/DEPOSIT resourceSpace 双重检查）：生产资源采尽后 `availableCells=0` 自然无死头行程；taskAction 已有 resourceSpace 让位处理（v0.2.5），forcedTaskFor 加检查属重复逻辑；模拟器无 refill 时远节点是唯一收入，阈值调参需 A/B 网格——收益不确定，不过度工程化。

**检测设施（同步落地）**：
- `stall detector`（v0.2.4+）：连续 16 ticks `delta=0 且满载滞留` → runtime.jsonl `stall_warning`（生产累计触发 26 次，自动告警替代人工发现）。
- `test/economy-loop.test.ts`（12 测试）：经济闭环长跑（决策→模拟结算 200 ticks，断言 cargo 周期清零/SPAWN 消耗闭环/守家锚点/资源满让位/敌格绕行/militaryRatio 产兵门禁）。
- `test/nav-pathfinding.test.ts`（10 测试）：生产场景复刻（三面围堵绕行/四面围死 null）、直线墙绕行可达性、确定性、性能上限、自适应半径远距离（48 格）可达与绕行。

**剩余已知卡点**：w1 满载 Worker 在 32 格外被敌方 Worker 群长期围堵（战场阻塞，非 planner 死锁——四面围死时 WAIT 正确；等敌群散开或 Vanguard 清场）。A/B 对照 t2（aggressive）经济更健康佐证防守策略需配合前压。
- **经济死锁修复 + A/B 实验（v0.2.2，PR #25，2026-08-05）**：生产数据显示 deterministic SPAWN 锁死 emergency floor=2（t1 停 2 worker、策略 workerTarget=16 不生效）→ workerTarget 接线补员（reserve 保护 + emergency 保命优先）+ prompt 注入策略历史基线（防 16→3 跳变）+ config.policyOverride 实验框架。**A/B 第一轮已启动**：t1 = LLM 自主对照，t2 = 固定 aggressive/workerTarget=12/attackPriority=core 实验组（policy.jsonl policy_override 记录为证）。
- **部署链路/状态机/世界状态设计稿（2026-08-04）**：`docs/design/deploy-fast-upgrade.md`（版本 pin 单源化 /opt/arena/version.env + upgrade.sh 一键升级 + 自动回滚——pin 丢失已两次实测）；`docs/design/game-state-machine.md`（Core 复活/自毁/upkeep 状态机 + 规则升级语义 + 决策层 respawnOverride）；`docs/design/world-state.md`（本地记忆 vs 服务器权威 + 资源记忆过期 + tick 回退世界重置检测）。
- **工具链升级（2026-08-05）**：TypeScript 5.5 → 7.0.2（Go 原生编译器，`npm run check` 提速约 10x）；两包测试链全面切换 Node 24 原生 `node --test --test-force-exit`（hero-ts 53 + arena-agent 519 tests 全绿，0 fail），`tsx` 仅保留为 CLI 入口；消除 3 处 parameter properties 与 1 处 type-only import，tsconfig 开启 `verbatimModuleSyntax` 固化 erasable-only 规范；`npm run check` / `npm test` / `schema:check` / `replay:ts` / gen-status / docs_health 全绿。

## 自动化证据

- SDK、arena-agent、schema、Python 模块计数：`docs/generated/status.md`（唯一生成源，勿手改；arena-agent 519 含锁 PID 复用回归与 Runtime-Golden 覆盖工具用例）；
- Supervisor Windows：19/19；Linux Node 24 定向：86/86（专项跑测记录，非 status.md 覆盖项）；
- TS replay：100 records；
- simulator economy 10,000 Tick 与 movement 随机 10,000 cases invariant 通过。

## 真机证据边界

### Deterministic

四租户历史报告均包含 startup sync、100 accepted submit 和 outcome drain；合计 400/400 accepted、0 rejected、0 repair。该事实不等于 Supervisor 四租户长期 soak 已完成。

### Pi shadow

2026-08-04 t1 30 Tick：27 candidate、2 soft deadline、1 cold-start error；216 valid actions、0 invalid。第 4 Tick后稳定延迟约 4.4–5.9 秒。该证据只证明 adapter/shadow 路径，不授权 hybrid/live。

### Runtime-Golden

首份数据集 run `26600fea-e8c7-45da-98e8-5a4bc03919f9`：3 cases、hard mismatch=0、unclassified=0、已触发 known deterministic events 6/6。它主要覆盖 movement/economy/visibility。

combat、第四 Tick Unit/Core 争抢、Beacon pickup/drop/death、Core destruction/respawn 仍需专项 Runtime-Golden。服务端私有 respawn placement、UUID、refill 与不可观测对手 Plan 必须继续标记 unknown/inconclusive。

## 明确关闭的路线

- Python 不是生产回滚路径；回滚使用稳定 TS commit/config + doctor/shadow/canary。
- per-tick LLM 不作为生产主线；低频 MacroPolicy 只能异步输出有限战略参数。
- live writer 自动重启关闭。SDK 默认幂等键包含随机值，跨进程 last accepted tick 恢复完成前，重启可能造成重复提交。
- 不为了路线图形式创建第二套 control plane、配置中心或进程框架。

## 尚未完成

1. Provider/Pi 真实 agent-shadow 故障注入与 circuit telemetry 证据；
2. 四租户 Supervisor 分级真机运行与长期 soak（us1 live 已四租户常驻，长期 soak 证据持续累积中）；
3. 稳定 TS commit/config 回滚演练（Docker 镜像 tag 回滚流程已文档化，待演练）；
4. combat、Core migration、Beacon、respawn 专项 Runtime-Golden；
5. 服务器长期运行观察（us1 live 运行中，持续验证）；
6. ~~升级或受控修补 Pi 依赖链中的 undici 再开放 per-tick `agent-shadow`/`hybrid`~~：per-tick LLM 已确认关闭路线（agent 模型 18–57s/决策 > 15s 窗口），低频 MacroPolicy 用独立 session 落地，无需 per-tick hybrid；
7. 基于真实净收益决定是否允许单租户 hybrid canary（当前低频策略层替代该需求）。

## 生产晋级顺序

```text
doctor
→ deterministic shadow
→ 单租户 bounded deterministic live
→ 四租户逐个加入 Supervisor
→ 长期 soak
→ rollback drill
→ Pi shadow fault injection
→ 只有净收益与红线同时成立才考虑 hybrid canary
```

任何阶段出现 rejected submit、writer-lock 异常、跨租户污染、orphan、凭据泄漏或未分类 mismatch，都立即停止晋级。

## 标准门禁

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts
python scripts/gen-status.py --check
python scripts/docs_health.py --check
```
