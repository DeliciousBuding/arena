# Pi fork 补丁清单（Arena 相关）

> 归档注（2026-08-04）：本台账的迁出项已全部落地到 `packages/pi-arena` 原生 extension；
> 文中「待 Phase 2 实施」的 RPC run correlation / abort 补丁未实施，服务器 Pi 模式的
> 当前状态以 `docs/progress/MASTER.md`「尚未完成」与 `docs/ops/server-deployment.md` §6 为准。
> 原始记录日期：2026-08-02。原则：**名字带 arena 的实现迁出 Pi core 成为标准 Extension**；
> Pi fork 只保留可贡献上游的通用修复。

## 一、迁出项（→ packages/pi-arena 原生 extension）

| 文件/flag | 现状 | 去向 |
|---|---|---|
| `core/tools/arena-plan.ts` | Pi core 内 | `packages/pi-arena/src/tools/arena-plan.ts`（registerTool） |
| `core/tools/arena-map.ts` | Pi core 内 | `packages/pi-arena/src/tools/arena-map.ts`（registerTool） |
| `--arena-tools` | args.ts/main.ts | 删除（extension + 工具白名单替代） |
| `--arena-map-url` | args.ts/main.ts | 删除（环境变量 `ARENA_MAP_URL` 注入 extension） |
| Arena prompt/session 策略 | main.ts 注入 | extension context/lifecycle |

## 二、保留项（通用修复，可贡献上游）

| 改动 | 说明 |
|---|---|
| `AnyToolDefinition` 导出 + `customTools` 类型放宽（agent-session.ts/sdk.ts） | SDK 扩展口类型修复，任何带 renderCall 的自定义工具都需要 |
| `defineTool` 用法 | types.ts 已提供，保留 |
| （候选）RPC run correlation / abort 补丁 | 任何 RPC 嵌入方都需要，非 Arena 专用——未实施（见归档注） |

## 三、契约 SSOT（contracts/）

- `contracts/arena-plan.schema.json` — arena_plan 工具/parser 共用
- `contracts/world-query.schema.json` — arena_map 工具/查询端点共用
- 协议版本 1.0；双端 schema hash 校验在 Phase 2 handshake 落地（未实施，见归档注）

## 四、双仓库固定（Phase 0 现场）

- arena: `6a2a5b1`（记录时）
- pi-dev（arena-llm-bridge）: `60687e66d`
- 后续 manifest 以 run 为单位记录 commit 对
