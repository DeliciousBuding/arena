# @arena/arena-hero-ts

Arena Hero 游戏 SDK 的 TypeScript 实现，**fork 自 [arena-hero/arena-hero-python](https://github.com/arena-hero/arena-hero-python)**（Apache-2.0）。

## 位置与结构（arena 单仓 monorepo）

```
packages/arena-hero-ts/
  src/               ← TS 实现（本包）
  test/              ← TS 测试
  contracts/         ← 契约产物（generated/ JSON Schema + fixtures/ 真实样本）
  scripts/           ← 契约产物生成
reference/arena-hero-python/   ← 官方 Python SDK 源码镜像（追上游对照，见 sync-log.md）
```

- 追上游：`reference/arena-hero-python/sync-log.md`（官方仓库更新 → 对照镜像 → 手动同步协议变更到本包）
- 协议事实来源：官方 src/arena_hero/ 源码 + 官方 changelog

## 设计基线

- 运行时依赖：`typebox`（wire schema 单源）+ `ws`（WebSocket）
- 消费方（arena-agent 编排层）以 npm workspace 引用（`"@arena/arena-hero-ts": "*"`），本地直接解析，无 git pin
- wire 校验分层：TypeBox 字段级（wire-schema.ts）+ domain 关系约束（types.ts）
