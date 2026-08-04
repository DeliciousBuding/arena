# 进度跟踪（06）

> 状态：进行中。本文档是 Go 重写分支的进度 SSOT（与主线 `docs/progress/MASTER.md` 无关，
> 不合并、不覆盖）。每批完成即更新；差异日志是行为漂移的唯一记录。

## 批次状态

| 批 | 内容 | 状态 | 用例数 | 覆盖率 | 差异日志 |
|---|---|---|---|---|---|
| B1 | 地基（go.mod/骨架/门禁/CI/version） | ✅ `229fa77` | 7 | 100%（version） | — |
| B2 | contracts + 黄金对齐 | 🔄 执行中 | — | — | — |
| B3-A | hero 协议客户端 | ⬜ | — | — | — |
| B3-B | domain（reducer/nav/world/validator/hash） | ⬜ | — | — | — |
| B3-C | telemetry | 🔄 执行中 | — | — | — |
| B4-A | strategy（safety/deterministic/policy 类型） | ⬜ | — | — | — |
| B4-B | mapstore | ✅ 待提交 | 17（含 6 子用例 23） | 84.9% | — |
| B5-A | runtime（lease/coordinator/arbiter/loop） | ⬜ | — | — | — |
| B5-B | llm + agent（AgentLoop/Harness） | ⬜ | — | — | — |
| B6 | policy 决策 + harness 工具集成 | ⬜ | — | — | — |
| B7-A | ops（锁/supervisor/health） | ⬜ | — | — | — |
| B7-B | sim（Digital Twin 核心） | ⬜ | — | — | — |
| B8 | cmd 集成 + 回放/差分 + 真机 t3/t4 | ⬜ | — | — | — |
| B9 | 部署（镜像/systemd/CI release） | ⬜ | — | — | — |
| B10 | 验收收尾与归档 | ⬜ | — | — | — |

## 真机证据记录（t3/t4）

| 日期 | 步骤 | 证据（run/manifest/JSONL 路径） | 结果 |
|---|---|---|---|
| — | — | — | — |

## 差异日志（行为漂移唯一记录）

> 规则：任何与 TS 版期望不一致的输出必须在此登记：分类（规则升级/修复/服务器私有/
> Go bug）、fixture 区间、理由、豁免范围。未登记的差异 = 未通过。

| 日期 | 分类 | 区间/字段 | 描述 | 处置 |
|---|---|---|---|---|
| — | — | — | — | — |

## 当前焦点

- [x] 基线：198 个 TS/Python/Node 文件清出（`2caebdb`）
- [x] 设计定稿：00-intent / 01-architecture / 02-contracts / 03-module-spec /
      04-test-strategy / 05-delivery-plan（2026-08-05）
- [x] B1 地基：go.mod、目录骨架、门禁脚本、CI、version 包（`229fa77`，门禁全绿）
- [ ] B2 契约：contracts 三组结构体 + 黄金对齐测试（执行中）
- [ ] B3-C 遥测：JSONL/轮转/脱敏/manifest（执行中）
- [ ] B3-A/B3-B：等 B2 完成后派发（hero / domain）
- [x] B4-B mapstore：SQLite WAL 知识层（17 用例 / 84.9% 覆盖，双进程并发验证通过）
