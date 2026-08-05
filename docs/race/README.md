# Arena Race v2 — Pure Rust Migration

> Race v2 validates the migration from the current TS production implementation to the selected Pure Rust mainline. It does not reopen the language decision.

## 1. Active lines

| Line | Role | Tenants | Source |
|---|---|---|---|
| TS Production / Strategy Lab | current live baseline, real calibration, rapid strategy experiments, replay oracle, rollback | t1/t2 live | `main` |
| Pure Rust Mainline | future production runtime, deterministic planner, simulator/replay/search | t3/t4 shadow and bounded live | `rust-rewrite` |

Remote observation points when Race v2 was established:

- TS: `71d778bae074c153917708caa22746061cdbe0ef`
- Rust: `d169c6a4deab1d81eff3020917ddeb727e449ebc`

These are comparison anchors, not a ban on atomic development.

## 2. Architecture decision

Read `decision-pure-rust.md` first.

Pure Rust directly owns transport, runtime, domain, memory, strategy, validation, submission, telemetry, replay, simulation and optimization. Go/FFI is not a target and must not be completed as a parallel engine.

## 3. Authority order

1. official rules and reproducible server observations;
2. tests, run manifests, JSONL, Runtime-Golden and replay artifacts;
3. `contracts/race/**`;
4. approved decisions in Issue #27;
5. implementation-line SSOTs;
6. local agent mail and chat summaries.

A later document is not automatically more authoritative than stronger evidence.

## 4. Shared documents

- Architecture decision: `decision-pure-rust.md`
- Agent ownership: `agent-coordination.md`
- Evaluation: `evaluation-contract.md`
- Promotion and rollback: `promotion-runbook.md`
- TS ↔ Rust field mapping: `implementation-mapping.md`
- Strategy input schema: `../../contracts/race/strategy-profile-v1.schema.json`
- Result schema: `../../contracts/race/race-result-v2.schema.json`

## 5. Non-negotiable boundaries

- t1/t2 remain TS live until an explicit Rust canary stage.
- t3/t4 are reserved for Rust validation.
- One tenant has at most one live writer.
- Rust invalid plans fail closed; repair does not preserve eligibility.
- No silent planner/runtime fallback.
- No Go host, FFI, duplicate canonical domain model or dynamic planner library.
- LLMs never enter the per-tick submission hot path.
- Shared profiles use explicit values; implementation defaults do not qualify as race evidence.
- No cherry-picking a best seed, changing scoring after results, or overwriting a failed golden.
