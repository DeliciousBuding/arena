# CLAUDE.md — Arena Hero 游戏接管项目

最后更新：2026-08-02

用官方 Python SDK 自动游玩 Arena Hero 的独立工作区。规则契约 **v0.10**，SDK **arena-hero 0.2.6**（2026-08-02 与线上核对一致）。

## 结构速查

| 路径 | 用途 |
|------|------|
| `tactic.py` | 战术脚本（长跑主力）：`decide_actions(turn)` 纯决策 + 连接循环 |
| `tests/test_tactic.py` | 34 个无凭据决策测试（Fake Turn/Unit，零网络） |
| `scripts/diagnose.py` | 只读诊断：看一帧完整状态，不提交计划 |
| `scripts/sync_docs.py` | 把 skill 内置英文文档同步到 `docs/` |
| `docs/` | 离线权威文档（规则 v0.10 全量、SDK 参考、API 协议） |
| `.env` | API key（**已 gitignore，永不入仓**） |
| `.agents/skills/arena-hero/` | 外部克隆的 skill（独立 git，不入本仓库） |

## 模式与 AGENT 槽约束

- **战术脚本**：`python tactic.py`，常驻后台，自动响应每个 Tick。
- **直接操作**（LLM 逐 Tick 指挥）：skill 自带 `scripts/direct_session.py`；15 秒窗口，可能错过 Tick，不是 24h Bot。
- **关键约束**：两者共用同一 AGENT 计划槽，同一 Tick 后提交完整替换前者——**不能同时提交**。切换：停脚本 → 起桥 → 结束后重启脚本。

## 命令

```bash
python tactic.py                 # 运行（.env 读 key，-u 无缓冲看实时日志）
python -m pytest tests/ -q       # 决策测试
python -u scripts/diagnose.py    # 只读诊断一帧状态
python scripts/sync_docs.py      # 同步 skill 文档到 docs/
```

## 战术设计要点（v0.10 规则）

- Worker：先交付后采集；空手有资源格→最近格；无资源→朝 Beacon 巡逻（坐标永远公开）
- 生产：Worker 到 8 后 Vanguard/Ranger 交替；人口上限 20（tier 0 免 upkeep）；spawn 后保留 3 资源
- 恢复：受损单位在自家静止 Core 格自动 HEAL；Core 先 HP 后盾后生产（heal 需 Core 非 MOVING）
- 战斗：Vanguard 相邻 SWEEP；Ranger 只射 8 方向 1-3 格直线无遮挡目标
- 确定性：对象按 UUID 排序、目标按 (距离,x,y)、方向固定轴优先
- 异常态：Core 为 None（RESPAWNING）时不伪造动作；Core 容量 `max(10, pop×5)`
- 完整规则：`docs/game-rules.md`，数值速查 `docs/reference-numbers.md`

## 红线

- 秘钥只在 `.env`；改代码/测试后 grep 确认无 `ah_live` 字样
- 不重建 SDK 的 WebSocket/重连/回执逻辑；协议异常先升 SDK
- 规则数值改动必须对照 `docs/game-rules.md`，禁止凭记忆猜
