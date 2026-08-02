# Arena Hero — 游戏接管工作区

用官方 Python SDK（`arena-hero` 0.2.6）自动游玩 Arena Hero（规则 v0.10）。

## 两种模式

| 模式 | 文件 | 说明 |
|------|------|------|
| 战术脚本（长跑主力） | `tactic.py` | 纯决策函数 `decide_actions(turn)`，确定性选择，常驻后台运行 |
| 直接操作（LLM 指挥） | skill 自带 `scripts/direct_session.py` | 本会话逐 Tick 决策提交；15 秒窗口内可能错过 Tick，不能当 24h Bot |

同一 Tick 内，战术脚本与直接操作桥共用 **同一个 AGENT 计划槽**，后提交完整替换前者——两者不能同时提交。切换方式：停掉 `tactic.py` → 启动 direct bridge → 结束后重启 `tactic.py`。

## 运行

```bash
python -m pip install 'arena-hero>=0.2.6,<0.3'
python tactic.py              # 从 .env 读 ARENA_HERO_API_KEY
python -m pytest tests/ -q   # 无凭据决策测试
```

秘钥只存于 `.env`（已 gitignore），永不入仓。

## 文档

离线权威文档在 `docs/`（规则 v0.10 / SDK 0.2.6，2026-08-02 与线上核对）：`docs/game-rules.md` 全量规则、`docs/reference-numbers.md` 数值速查、`docs/sdk-reference.md` SDK 参考。索引见 `docs/README.md`，`scripts/sync_docs.py` 可重新同步。

## 战术策略（平衡型）

- Worker 采集 → 回家交付；cargo 满时优先回家；无可见资源回家待命
- 优先造 Worker 到 8 个，之后 Vanguard/Ranger 交替
- 人口上限 20（tier 0 免 upkeep）；spawn 后保留 3 资源应急
- 受损单位在自家静止 Core 格自动 HEAL；Core 先补 HP 再修盾再生产
- Vanguard 相邻 SWEEP、逼近敌人；Ranger 只射 8 方向 1-3 格无遮挡目标
- 地面 Beacon 同格自动拾取（采集 2 倍收益）
- 全部决策确定性：UUID 排序、固定轴优先、障碍回避
