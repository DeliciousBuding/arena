# CLAUDE.md — Arena Hero 游戏接管项目

最后更新：2026-08-02

用官方 Python SDK 自动游玩 Arena Hero 的独立工作区（uv 管理）。规则契约 **v0.10**，SDK **arena-hero 0.2.6**（2026-08-02 与上游 commit ad6fc27/4a29585 核对一致）。

## 结构速查

| 路径 | 用途 |
|------|------|
| `src/arena_bot/main.py` | 主入口：连接 + 决策链路 + 调试端点（`uv run python -m arena_bot.main`） |
| `src/arena_bot/` | 包：strategy 决策抽象 / strategies.balance / phase_machine / world 记忆 / core 状态与导航 / config / logging_util / debug_api |
| `tests/` | 106 例无凭据测试（Fake TickState，零网络） |
| `scripts/` | diagnose 只读诊断、compare_legacy 新旧对比、sync_docs 文档同步 |
| `docs/` | 离线权威文档 + ARCHITECTURE.md（架构） |
| `legacy/` | 旧单文件 tactic.py（切换后保留待删） |
| `.env` | API key（**已 gitignore，永不入仓**） |
| `.agents/` | 外部 skill + 上游 clone（arena-hero-doc / arena-hero-python，独立 git，不入本仓库） |

## 命令

```bash
uv run python -m arena_bot.main     # 运行（.env 读 key）
uv run pytest tests/ -q             # 106 例测试
uv run python -m arena_bot.main --help  # 无；参数走 config.py
uv run python scripts/compare_legacy.py  # 新旧决策对比
python scripts/sync_docs.py         # skill 文档 → docs/
curl http://127.0.0.1:8123/state    # 调试端点：状态快照
```

## 调试与人工介入

- 端点 `http://127.0.0.1:8123`：`GET /state`、`GET /strategies`、`POST /command`
- 指令白名单：`pause`（暂停提交=观察）、`resume`、`set_param {name,value}`、`set_phase {phase}`
- 阶段：early_expansion / balanced / military；参数：explore_radius、worker_target、pop_ceiling 等（config.py）

## 架构要点（详见 docs/ARCHITECTURE.md）

- 每 Tick：TickState → 事件→world → 阶段机 → Strategy.decide→Plan → apply_plan → submit
- 决策确定性：UUID 排序、固定轴优先、记忆只做线索、当前 Turn 永远权威
- Worker 意图状态机（PATROL/GO_HARVEST）跨 Tick；HARVEST_FAILED 格冷却 4 tick
- 策略接口可插拔：新策略继承 `Strategy` 实现 `decide()`

## 红线

- 秘钥只在 `.env`；改代码后 grep 确认无 `ah_live` 字样
- 不重建 SDK 的 WebSocket/重连/回执；协议异常先升 SDK（`uv sync` 后对比测试）
- 规则数值改动必须对照 `docs/game-rules.md`，禁止凭记忆猜
- SDK 方法签名以 `.agents/skills/arena-hero-python/src/arena_hero/` 源码为准（如 shoot 的 expected_cell 仅关键字）
