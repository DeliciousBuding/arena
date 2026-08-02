# fork 同步日志：arena-hero-python → TS SDK

上游：https://github.com/arena-hero/arena-hero-python（Apache-2.0）
TS 实现：本仓库 `packages/arena-hero-ts/`（2026-08-02 起并入 arena monorepo；原 public fork DeliciousBuding/arena-hero-ts 冻结保留历史）

## 同步流程

1. 官方仓库更新（版本/changelog）→ 对照本目录源码镜像差异
2. 镜像更新：`reference/arena-hero-python/arena_hero/` 替换为官方最新源码（保留 LICENSE 与版本记录）
3. **协议变更必须手动同步到 TS 实现**（packages/arena-hero-ts/），在本文件追加记录

## 变更记录

| 日期 | 上游版本 | 变更 | TS 同步状态 |
|------|---------|------|------------|
| 2026-08-02 | 0.2.6 | fork 基线（含 healing/CORE_RESOURCES_CAPTURED 类型化） | ✅ 已含于首版实现 |
| 2026-08-02 | - | v0.11 规则（upkeep 伤害多余单位，Core 安全） | ✅ 规则逻辑在编排层（game-rules.md），SDK 无 upkeep 逻辑 |

## TS 实现差异说明（有意为之）

- **API 形态**：Python 同步迭代器 → TS async 迭代器（`turns()`）
- **UUID**：Python UUID 类型 → TS string（JSON 面一致）
- **模型**：pydantic 运行时校验 → TS 接口 + 网络边界窄校验（protocol.ts）
- **WS 客户端**：websockets 库 → `ws` 包（Node 内置 WebSocket 不支持认证 header）
- **编码**：encodePlan 与 Python sort_keys+exclude_none 逐字节兼容（交叉验证 MATCH）
