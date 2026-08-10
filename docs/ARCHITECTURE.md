# Arena Bot 架构（Python 版，legacy）

> ⚠️ **本文件描述早期 Python runtime 的历史快照，仅作参考，不再可执行。**
> 当前实现见 [README](../README.md) 与 `docs/` 目录；本文仅作历史参考。
> 不要按本文命令恢复 Python 运行链。

最后更新：2026-08-10

## 分层

```
main.py          入口：连接、事件→world、阶段机、策略、提交、调试端点
debug_api.py     本地 HTTP 调试/介入层（127.0.0.1:8123）
strategy.py      决策抽象：Strategy 基类 + Plan 纯数据 + apply_plan 执行器
strategies/      策略实现（balance = 默认）
phase_machine.py 全局阶段状态机（EARLY_EXPANSION/BALANCED/MILITARY）
world.py         环境记忆（障碍永久/资源三态/敌人跟踪/失败格冷却/单位意图）
map_store.py     共享地图测绘（SQLite WAL，多账号协同探索）
core/
  state.py       Turn 适配层（TickState：决策层不碰 SDK 细节）
  nav.py         确定性导航（曼哈顿/直线遮挡/步进/巡逻目标）
  unit_state.py  单元意图状态机（Worker PATROL/GO_HARVEST）
config.py        参数集中（frozen dataclass + with_param 运行时调整）
logging_util.py  轮转日志 + stdout 双写，[tick] 注入
```

## 每 Tick 链路

```
Turn (SDK)
  → TickState.from_turn         适配层
  → 事件处理 → world.observe    HARVEST_FAILED 降级资源格 / 成功 mark_harvested
  → PhaseMachine.update         威胁(近敌数)/人口/资源 → 阶段
  → Strategy.decide(state)      → Plan（纯数据，含意图标签）
  → apply_plan(turn, plan)      应用到 SDK 控制器
  → turn.submit()               提交
  → 结构化日志 [tick][level]
```

## 决策确定性

- 对象迭代按 UUID 排序；目标选择按 (距离, x, y)；方向固定轴优先
- 记忆（world）只做附加线索，**当前 Turn 可见数据永远优先**（规则：视野外不可信）
- 同一输入状态 → 同一 Plan（103+ 测试含确定性用例）

## 状态机

### 全局阶段（phase_machine）
| 阶段 | 进入条件 | 影响 |
|---|---|---|
| EARLY_EXPANSION | 默认 | 全力铺 Worker（worker_target=8） |
| BALANCED | 人口≥5 且资源≥20 | 经济成型 |
| MILITARY | 近敌≥2 或人口≥18 | 威胁/大军团，优先军事 |

### Worker 意图（core/unit_state）
PATROL ⇄ GO_HARVEST（跨 Tick 目标记忆）→ cargo>0 → RETURN → DEPOSIT → PATROL
- HARVEST_FAILED/RESOURCE_DEPLETED → 目标格冷却 4 tick，回巡逻
- 目标在视野外但记忆在线索内 → 继续前往（go_harvest_mem）

## 调试与人工介入（debug_api）

| 端点 | 说明 |
|---|---|
| GET /state | 完整快照：单位/记忆/阶段/参数/暂停标志 |
| GET /strategies | 阶段与参数子集 |
| POST /command | `{"cmd": ..., "args": ...}` 白名单：pause / resume / set_param / set_phase |

- 仅绑 127.0.0.1，本地单用户
- pause = 观察模式（不提交计划，AGENT 槽空 = WAIT）；resume 恢复
- set_param 运行时改参数（config.with_param，frozen 不可变保证）

## 共享地图（map_store）

- 障碍是永久地形（规则）→ 多个租户的观察实时落盘 SQLite（WAL 多进程安全）
- 任一租户查询全量已知障碍：巡逻/回家直接绕开其他账号测绘过的区域
- `GET /map` 查看测绘统计（障碍格数/chunk 数）；数据在 `mapstore/`（gitignore）
- 这是"经验建图"（官方种子不可逆，但地图内容可从观察合法重建）的第一层

## 日志（logging_util）

- `logs/arena.log`：DEBUG 全量，5MB × 5 轮转
- stdout：INFO 摘要（tick/阶段/资源/人口/单位数/敌人数）
- 格式 `[时间][tick N][LEVEL] 模块: 消息`，TickFilter 注入

## 规则契约

- 规则 v0.10 / SDK 0.2.6（2026-08-02 核对，上游 commit ad6fc27 / 4a29585）
- 契约文档 `docs/game-rules.md`
- 升级路径：更新上游官方镜像 → 同步公共规则文档与 schema/实现 → Runtime-Golden 门禁
