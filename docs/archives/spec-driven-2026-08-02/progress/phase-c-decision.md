# Phase C: 决策内核 I（Batch 3）

最后更新：2026-08-02

里程碑：**M3 决策无回归** — 38+ 测试全绿、确定性保持

## 任务

- [x] C1: `strategy.py` 策略接口 + Plan 模型
  - 验收：Strategy 基类 `decide(tick_state, world) -> Plan`；Plan 含单位动作/核心动作/意图；可独立实例化 —— **通过（Action 纯数据 + apply_plan 执行器）**
  - 测试：接口单测
- [x] C2: `BalanceStrategy` 迁移（现有 decide_actions 全逻辑）
  - 验收：采集/交付/巡逻/战斗/生产/Beacon 逻辑等价迁移；参数从 config 读；38 例测试迁移并全绿 —— **通过（35 例迁移全绿，总计 87 例）**
  - 测试：迁移后测试全量通过 + 确定性测试保持

## Notes

- C2 是本重构的最高回归风险点：迁移时逐分支对照旧代码
- 决策顺序保持 tactic-authoring 规定：生命周期→生存→恢复→经济→战斗→移动→Beacon→生产
