# Phase D: 状态机 + 调试（Batch 4）

最后更新：2026-08-02

里程碑：**M4 可调试运行** — 状态机测试绿；端点 curl 可查

## 任务

- [x] C3: 全局阶段状态机（EARLY_EXPANSION → BALANCED → MILITARY）
  - 验收：转移规则（资源/人口/敌人威胁阈值）可配置；默认 EARLY 启动；转移单测 —— **通过（6 例转移/强制测试）**
- [x] C4: 单元状态机（Worker PATROL→GO_HARVEST→HARVEST→RETURN→DEPOSIT；战斗 CHASE/GUARD/FIRE）
  - 验收：Fake 序列测试覆盖完整转移链 + HARVEST_FAILED/RESOURCE_DEPLETED 重定向 —— **通过（GO_HARVEST 跨 Tick + 失败清目标 + 回运交付链）**
- [x] D1: `debug_api.py` HTTP 调试端点（127.0.0.1）
  - 验收：GET /state（全状态含记忆）、GET /strategies（阶段/参数）、POST /command（白名单：pause/resume/set_phase/set_param/order）；非法指令拒绝
  - 测试：端点逻辑单测（不绑端口） —— **通过（handle_request 纯函数 7 例）**

## Notes

- HTTP 服务器用 stdlib `http.server`（零依赖）或 `aiohttp`？——stdlib，避免给 uv 项目加运行时依赖
- 端点仅绑 127.0.0.1，本地单用户无鉴权
- order 指令集：如"全员回防 Core""Worker 停止巡逻"——影响决策但不改代码
