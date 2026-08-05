# Arena Race v1

> 跨实现赛马、终态融合与晋级契约。代码、测试、run manifest、JSONL、Runtime-Golden 优先于口头结论。

## 1. 当前双线

| 实现线 | 当前职责 | 运行租户 | 分支 |
|---|---|---|---|
| TS Production / Strategy Lab | 生产基线、真实数据采集、快速策略实验、MacroPolicy 与自愈 | t1/t2 live | `main` |
| Go Host + Rust Kernel Fusion | 终态候选、确定性内核、模拟/搜索、FFI 生产接入 | t3/t4 shadow/bounded | `rust-rewrite` |

Race v1 建立时的冻结观察点：

- TS：`71d778bae074c153917708caa22746061cdbe0ef`
- Fusion：`d169c6a4deab1d81eff3020917ddeb727e449ebc`

冻结观察点只是比较基线，不阻止两边继续原子开发。

## 2. 长期架构裁决

```text
Arena Server
    ↕
Go Host
├── Hero I/O / auth / reconnect
├── tenant / lock / idempotency / telemetry
├── low-frequency macro policy
├── validator / promotion / rollback
└── FFI adapter
        ↕
Rust Kernel
├── deterministic planner
├── resource / map / enemy memory
├── navigation / assignment / combat
├── simulator / replay
└── offline search
```

TS 长期保留为策略实验室、参考实现、真实数据校准入口和契约 Oracle；不要求 TS 与 Rust 永久逐行同构。

## 3. 权威顺序

1. 官方规则与真实服务器行为证据；
2. 可复现测试、run manifest、JSONL、Runtime-Golden；
3. `contracts/race/**`；
4. Issue #27 的已批准裁决；
5. 两条实现线自己的 SSOT；
6. `D:\Code\Projects\arena-mail.md` 与聊天摘要。

出现冲突时按上述顺序处理，不把后写文档自动视为更权威。

## 4. 共享入口

- Agent 地界与协作：`agent-coordination.md`
- 统一评价：`evaluation-contract.md`
- 晋级与回滚：`promotion-runbook.md`
- 实现字段映射：`implementation-mapping.md`
- 策略配置 schema：`../../contracts/race/strategy-profile-v1.schema.json`
- 结果 schema：`../../contracts/race/race-result-v1.schema.json`

## 5. 不可违反

- t1/t2 在 Fusion 完成晋级前仍归 TS；t3/t4 不得被 TS 重新占用。
- 同租户只能存在一个 live writer。
- LLM 不进入每 Tick 提交热路径，不持有 submit 权。
- Fusion 内核失败不得静默切换；fallback 必须可观测并使当前 Race 窗口失效。
- 不允许为通过赛马修改评分脚本、放宽 hard gate、覆盖失败 golden 或挑选单个最好 seed。
- 不建立第三份完整 Go 决策策略；Go 只保留宿主和最小 fail-safe。
- 跨线字段先改契约，再改两边 adapter；禁止各自发明同义字段。
