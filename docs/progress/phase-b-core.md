# Phase B: 核心库（Batch 2）

最后更新：2026-08-02

里程碑：**M2 核心库就绪** — 日志轮转验证、记忆 Fake 序列测试

## 任务

- [ ] B1: `logging_util.py` 轮转日志 + stdout 双写
  - 验收：logs/arena.log 生成；格式 `[tick][level] msg`；tick 上下文关联；大小轮转保留 5 份
  - 测试：日志格式/轮转单测
- [ ] B2: `world.py` 环境记忆（障碍永久 / 资源状态表 / 敌人跟踪，stale 标记）
  - 验收：跨 Tick Fake 序列测试正确更新；决策永远优先当前 Turn 可见数据；HARVEST_FAILED 更新资源状态
  - 测试：记忆更新单测
- [ ] B3: `core/state.py` Turn 适配层
  - 验收：类型化封装 + 索引预计算（单位/敌人/资源）；决策层不直接依赖 SDK 细节
  - 测试：适配层单测

## Notes

- 记忆层设计红线：**记忆只做附加线索，主路径永远用当前 Turn 权威状态**（规则：视野外不可信）
- 障碍是永久地形（规则：obstacles 永久），可安全长期记忆
