# PROGRESS — slice/w4-a3a

- 3A Clock + DeadlineBudget（本切片）
- [done] `src/runtime/clock.ts`：Clock / MonotonicClock / FakeClock(advance) / nowMs
- [done] `src/runtime/deadline-budget.ts`：createDeadlineBudget / deadlineOf / isExpired / timeUntil / validateBudget（严格递增 + 非负 + 有限性校验）
- [done] `test/deadline-budget.test.ts`：20 例（FakeClock 瞬时推进、顺序/负值/NaN/Inf 拒绝、now===deadline 边界、各阶段过期/剩余）
- [done] tsc --noEmit 通过；全量 42/42（基线 22 + 新增 20）
- [done] commit + push origin slice/w4-a3a
