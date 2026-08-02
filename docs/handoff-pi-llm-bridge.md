# 交接文档：pi 作为 LLM 接入 arena（RPC 热着桥接实验）

> 交接时间：2026-08-02 | 交接人：Claude 会话 | 状态：**基础设施已就绪，桥接脚本已写待验证**

## 1. 目标（一句话）

让 **pi agent（Pi Agent Harness，TS）作为游戏决策大脑**驱动 arena（Arena Hero 游戏接管，Python）：
`arena(Python) → pi RPC 长驻进程 → NewAPI(api.tokendancelab.com) → deepseek-v4-flash`，
每 Tick 由 LLM 自主决策（含局势判断），Python 侧合法性校验后提交。

**当前阶段：先不接入真游戏，离线连跑几十 Tick 验证稳定性/延迟/缓存/决策质量。**

## 2. 已完成（勿重复）

| 事项 | 状态 | 说明 |
|---|---|---|
| pi 源码 clone | ✅ | `[pi-repo]`（main，未动） |
| pi 二开 worktree | ✅ | `[arena-repo]\pi-dev`，分支 `arena-llm-bridge`（pi 仓库独立分支） |
| pi 依赖+构建 | ✅ | `npm install --ignore-scripts` + `npm run build:offline` 通过，CLI 可用 |
| 模型数据拉取 | ✅ | 关键坑：models.dev 被墙 → `NODE_OPTIONS="--use-env-proxy"` 走 Clash 7897 |
| NewAPI provider 配置 | ✅ | `~/.pi/agent/models.json`：newapi provider + deepseek-v4-flash（1M 上下文） |
| 压缩阈值配置 | ✅ | `~/.pi/agent/settings.json`：compaction.reserveTokens=500000（500k 触发） |
| 单次问询验证 | ✅ | `pi -p` 实测 3.3s（热）；NewAPI 连通正常 |
| 缓存验证 | ✅ | NewAPI 原生透传 DeepSeek context caching，实测 94-98% 前缀命中 |
| 干跑脚本 v1 | ✅ | `arena/scripts/pi_dryrun.py`（一次性子进程版，只读） |
| RPC 桥接脚本 v2 | 🟡 已写未验证 | `arena/scripts/pi_rpc_bridge.py`（长驻进程版，见 §4） |

## 3. 关键路径与配置（接手方必须知道）

```
pi 主 clone      [pi-repo]                    （main，保持不动）
pi 二开 worktree [arena-repo]\pi-dev          （分支 arena-llm-bridge）
pi CLI 入口      arena\pi-dev\packages\coding-agent\dist\cli.js
pi 配置          [user-home]/.pi/agent\models.json    （newapi provider，key 在此）
                 [user-home]/.pi/agent\settings.json  （compaction 500k）
arena 桥接脚本   arena\scripts\pi_dryrun.py              （v1 单次版，已跑通）
                 arena\scripts\pi_rpc_bridge.py          （v2 长驻版，待验证）
arena 快照       arena\logs\pi_dryrun_snapshot.json     （真实 tick 38639 早期扩张）
arena 报告       arena\logs\pi_rpc_report.csv           （v2 运行后生成）
arena gitignore  arena\.gitignore                        （已加 pi-dev/ 忽略）
```

## 4. 桥接脚本 v2 设计（pi_rpc_bridge.py，待验证）

- **长驻**：`node cli.js --mode rpc --model newapi/deepseek-v4-flash --session-dir logs/pi_rpc_sessions`
- **协议**：stdin/stdout JSONL。发 `{"id":"tick-N","type":"prompt","message":...}`，等 `agent_settled` 判定完成，`turn_end.message.text` 取决策文本
- **缓存友好**：第一 Tick 注入完整 RULES，之后只发局势增量 → 会话历史前缀稳定 → DeepSeek 服务端 context cache 命中（94%+）
- **离线演化**：`evolve_state()` 模拟早期扩张（资源递增、每 8 tick 造 1 Worker），真实接入时替换为游戏新 Tick
- **待办**：① 跑 `python scripts/pi_rpc_bridge.py --ticks 20` 验证 ② 观察 NewAPI 日志缓存命中率（渠道 790） ③ 每 Tick 延迟目标 <5s（FRT 实测 0.4s）

## 5. 踩坑记录（勿重踩）

1. **build 失败**：`generate-models` 拉 models.dev 被墙超时 → 用 `NODE_OPTIONS=--use-env-proxy npm run hydrate:model-data` 先拉数据，再 `npm run build:offline`
2. **Node fetch 不走代理**：undici 原生 fetch 不读 HTTPS_PROXY，Node 24 需 `--use-env-proxy` 标志
3. **CLI 无 `-m`**：pi CLI 只认 `--model` 全称
4. **RPC 无短参**：`--mode rpc`；Windows 上 stdout 读取不能用非阻塞管道（已用 reader 线程+队列解决）
5. **首次调用 39s**：一次性模型目录刷新拖累，热着后 3.3s，RPC 长驻后更快

## 6. 待办（下一步）

- [ ] 验证 `pi_rpc_bridge.py` 连跑 20-30 Tick（延迟/稳定性/决策质量/缓存命中）
- [ ] 合法性校验层：指令解析 + 资源/人口/坐标校验，非法回退确定性策略（`Strategy` 接口天然支持插拔）
- [ ] 决策输出改为精确坐标（当前 LLM 会给"巡逻方向"这类模糊指令，prompt 需迭代）
- [ ] 接真游戏：用空闲账号（.env 有 `ARENA_HERO_API_KEY_4`，t4 端口 8127）——注意 README 红线：**同一 Tick 内一个账号只能一个提交方**，3 个现有租户在跑勿动
- [ ] git 提交策略待用户确认（arena：`.gitignore` 改动 + 2 个新脚本未提交；pi worktree：模型数据为生成物未提交）

## 7. 安全红线

- NewAPI key 只在 `[user-home]/.pi/agent\models.json`（用户级配置），**不入任何 git 仓库**
- arena 秘钥只在 `.env`（gitignore）；改代码后 grep 确认无 `ah_live` 字样
- 游戏规则数值对照 `arena/docs/game-rules.md`，禁止凭记忆猜
- 不干扰运行中的 3 个租户（t1/t2/t3，端口 8123-8125）
- pi worktree 是 pi 仓库分支 `arena-llm-bridge`，commit 前确认分支（勿提交到 main）

## 8. 成本参考（实测）

- 每 Tick 决策：输入 ~20k token，缓存命中 ~94%（$0.14/M 输入→缓存价），单次约 **$0.0005**
- 延迟：FRT 0.4s，全响应（1155 输出 token）14s → 决策输出几十 token 时 ~1-2s
