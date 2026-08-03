# 交接文档：pi 作为 LLM 接入 arena（RPC 热着桥接实验）

> 交接时间：2026-08-02 | 交接人：Claude 会话 | 状态：**已落地（2026-08-02 收尾）：原生工具调用 + retry/fallback 全链路 + 离线验证通过**

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
| RPC 桥接脚本 v2 | ✅ 已验证 | `arena/scripts/pi_rpc_bridge.py`（长驻进程版，3/3 tick 走工具路径） |
| arena_plan 原生工具 | ✅ | pi-dev `core/tools/arena-plan.ts`：TypeBox schema + renderCall/renderResult + terminate（见 §4.1） |
| 完整决策链路 | ✅ | retry + 分级 fallback + 进程自愈（见 §4.2），126 测试全绿 |

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

## 4. 桥接脚本 v2 设计（pi_rpc_bridge.py，已验证）

- **长驻**：`node cli.js --mode rpc --model newapi/deepseek-v4-flash --session-dir logs/pi_rpc_sessions`
- **协议**：stdin/stdout JSONL。发 `{"id":"tick-N","type":"prompt","message":...}`，等 `agent_settled` 判定完成；决策主输出走 **`tool_execution_start` 事件**（原生工具调用，含结构化 args），`turn_end` 供 thinking/文本渲染
- **缓存友好**：第一 Tick 注入完整 RULES，之后只发局势增量 → 会话历史前缀稳定 → DeepSeek 服务端 context cache 命中（94%+）
- **离线演化**：`evolve_state()` 模拟早期扩张（资源递增、每 8 tick 造 1 Worker），真实接入时替换为游戏新 Tick
- **实测**：3/3 tick 走 `arena_plan` 工具路径；首 tick 10.7s（含 RULES 全量），缓存命中后 2-3s；输出为结构化 JSON（actions+reason）

## 4.1 原生工具调用（arena_plan，pi-dev 侧）

- 工具定义 `pi-dev/packages/coding-agent/src/core/tools/arena-plan.ts`，注入走 CLI `--arena-tools`（`noTools="all"` + `tools=["arena_plan"]`，模型只看得到这一个工具）
- **完全按 pi 原生工具模式**（参考 bash.ts）：TypeBox schema（actions/core/reason，additionalProperties:false）、promptSnippet/promptGuidelines、`execute` 返回 `{content, details, terminate:true}`（提交后立即结束回合，不烧 token）、**renderCall/renderResult**（🎯 标题 + 计划摘要 + `Took X.Xs`，pi TUI 里像 bash 一样原生渲染）
- 事件流：`tool_execution_start` 带 `toolName` + `args`（结构化 JSON，Python 侧决策主输入）；`turn_end` message blocks 是 **`toolCall`**（pi 原生命名，`arguments` 字段）——Python `_extract_result` 两者都认（兼容 Anthropic 风格 `tool_use`/`input`）
- 工具 schema 变更路径：改 arena-plan.ts → `cd pi-dev/packages/coding-agent && npm run build`（dist/cli.js 是运行时入口）

## 4.2 完整决策链路（Python 侧，LLMStrategy）

`decide()` 按优先级降级，绝不空手而归：

1. **主路径**：原生 tool calling → `parse_tool_plan` 严格校验（单位归属/动作白名单/枚举/坐标/重复）→ Plan
2. **兼容路径**：工具未调用或校验失败 → 文本 JSON → `parse_llm_plan`
3. **兜底路径**：全部失败 → `fallback.decide()`（确定性 balance）

健壮性（`src/arena_bot/llm/`）：
- **retry**：瞬态失败（TimeoutError/OSError/RuntimeError）指数退避重试 `llm_retries`（默认 2）次，`llm_retry_delay`（默认 2s）基数；校验类失败不重试（模型行为问题，直接降级）
- **进程自愈**：`PiRpcBackend._ensure_alive()`——pi RPC 进程崩溃自动重启 + 重握手
- **决策统计**：`strategy.stats`（calls/tool_ok/text_ok/fallback/retries/latency）供观测
- **配置**：`llm_arena_tools`（唯一工具模式默认开）、`llm_retries`、`llm_retry_delay`、`llm_timeout`（默认 60s，注意 15s 游戏窗口需留余量）

## 4.3 观察 LLM 决策（用户问题：怎么像对话流一样看 pi 工作流）

**渲染不自己做——pi 原生就是对话流渲染器**：
- **pi TUI 交互模式**：`node pi-dev/packages/coding-agent/dist/cli.js --arena-tools --model newapi/deepseek-v4-flash`（在 arena 目录起交互终端，arena_plan 调用按 bash 同款卡片渲染，含 thinking/摘要/耗时）
- **RPC 会话导出**：`{"type":"export_html"}` 命令把整场会话导出渲染好的 HTML 对话流
- **离线脚本**：`scripts/pi_rpc_bridge.py --ticks N --arena-tools`（每 tick 打印决策摘要 + CSV 报告）

## 5. 踩坑记录（勿重踩）

1. **build 失败**：`generate-models` 拉 models.dev 被墙超时 → 用 `NODE_OPTIONS=--use-env-proxy npm run hydrate:model-data` 先拉数据，再 `npm run build:offline`
2. **Node fetch 不走代理**：undici 原生 fetch 不读 HTTPS_PROXY，Node 24 需 `--use-env-proxy` 标志
3. **CLI 无 `-m`**：pi CLI 只认 `--model` 全称
4. **RPC 无短参**：`--mode rpc`；Windows 上 stdout 读取不能用非阻塞管道（已用 reader 线程+队列解决）
5. **首次调用 39s**：一次性模型目录刷新拖累，热着后 3.3s，RPC 长驻后更快
6. **customTools 类型**：带 renderCall 的工具在 `ToolDefinition[]`（默认泛型）下逆变失败 → SDK 扩展口类型放宽为 `AnyToolDefinition[]`（agent-session.ts/sdk.ts），工具定义用 `defineTool()` 保留参数推断
7. **turn_end 的 block 是 `toolCall`** 不是 `tool_use`（pi 原生命名）——提取层两者都认，决策主输入仍是 `tool_execution_start`

## 6. 待办（下一步）

- [x] 验证 `pi_rpc_bridge.py` 连跑（3/3 tick 工具路径，延迟 2-10s）
- [x] 合法性校验层：`parse_tool_plan` 严格校验 + 非法回退确定性策略
- [x] retry/fallback/进程自愈/决策统计（§4.2）
- [x] arena_plan 原生化：renderCall/renderResult + `--arena-tools` 唯一工具模式
- [ ] 接真游戏：t4（deliciousbuding）——**红线：需用户明确确认后**，experiments YAML 加 `strategy: llm`，调度器走同一套
- [ ] 长跑观察：缓存命中率（NewAPI 渠道 790）、决策质量、llm_timeout 与 15s 窗口的余量实测

## 7. 安全红线

- NewAPI key 只在 `[user-home]/.pi/agent\models.json`（用户级配置），**不入任何 git 仓库**
- arena 秘钥只在 `.env`（gitignore）；改代码后 grep 确认无 `ah_live` 字样
- 游戏规则数值对照 `arena/docs/game-rules.md`，禁止凭记忆猜
- 不干扰运行中的 3 个租户（t1/t2/t3，端口 8123-8125）
- pi worktree 是 pi 仓库分支 `arena-llm-bridge`，commit 前确认分支（勿提交到 main）

## 8. 成本参考（实测）

- 每 Tick 决策：输入 ~20k token，缓存命中 ~94%（$0.14/M 输入→缓存价），单次约 **$0.0005**
- 延迟：FRT 0.4s，全响应（1155 输出 token）14s → 决策输出几十 token 时 ~1-2s
