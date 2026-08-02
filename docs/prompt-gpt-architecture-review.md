# 任务：Arena Hero 机器人项目架构评审与优化设计

你是这个项目的独立架构师。以下全部是**客观现状**（2026-08-02 实测），不是我的方案。请你基于事实做架构评审、指出设计问题、给出优化方向与实施排序。**不要被任何表述左右**——如果现状描述里藏着问题，指出来；如果某部分设计已经合理，说明为什么。我不需要你认同我，需要你找到真相。

## 一、项目目标

用机器人自动游玩在线游戏 Arena Hero（15 秒一个 Tick，WebSocket 推状态 + HTTP 提交行动计划）。4 个账号并行，目标是攒游戏内资源兑换公益站注册码。当前由确定性策略（balance）兜底 + LLM（deepseek-v4-flash，经 pi 框架）逐 Tick 决策。游戏规则版本 v0.11。

## 二、仓库形态（刚重构过）

单仓 monorepo `arena`（private），npm workspaces + uv（Python）双包管理：

```
packages/arena-hero-ts/   TS SDK：wire schema 单源（TypeBox）+ WebSocket client + Turn builder
packages/arena-agent/     TS 编排层：domain/（state-reducer、nav、phase-machine、plan-validator、world）
                          + runtime/（loop、DecisionLease、state-hash）+ strategies/（SafetyPlanner）
reference/arena-hero-python/  官方 Python SDK 源码镜像（只用于追上游协议变更，不执行）
src/arena_bot/            Python 运行时（退役中）：主循环、LLM 桥（RPC）、调度器、遥测
docs/migration-plan.md    迁移方案主文档（W0-W6 切片，见下）
AGENTS.md                 项目规则文件
```

历史：原三仓库（arena / arena-hero-ts public fork / pr-verify 工作区）刚合并为单仓，以消除 git 依赖 pin 摩擦。pi 框架是独立第三方仓库（private），只做可上游化的通用修复。

## 三、决策链路（现状）

每 Tick（15s）：
1. SDK 收 WS state 事件 → `Turn`（builder 模式，动作排队）
2. 编排层 `reduceTurn` 规范化成不可变 `TickState`（排序 + freeze）
3. 决策：`SafetyPlanner.decide(state)`（确定性，规则手写）→ `Plan`；LLM 决策桥（W4）未接入
4. `validatePlan` 语义校验 + 逐动作 repair
5. `planToCommandPlan` 转 wire → `Turn.replace()` 注入 → `submit()`（幂等重试）
6. `DecisionLease`（tick/stateHash/deadline 三重校验）约束外部决策者（未来 Pi 会话），拒绝迟到/错状态计划
7. 遥测 JSONL + raw-state dump（供离线回放差分验证）

## 四、迁移计划 W0-W6 完成度（客观）

- W0 嵌入闸门 ✅：pi `createAgentSession` 可嵌入（customTools/abort/waitForIdle 6 测试）
- W1 wire schema ✅：TypeBox 单源 → `contracts/generated/*.schema.json`（6 个，生成零漂移）；Golden Replay 用真实状态 fixture 解析验证
- W2 State Reducer + Safety Planner ✅：domain 层完成（19 个领域测试）
- W3 Sequence Differential Replay ⬜：未做（Python 回放对比 TS 决策序列）
- W4 AgentSession + DecisionLease + Hedged Decision ⬜：**核心未做**——Pi LLM 决策桥，原设计是"直接嵌入 pi-coding-agent 的 createAgentSession，消灭 Python RPC 桥"
- W5 Supervisor + Shadow Mode 🔶：shadow 验证脚本有（离线 replay 真实快照 11/11 通过），supervisor 未做
- W6 删除 Python ⬜：未做。Python 侧 9 个模块已被 TS 取代，9 个未取代（LLM 桥、调度器、调试端点、看门狗、遥测）

## 五、测试基线（全部实测绿）

- SDK 48 测试（wire schema 8 / protocol 10 / turn 7 / client 20 / golden replay 3）
- 编排层 21 测试；Python 135 测试（无凭据）
- 运行方式：`tsx --test`（Node 24 原生 strip-only 不支持 node_modules 下 TS，所以 SDK 测试用 `--experimental-transform-types`，编排层用 tsx）
- 运行时：Node 24 / typebox 1.3.10 / node:sqlite（WAL）/ ws；TS 源码直接加载（无构建步骤）

## 六、已知技术债与待裁决问题（不预设答案）

1. **Python raw-state 数据污染**：多租户共享 `raw_state_dir`，同 tick 不同账号写同名文件，并发写坏（拼接/截断）。修复选项：按租户分目录 / 文件名带账号前缀 / 退役前不管（Python 只剩 burn-in 数据收集用途）
2. **LLM 决策桥形态**：原设计"TS 编排层直接嵌入 pi-coding-agent 的 createAgentSession"（agent 会话 = 决策大脑）。但 pi 是第三方框架——嵌入方向的依赖倒置是否合理？还是编排层自持会话生命周期、pi 只做模型提供？hedged decision（双模型/双策略竞争）的取舍？
3. **决策确定性 vs LLM 不确定性**：现在 SafetyPlanner 全确定性；LLM 介入后如何保持可复现性（seed/回放/差分）？
4. **共享地图 MapStore**（SQLite WAL 跨进程）：4 租户共用 vs 每租户独立？worker 线程是否必要（现在 node:sqlite 同步 API 在主 loop）？
5. **多租户进程模型**：4 账号 = 4 Node 进程（现在 Python 侧是 4 进程）。Node 下是否该换 worker_threads 单进程多租户？还是保持进程隔离？
6. **TS 无 CI**：SDK/编排层测试与契约零漂移检查没接 CI（GitHub Actions 只跑 Python 侧）。值不值得现在补？
7. **根 contracts/**（arena_plan/arena_map LLM 工具 JSON Schema）与 pi-arena 的 TypeBox 定义重复——单源应归谁？
8. **外部控制面**：Python 有 debug API（/state /command /map/query，HTTP 8123-8126）+ 看门狗（停滞告警）。TS 侧对应物设计？
9. **Pi fork 改造面**：arena-llm-bridge 分支持有哪些通用可上游化修复？哪些是 arena 专属不该进上游？
10. **追上游**：官方 Python SDK 更新时，TS wire schema 的手动同步流程是否该自动化（契约对比工具）？

## 七、硬约束（不可违背）

- 秘钥只进 `.env`（gitignore），永不入仓
- pi 保持独立仓库；对 pi 的修改只做通用、可上游化的
- Python 退役是既定方向，不再给 Python 加新功能
- 游戏协议以官方 SDK + v0.11 规则为权威；TS wire schema 是单源，禁止两套定义漂移
- 测试基线不可退（SDK 48 / 编排层 21 / skipped 0）
- 新设计必须保持"当前 Tick 状态是唯一权威事实"，记忆只做线索

## 八、交付物（请按此输出）

1. **架构评审**：现状里最值得警惕的 3-5 个设计风险（附理由和失效场景），以及被低估的 3 个设计亮点
2. **决策桥设计**：W4 的具体设计（组件边界、生命周期、超时/回退/并发策略、与 DecisionLease 的交互），给出你推荐的形态和理由
3. **待裁决问题裁决**：对第六节 10 个问题逐个给出你的建议 + 一句话理由（可以有"维持现状"）
4. **实施排序**：未来 2-4 周的工作切片（每片 ≤1 周、可独立验收、有测试），按依赖关系排序，标注每片做完后系统有什么可验证的变化
5. **风险登记**：任何你看到的、上面没列的坑

输出用中文，直接可并入仓库文档的格式。不要写代码实现（除非某处必须用伪代码才能说清）。
