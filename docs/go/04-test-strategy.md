# 检查系统（04）

> 状态：设计定稿。Go 版全量门禁 = 静态检查 + 漏洞检查 + 测试矩阵 + 契约对齐 +
> fixture 回放 + 差分 + 故障注入 + 黑盒验证。全部命令化、可一键跑、CI 强制执行。

## 1. 门禁分层（开发循环不被重门禁拖慢）

```bash
# 快速循环（开发反复跑，几十秒内反馈）
scripts/check-fast.sh      # gofmt + 受影响包 go test + go build

# Commit 级（每次提交）
scripts/check.sh           # gofmt + go vet + 全量 go test + go build + fixture smoke

# Merge / Nightly / Release（CI quality job 执行）
scripts/check-full.sh      # check.sh + go test -race（Linux）+ staticcheck + govulncheck
                           # + 完整 fixture replay + Docker build + 秘密扫描 + 进程黑盒 + 覆盖率报告
```

三份脚本是同一检查集合的切片，内容单调递增；`check-full.sh` 是唯一发布门禁。

## 2. 测试分层

| 层 | 范围 | 关键工具 | 强制 |
|---|---|---|---|
| L1 单元 | 单包纯函数 | `go test -race` | 每批 |
| L2 契约对齐 | contracts↔JSON Schema 黄金文件 | golden_test.go | 每批 |
| L3 fixture 回放 | reducer/planner 在 100-tick 真实 fixture | testdata/expected 冻结 | 每批 |
| L4 差分 | 回放结果 vs TS 版期望（冻结） | compare 工具 | 每批 |
| L5 故障注入 | lease/coordinator 恶意时序 | fault-injection tests | 每批 |
| L6 黑盒 | 锁/supervisor/进程树 | 真实子进程（Win+Linux） | 合批前 |

## 3. fixture 与期望值管理（对等验证的核心机制）

1. **输入**：`fixtures/differential/burnin-20260802-a/`（manifest + 100 tick raw-state）
   是唯一回放输入源，**只读**；
2. **期望**：`internal/**/testdata/expected/` 冻结 TS 版回放输出（state 快照 + plan）——
   在基线阶段从主工作区 TS 链一次性导出（`scripts/export-expected.sh`，已在本次
   重写前的 TS 版 100-tick 回放结果中验证过）；
3. **比较规则**：逐字段深比较；未知/不可观测字段标 `inconclusive`，**不得写成
   MATCH**；差异必须给出分类（规则升级/修复/服务器私有/Go bug）并记录到
   `docs/go/06-progress.md` 的"差异日志"；
4. **豁免区间**：TS 版既有豁免（burnin-20260802-a / unknown / 40437–40536 的 MOVE
   参数差异）继承，但豁免不覆盖 state/metadata、动作类型、缺动作、Core 动作。

## 4. 关键场景清单（替代硬覆盖率/测试数量门禁）

覆盖率是信号不是完成定义。硬性测试要求收敛为以下**关键场景**（每个场景至少一个
自动化测试，缺失即不合格）：

```text
1. 正常 Tick：完整决策链输出合法 Plan
2. 空资源：planner 不崩溃、产出可执行计划（spawn 欠费→跳过）
3. Core respawn：respawn_at_tick 语义正确
4. 世界 Tick 回退：state 回退检测/重置
5. 非法 LLM plan：validator 拒绝或 repair
6. LLM 超时：sticky 沿用上次策略，不阻塞 tick
7. WS 断线：重连恢复、无重复提交
8. 重复 submit：幂等键去重语义
9. 密钥脱敏：构造含密钥样本，落盘零密钥
10. 单写者锁：同租户第二进程拿锁失败
11. DecisionLease：stale/late 候选拒绝
12. 熔断器反向验证：3 连败 → open → half-open 恢复
```

强制审查仅限：submit / lock / lease / 密钥 / live deployment（L3 独立审查），
其余包按 L2 diff 审查。

## 5. 防作弊条款（对齐 leader 规则）

- 禁止 `.Skip`/`t.Skip`（CI grep 断言 0 个）；禁止删测试来绿；
- 禁止 mock 被测对象本身（只允许 mock 外部边界：网络/时钟/进程）；
- 测试数基线：每批结束 `go test -json` 统计 >= 本批规格声明的用例数；
- 反向验证：熔断器/告警类必须有一次"亲手制造失败证明会响"的测试（如
  open 状态断言 + 一次探测失败落日志）。

## 6. 真机验证矩阵（t3/t4，每步独立证据）

| 步骤 | 命令（示例） | 证据 | 门禁 |
|---|---|---|---|
| doctor | `arena doctor --config=runtime/configs/t3.json` | 输出全项 PASS | 无错误即过 |
| deterministic shadow | `arena tenant --config=... --mode=deterministic --shadow` | runtime.jsonl + 无 submit | ≥30 tick 稳定 |
| bounded live canary | `--live --live-ticks=100` | accepted receipts + outcomes | 100/100 accepted |
| 常驻 soak | supervisor 四租户（t3/t4 已授权） | manifest + 遥测持续 | 见晋级门禁 |

晋级顺序固定：doctor → shadow → bounded live → soak；任何 rejected submit /
锁异常 / orphan / 凭据泄漏 / 未分类 mismatch 立即停止晋级并向用户报备。

## 7. 供应链检查（undici 教训）

- `govulncheck ./...` 进 CI，零告警为合批前置；
- Go 依赖白名单：`modernc.org/sqlite`、`nhooyr.io/websocket`（coder/websocket 同源）
  及其传递依赖——任何新增直接依赖需在 `docs/go/01-architecture.md` ADR 记录理由；
- `go mod verify` 校验模块完整性；锁文件 `go.sum` 入仓。
