# PROGRESS — W4 slice/w4-a3c

## 3C AgentDecisionRuntime Port + Fake Runtime（2026-08-03）
- `packages/arena-agent/src/runtime/agent-runtime.ts`（新建）：`isCandidateEnvelope` 类型守卫（protocolVersion==="1" + 必需字段 + plan 结构校验，供 CandidateSink）
- `packages/arena-agent/src/runtime/testing/fake-agent-runtime.ts`（新建）：FakeAgentRuntime 实现 AgentDecisionRuntime 端口；11 种模式全确定性、无真实 timer（自备 FakeClock）；候选必须经 sink 投递；重叠 run 同步抛错；settled 永远 resolve
- `packages/arena-agent/test/fake-agent-runtime.test.ts`（新建）：22 例（含 guard/FakeClock/mode 函数选择/sink 抛错）
- 验收：TSC_OK；22/22；全量 44/44
