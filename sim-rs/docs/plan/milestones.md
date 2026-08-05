# 里程碑（rust-rewrite 分析线）

## M1：平台地基 ✅（2026-08-05 达成）

- cli 共享库 + simrun，51 tests 全绿
- 真实场景实测跑通（base/dense/sparse 经济闭环真实发生）
- 单核性能 12.1x vs Go（stamped BFS，dc7a0c6）

## M2：6 CLI 全对偶（执行线收尾中）

- simrun/simsearch/optsearch/paramscan/simgolden/simdebug 六命令全部存在
- 硬指标：同 seed 双跑 diff 为空（确定性）、输出格式逐字节对齐 Go
- 门禁：cargo test 全绿 + clippy 0 + fmt 干净

## M3：差分门禁绿（重写线核心验收）

- Go oracle vs Rust 同场景同 seed 输出 diff 为空或容差内
- golden.json 数值核验：PASS（容差内）
- 事件级对齐（G，P1）作为加固项跟进

## M4：性能对决完结

- rayon 多核基准落文档：2 万评估目标 <5min（Go 28 核 24.7min）
- 单核基准复测保持 ≥10x
- PARITY.md 复核 + MASTER.md 收口

## M5（可选）：清理

- 用户裁决后删除 Go oracle（keep_oracle 契约：差分全绿后再删）
- rust-rewrite 分析线与执行线合并决议（用户定）
