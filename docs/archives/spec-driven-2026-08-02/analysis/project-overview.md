# Project Overview — Arena Hero 游戏接管项目

最后更新：2026-08-02（Phase 1 分析）

## 项目定位

用官方 Python SDK（arena-hero 0.2.6）自动游玩 Arena Hero（规则 v0.10）的本地工作区。
共享世界、15 秒/Tick 指令窗口、确定性结算。当前由单文件战术脚本长期后台运行。

## 技术栈

| 项 | 值 |
|---|---|
| Python | 3.12.10（系统级，SDK 要求 ≥3.11） |
| SDK | arena-hero 0.2.6（PyPI，`import arena_hero`） |
| 测试 | pytest（38 例，Fake Turn/Unit 零网络） |
| 包管理 | 无 pyproject（pip 全局安装）——**目标：uv** |
| 运行方式 | `python -u tactic.py` 后台进程 |
| 秘钥 | `.env` → `ARENA_HERO_API_KEY`（gitignore） |

## 目录现状

```
arena/
├── tactic.py           # 300 行：连接 + 决策 + 日志全混合
├── tests/test_tactic.py # 477 行：38 例决策测试
├── scripts/
│   ├── diagnose.py     # 只读诊断一帧状态
│   └── sync_docs.py    # skill 文档 → docs/
├── docs/               # 离线权威文档（v0.10 契约全套 + 索引）
├── CLAUDE.md           # 项目规则手册（指令面，已存在）
├── .env                # 秘钥（gitignore）
└── .agents/skills/arena-hero/  # 外部 skill（独立 git）
```

## 运行事实（实测 2026-08-02）

- 战术脚本自 tick 38294 持续运行，每 Tick 提交被接受（accepted=True）
- 经济循环已打通：巡逻采集 → cargo 回家 → 交付 → 动态 reserve spawn；目前 2 Worker
- 曾出现 70+ tick 零采集僵局（出生点资源竞争/视野 3 太小），经巡逻半径限制后改善
- 全程无敌人遭遇（出生点偏远，beacon 距离 >160）

## 约束

- 规则契约 v0.10（docs/game-rules.md），SDK 0.2.6，2026-08-02 与线上核对一致
- AGENT 计划槽唯一：战术脚本与直接操作桥不能同时提交
- 秘钥永不入仓、永不打印
