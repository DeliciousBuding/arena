# PROGRESS — 任务书 H：命名规范 + 变体库存文档

日期：2026-08-08（周六）

## 任务

arena-ts 多 agent 并行开发导致命名漂移（同一概念多种叫法、变体 id 与 flag 名
不一致、无权威术语表）。本任务只写文档、不改代码：

1. `docs/design/naming-conventions.md` — 命名规范 + 术语消歧表 + 变体 id↔flag 映射表
2. `docs/design/variant-inventory.md` — 变体库存（唯一权威清单，数据全部实读）

## 数据来源（全部实读，2026-08-08 main 工作树）

- `packages/arena-agent/src/strategies/variant-registry.ts`（工作树当前版本，含未提交改动）
  - `VARIANT_SAFETY_CONFIG` 42 项、`DETERMINISTIC_VARIANT_CONFIG` 5 项，共 47 项
- `ARENA_REPO_ROOT/data/runtime/configs/t1-4.json` 的 `variants` 数组（只读）
- 术语消歧涉及源码（shadow/phase/threat/矿记忆/core/home/base/bridge 各文件，行号已核对）
- `packages/*/src` 逐 flag grep 命中文件数（排除 variant-registry.ts 自身）

## 实读发现（与任务书预期的一处差异）

任务书预期"7 个注册但无租户启用"含 `core-evade-v1`；实读 t2.json 的 variants
数组包含 `core-evade-v1`（t2 同时启用 core-evade-persist-v1 / core-evade-ttr-v1）。
实际无租户启用的注册变体为 **6 个**：clear-path-v1、beacon-grab-v1、
bounded-raid-v1、ranger-memory-shot-v1、threat-breakout-v1、
population-ceiling-30-v1。库存文档按实读数据落笔，并在脚注标注该差异。

## 产出

- [x] `docs/design/naming-conventions.md`
- [x] `docs/design/variant-inventory.md`
- [x] 本文件（任务进度记录）
- [ ] commit（仅以上三个文件，不入 src/、configs/、根仓）

## 验收

```bash
ls docs/design/naming-conventions.md docs/design/variant-inventory.md
rg -n "remoteReinforce|detachedSquadResponse|militaryScavengeFrontier|threatMilitaryPriority" docs/design/naming-conventions.md
rg -n "coordinated-fire-v1|ranger-scavenge-v1|ranger-kite-v1" docs/design/variant-inventory.md
git status --porcelain   # 预期：仅新文档 + PROGRESS.md 纳入 commit
git log --oneline -1     # 1 个 commit
```
