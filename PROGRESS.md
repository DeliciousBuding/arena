# Slice 3B — DecisionLeaseRegistry

- [x] 前提核验：npm ci OK；基线 22/22 pass
- [x] decision-lease.ts：+selected 状态；submit 改收 CandidateEnvelope（union 兼容旧 DecisionCandidate）；runId/tenantId 校验（缺省跳过）；时钟注入（结构类型，3A clock.ts 未落地不 import）；expire(active|accepted)、select(accepted|expired)、cancel(active)
- [x] lease-registry.ts：runId 精确索引；终结走 registry 进入有界保留区（maxTerminated 默认 1000）；stats()
- [x] decision-lease-registry.test.ts：13 项（旧 runId 不命中新 Tick、重复提交拒、expire/selected 后拒、错误 tenant/tick/stateHash、10 万 lease 有界、状态机全路径、FakeClock）
- [x] 验收：TSC_OK；新测试 13/13；全套 35/35（原 22 无回归）
- [x] commit + push origin slice/w4-a3b
