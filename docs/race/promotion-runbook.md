# Promotion and Rollback Runbook — Pure Rust

## 1. Principle

Pure Rust is the selected destination, but it earns production traffic in bounded stages. Each stage expands one variable only: implementation, tenant or tick window.

The TS production baseline stays runnable until Rust completes a long canary and an explicit migration decision.

## 2. Stage 0 — Line gates

TS baseline:

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts
python scripts/gen-status.py --check
python scripts/docs_health.py --check
```

Pure Rust:

```bash
cd sim-rs
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

When the Pure Rust workspace moves, use its declared root but retain the same gate intent.

Requirements:

- no accidental skips;
- no unreviewed golden drift;
- no uncommitted generated files;
- no Go binary, FFI library or dynamic planner dependency;
- build manifest identifies Rust git SHA and profile/schema/rules hashes.

## 3. Stage 1 — Protocol and replay vertical slice

Rust must prove the complete offline/read-only chain:

```text
Hero payload fixture
→ protocol DTO
→ normalized TickState
→ World observe
→ planner decide
→ validator
→ canonical Plan / trace
```

Required:

- same seed and input replay identically;
- duplicate tick input is recognized;
- malformed/unknown contract fails explicitly;
- official unknown effects remain `INCONCLUSIVE`;
- no repair preserves eligibility;
- no Go/FFI path is loaded.

## 4. Stage 2 — Same-state TS/Rust shadow

Feed the same normalized game observation to both implementations:

```text
TS decide ─┐
           ├─ compare legality, intents and metrics
Rust decide┘
```

TS remains the submitter. Record:

- validity and issue classification;
- decision latency;
- normalized profile actually consumed;
- target/intent differences;
- first divergent tick and streak;
- World-memory inputs;
- unsupported fields.

Plan bytes do not need to match. Every difference must be legal and explainable.

## 5. Stage 3 — t3/t4 long shadow

Rust directly connects to Hero but does not submit.

Minimum: 24 continuous hours or 10,000 processed ticks.

Required:

- panic=0;
- decode/schema mismatch=0;
- invalid/repair=0;
- silent fallback=0;
- duplicate processing=0;
- reconnect preserves exactly-once;
- memory growth is bounded and explainable;
- manifest, telemetry and clean shutdown evidence are complete.

## 6. Stage 4 — bounded live on t3/t4

Run separate windows:

```text
3 Tick → 10 Tick → 30 Tick → 100 Tick
```

Each window requires:

- explicit live flag and tenant `submitEnabled=true`;
- single-writer lock acquired before connecting;
- stable idempotency key;
- accepted/rejected/duplicate evidence;
- hard gates all zero;
- Ctrl+C and timeout release lock and process tree;
- duplicate state/reconnect injection does not re-submit;
- invalid planner fault injection stops the run before submit;
- no implementation switch during the window.

Any failure returns to shadow.

## 7. Stage 5 — Rust canary

Select t3 or t4; keep the other as shadow/control.

Required sequence:

- 1,000 live ticks;
- 10,000-tick soak;
- one clean restart;
- one stream-stall/reconnect exercise;
- one duplicate-tick exercise;
- one lock-contention exercise;
- positive or non-inferior outcome versus the fixed TS/profile baseline;
- no material degradation in worst-10% behavior.

## 8. Stage 6 — first production tenant

Only after explicit approval:

1. choose exactly one of t1/t2;
2. freeze TS baseline and Rust profile hashes;
3. stop the TS writer and verify process/lock release;
4. run Rust 3/10/30/100 bounded windows;
5. continue into a long canary;
6. keep the other production tenant on TS;
7. review evidence before considering the second tenant.

Never switch both production tenants in one window.

## 9. Rollback triggers

Rollback immediately on:

- any hard-gate count;
- protocol/schema mismatch;
- unknown repair or invalid deterministic plan;
- duplicate/wrong-tick submit;
- second writer or lock-release failure;
- unhandled panic or orphan process;
- decision p95 exceeding the tick budget;
- catastrophic Core loss beyond the approved baseline threshold;
- telemetry gaps that prevent state determination;
- unexpected fallback or implementation identity mismatch.

## 10. Rollback procedure

```text
stop Rust writer
→ verify Rust PID/process tree is gone
→ verify tenant lock is released
→ save manifest/logs/profile/rules/build metadata
→ start the pinned TS deterministic baseline
→ verify the first accepted tick
→ record cause and evidence in Issue #27
```

Never start the rollback writer until the prior writer is proven dead.

## 11. Pure Rust production gate

Before Stage 4, Rust must have direct tests for:

- HTTP auth/submit and receipt parsing;
- WebSocket connect, stream end, idle timeout and reconnect;
- protocol DTO → domain normalization;
- single-writer lock contention and stale handling policy;
- stable idempotency key generation;
- duplicate/stale/late tick rejection;
- validator fail-closed behavior;
- panic reporting and non-zero exit;
- SIGINT/timeout cleanup;
- JSONL/manifest durability and secret redaction;
- deterministic replay across process restarts.
