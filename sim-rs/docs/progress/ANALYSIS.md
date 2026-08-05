# 分析线状态（rust-rewrite worktree）

> 本 worktree 是 rust 重写线的**纯分析/规划场所**（用户裁决：研究也应 fork 出执行线）。
> 执行线 = rust-sim worktree（rust-sim 分支）；分析线 = 本 worktree（rust-rewrite 分支，
> 基于 rust-sim@e6bd3d6 fork）。
> 最后更新：2026-08-05。

## 角色边界（用户裁决，2026-08-05）

- 本 agent 只做**思考与规划**，不执行代码任务、不推进执行线
- 执行线事务（6 CLI 产物、golden.json、子代理验收）归执行线 owner，本线只读引用
- 执行痕迹处置（e6bd3d6 提交去留）：用户裁决，未决

## 分析产物清单（本线交付）

| 文档 | 内容 |
|---|---|
| `docs/analysis/project-overview.md` | 项目全景、覆写方向、当前基线、调研方法论 |
| `docs/analysis/module-inventory.md` | 模块清单 + S.U.P.E.R 评分 + Go 对偶规格表 |
| `docs/analysis/risk-assessment.md` | 风险矩阵（R1-R7）+ 止损 + 防作弊 + 反向验证 |
| `docs/plan/task-breakdown.md` | 任务总表 A-J（P0/P1/P2）+ 测试与治理要求 |
| `docs/plan/dependency-graph.md` | 依赖图（Wave 2-4）+ 并行编排 + 批次规划 |
| `docs/plan/milestones.md` | M1-M5 里程碑（M1 已达成） |

## 关键分析结论（速览）

1. **值得做**：Go 慢在热路径数据结构（string-key map BFS + GC churn），Rust 结构性消除，单核已实测 12.1x
2. **风险在语义对齐不在性能**：差分门禁（同场景同 seed 输出 diff）+ golden 容差核验是核心验收
3. **契约坑已识别**：场景 JSON PascalCase（Go case-insensitive 掩盖）；policy 名格式；评分公式；容差常量
4. **执行线下一步**：B/C/D 产物复核提交 → E 差分门禁 → F 收尾（详见 task-breakdown.md）

## 复核基线

- 本分析全部事实基于 rust-sim@e6bd3d6 + Go go-rewrite@c10f2d6 源码逐行调研
- 执行线新提交后：本线文档的"状态"列需复核更新（M2 阶段）
