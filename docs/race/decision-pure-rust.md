# ADR: Pure Rust as Arena Mainline

- Status: Accepted
- Date: 2026-08-06
- Supersedes: Pure Go and Go Host + Rust Kernel Fusion proposals
- Controller: Issue #27
- Implementation tracker: Issue #26

## Decision

Arena's only long-term product implementation is **Pure Rust**.

TypeScript remains the current production baseline, strategy laboratory, real-data calibration source, replay oracle, and rollback implementation until Rust completes staged production promotion. Go and Go+Rust FFI are frozen and will not be completed as alternative production engines.

## Why

The Fusion design duplicates the most failure-sensitive boundaries:

- two domain models and serializers;
- two planner/runtime lifecycles;
- ABI and allocator ownership;
- dynamic-library loading and platform-specific adapters;
- fallback behavior that can hide the actual implementation executing a tick;
- CI/debugging work unrelated to game strategy or runtime correctness.

Pure Rust removes those boundaries while preserving the strongest reason to use Rust: one deterministic core shared by production, replay, simulation, and optimization.

## Target ownership

Pure Rust directly owns:

```text
Hero HTTP/WebSocket
→ protocol normalization
→ TickState / World memory
→ deterministic strategy / validator
→ exactly-once tenant runtime
→ submit / idempotency / single-writer lock
→ telemetry / replay / simulator / optimizer
```

The exact crate names may evolve, but these responsibilities must not be split across languages.

## Constraints

- No Go host in the production path.
- No cdylib/DLL/SO planner integration.
- No silent fallback to Go, TS, or a second Rust planner.
- No second canonical domain model.
- LLM output is low-frequency validated MacroPolicy only; it never owns per-tick submit.
- Invalid deterministic output is fail-closed and invalidates the run.
- TS t1/t2 production is preserved until Rust passes the full promotion runbook.

## Legacy handling

Old Go/Fusion code is evidence, not architecture. The Rust line may extract:

- observed protocol behavior;
- idempotency and reconnect cases;
- single-writer semantics;
- telemetry fields;
- fixtures and failure reproductions.

After equivalent Rust coverage exists, the old code is archived or deleted. It must not remain a runtime dependency.

## Consequence

The remaining TS/Rust comparison is a **migration validation**, not a language-selection contest. Rust is the destination; evidence determines when it is safe to take over production.
