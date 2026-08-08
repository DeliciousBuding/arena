# AI 指挥接入层（command-plane v1）设计

> 2026-08-08 · 目标：让 Codex / Claude Code 作为"AI 指挥官"直接、安全、可审计地
> 操控 Arena 四租户（t1-t4），与人类手操、确定性 agent 形成三层指挥体系。
> 状态：设计中（原型：`packages/arena-agent/src/command-plane/`）。

## 1. 背景与动机

现状：AI 操控生产只有两条脆弱路径：
1. **手写 human-commands JSON**（`data/runtime/human-commands/{t}.json`）——易错、
   无校验、无护栏、无审计；core-migrate-driver 就是手写 JSON 的"手动档"。
2. **指挥面板 POST /api/command**——面向人类 UI，无 AI 会话上下文、无意图级抽象。

问题（2026-08-08 生产实证）：
- t1 核心迁移被 worker/军事围死（CELL_UNIT_LIMIT），driver 停滞误判反向乱绕（NW 带偏）；
- t4 贫矿 2-worker 被 watchdog 每分钟误杀重启（决策停摆误判）；
- 军事审计（migration-audit）只拦截核心迁移，无通用"AI 命令护栏"。

目标：一个统一接入层——**意图（Intent）协议 + 安全护栏 + 冲突仲裁 + 审计**，
让 Codex/Claude Code 用一句话/一个结构化意图操控游戏，系统负责执行细节与安全。

## 2. 架构总览

```
┌────────────────────────────────────────────────────┐
│ Codex / Claude Code（AI 指挥官）                    │
│   arena-ctl CLI  │  MCP tools（未来）               │
└──────────────┬──────────────────┬──────────────────┘
               ▼                  ▼
┌────────────────────────────────────────────────────┐
│ command-plane（本模块，纯函数 + 薄 CLI）             │
│  protocol.ts   —— 意图协议 + schema 校验            │
│  guardrails.ts —— 安全护栏（送死/弃富投贫/禁区）     │
│  arbiter.ts    —— 冲突仲裁（human>AI>agent>safety） │
│  audit.ts      —— 命令流水 + 拒绝原因 + 证据链       │
│  snapshot.ts   —— 决策上下文（核心/单位/矿/敌核）    │
└──────────────┬────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────┐
│ human-override.ts（现有，每 tick 合并进计划）        │
│  commands（单 tick） + goals（持续意图 mine/goto）   │
│  ← command-plane 输出落盘到此，复用成熟执行路径      │
└────────────────────────────────────────────────────┘
```

分层原则：
- **接入层**（arena-ctl CLI / 未来 MCP）：AI 的唯一入口，负责读状态、下发意图、查审计。
- **意图层**（command-plane）：把"人话意图"翻译成可执行计划（分阶段、护栏校验、仲裁）。
- **执行层**（human-override + driver）：现有成熟路径，每 tick 原子合并，不新增 writer。

## 3. 意图协议（Intent Protocol v1）

意图 = 高级命令，由 command-plane 展开成多 tick 执行计划（阶段、护栏、回退）。

```jsonc
{
  "schemaVersion": 1,
  "issuer": "codex",                 // codex | claude | human
  "sessionId": "sess-20260808-01",   // AI 会话标识（审计归因）
  "intent": {
    "id": "intent-1786...",          // 幂等键（同 key 重放不重复执行）
    "kind": "core_migrate",          // 见 §4 意图清单
    "target": [-580, -110],          // 最终目标
    "phases": [[-600,-145], [-580,-145], [-580,-110]],  // 分阶段（每段验证后推进）
    "constraints": {
      "avoidEnemyWithin": 25,        // 核心不靠近敌核 25 格内
      "maxStepDistance": 35,         // 单阶段最大步数
      "requireMilitaryEscort": true  // 迁核需军事护航
    },
    "ttlTicks": 1200                 // 超时自动放弃（交还 agent）
  },
  "createdAt": "2026-08-08T06:00:00Z"
}
```

关键属性：
- **幂等**：`intent.id` 唯一，重放同 id 返回已存在，不重复下发。
- **分阶段**：`phases` 让长途意图分段验证（每段到站 → 审计 → 下一段），
  避免 2026-08-08 t1 一次目标 -565,-95 被军事审计拒绝/长距离绕障带偏。
- **TTL**：意图超时自动取消，防 AI 会话中断后命令永久悬挂（stale-override 已有
  10min 兜底，意图层在 goals 之上再叠 TTL 语义）。

## 4. 意图清单（v1）

| kind | 语义 | 展开为 | 护栏 |
|---|---|---|---|
| `core_migrate` | 核心分阶段迁移 | phases 逐段 START_MOVE + 让位 | 敌核贴脸/弃富投贫/信标禁区 |
| `squad_attack` | 编队攻击目标（核心/单位） | 单位 goto 目标 + 集火 | 目标必须已知、兵力≥阈值 |
| `squad_patrol` | 编队巡逻/侦察 | 单位 goto 路径点 | 不越核心防区过远 |
| `worker_mine` | worker 采矿目标 | goals kind=mine | 目标必须为已知活跃矿 |
| `worker_relocate` | worker 疏散/待命 | goals kind=goto | 不送矿入敌区 |
| `core_guard` | 核心防御布阵 | 军事单位守位 | 守位半径内无己方拥挤 |

v1 只实现 `core_migrate` + `worker_relocate`（当前生产最痛）；其余留接口。

## 5. 安全护栏（guardrails.ts）

复用 migration-audit 的判定（资源贫瘠/敌核贴脸），扩展到通用命令：

1. **敌核贴脸**：意图目标 60 格内活跃敌核 >0 → 拒绝/告警（`avoidEnemyWithin` 收紧）。
2. **弃富投贫**：迁核目标区新鲜资源 < 阈值 → 拒绝（除非 `force=true` + 理由）。
3. **信标禁区**：`(-11,-1)` 60 格内 → 拒绝（2026-08-08 t4 送死区实证）。
4. **单位能力**：unitType 与动作匹配（VANGUARD 不采矿、WORKER 不主攻）。
5. **资源自杀**：worker_relocate 目标进入已知敌核 24 格 raid 圈 → 拒绝。
6. **双写保护**：同一 tenant 同时只允许一个 `issuer` 的活跃 intent
   （human 手操优先抢占，AI 自动让位）。

护栏返回结构化拒绝：`{ ok:false, reasons:[{code, detail, evidence}] }`，
审计流水记录，AI 可读原因自动纠错（改目标/加 force 理由）。

## 6. 冲突仲裁（arbiter.ts）

优先级：**human（手操） > AI（codex/claude） > deterministic agent > safety**。

- human-commands `mode=disabled` → 全局交还 agent（AI 意图也不下发）。
- 同一单位：human command > AI command > agent 计划。
- AI intent 与 agent 目标冲突（如迁核 vs 经济采集）：意图层在展开时做
  **目标净空**（让位/疏散），不覆盖 agent 的经济/防御基本盘。

仲裁输出：`{ plan, applied:[...], deferred:[...], reasons:[...] }`，
每次仲裁写入审计。

## 7. 审计与可观测（audit.ts）

- 命令流水：`data/runtime/command-audit/{t}.jsonl`（append-only）：
  `{ ts, issuer, sessionId, intentId, kind, action, status: accepted|rejected|expired|applied, reasons, evidence }`。
- 证据链：拒绝/告警附 `evidence`（敌核记忆、资源新鲜度、单位占用快照），
  AI 与人类都能回溯"为什么这条命令没生效"。
- 指挥面板可接入 `/api/audit/command`（现有 human audit 扩展）。

## 8. 算法优化点（与 command-plane 联动）

1. **核心迁移让位**（本会话已实现）：目标格被占 → 同 tick 让位 + START_MOVE；
   让位期间不判停滞；让位目标 2 格外（防回堵）。→ 固化进 `core_migrate` 意图。
2. **停滞检测自适应**：目标格空才判停滞（6 轮）；目标格被占=让位中不算。
3. **分阶段迁移**：长途拆段，每段审计 + 敌核重扫。
4. **军事护航**：迁核时最近 VANGUARD 编队 goto 核心前方（占位护核）。
5. **资源带决策**：迁核目标由 survey `resource_seen_history` 聚类选点
   （矿刷新频率最高的区域），而非盲选中点。

## 9. 落地路线图

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | watchdog t4 低人口豁免 | ✅ 已上 v3（9e87836） |
| 2 | 核心迁移让位 + 直迁 driver | ✅ 原型（core-migrate-driver.mts 增强） |
| 3 | command-plane 协议 + 护栏 + 仲裁（本设计） | 🔨 设计中 |
| 4 | arena-ctl CLI（读状态/下发意图/审计） | 待实现 |
| 5 | human-override 意图执行扩展（intent → goals） | 待实现 |
| 6 | 指挥面板接入（/api/command v2 + 审计页） | 待实现 |
| 7 | MCP 工具（codex/claude 原生调用） | 待实现 |

## 10. 约束与纪律

- **不新增 writer**：command-plane 只写 human-commands（现有单 writer 路径）+ 审计文件。
- **不覆盖 agent 基本盘**：意图默认保留 agent 经济/防御决策，只叠加高价值操作。
- **fail-closed**：护栏数据不可读 → 拒绝（不是放行）；`force` 必须有 AI 理由留痕。
- **可回滚**：`arena-ctl cancel <intent-id>` 立即交还 agent；mode=disabled 一键全局交还。
