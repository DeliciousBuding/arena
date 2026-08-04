# Arena 当前执行状态

> 最后更新：2026-08-05。代码、测试、run manifest、JSONL 与 Runtime-Golden 优先于聊天记录。

## 当前阶段

W6/W7 的代码硬层已完成；Issue #1 继续承载生产验收，不重做架构。

固定优先级：正确性 → 可恢复性 → 可观测性 → 确定性收益 → 数据质量 → 模拟器真实性 → ML。

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
