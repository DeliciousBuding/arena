# Agent Coordination — Pure Rust Migration

## 1. Ownership

### TS Agent

May modify:

- `packages/arena-agent/**`
- `packages/arena-hero-ts/**`
- TS simulator, runtime, strategy experiments and tests
- t1/t2 local live, watchdog, calibration and evidence

Must not modify:

- `sim-rs/**` or the Pure Rust workspace
- Rust implementation SSOT
- `docs/race/**` or `contracts/race/**` unless Issue #27 assigns the change

### Pure Rust Agent

May modify:

- `sim-rs/**` and the designated Pure Rust workspace
- Rust protocol/client/runtime/domain/world/strategy/simulator/CLI code
- t3/t4 shadow and bounded-live configuration and evidence
- Rust implementation plans and progress

Must not modify:

- `packages/arena-agent/**`
- `packages/arena-hero-ts/**`
- t1/t2 live configuration or watchdog
- `docs/race/**` or `contracts/race/**` unless Issue #27 assigns the change

### Migration Controller

Sole writer for:

- `docs/race/**`
- `contracts/race/**`
- cross-line decisions in Issue #27

## 2. Legacy Go/FFI freeze

The root Go runtime and Go↔Rust FFI code are frozen.

Allowed changes:

- extract a fixture, protocol observation or failure case;
- document provenance;
- delete or archive code after equivalent Rust coverage exists;
- make the minimum edit needed to preserve history during migration.

Disallowed changes:

- new Go features;
- FFI ABI work;
- Go fallback behavior;
- production packaging for Fusion;
- fixing unrelated Go lint/CI debt merely to keep Fusion alive.

## 3. Current-task closure protocol

Agents do not discard useful WIP blindly. After receiving Race v2:

1. stop adding files horizontally;
2. reduce current WIP to one atomic change;
3. remove or explicitly list Go/FFI assumptions;
4. run the relevant line gate;
5. commit and push the line branch;
6. acknowledge in Issue #27;
7. take the next atomic task.

When WIP crosses ownership boundaries, save it as a patch or temporary branch and report exact files. Do not continue expanding it.

## 4. Acknowledgement template

```text
line: TS | PURE_RUST
branch:
head:
current task:
touched files:
tests/evidence:
uncommitted WIP:
legacy Go/FFI dependency: none | ...
conflicts with Race v2: none | ...
next atomic task:
```

## 5. Commit discipline

- One commit addresses one verifiable problem.
- Do not mix protocol refactors, planner behavior, golden updates and unrelated cleanup.
- Strategy changes name scenario, seed set, tick count, baseline, mean/tail result and hard-gate status.
- Runtime changes include failure injection or replay evidence for the behavior changed.
- Generated runtime data belongs under `runtime/**` and is not committed unless it is a deliberately reduced fixture.
- Never commit secrets, provider tokens, absolute secret paths, large raw logs or temporary profiles.

## 6. Conflict handling

| Conflict | Resolution |
|---|---|
| Both lines edit a shared contract | Later writer stops; migration controller resolves semantics |
| TS and Rust use different field names | Map in `implementation-mapping.md`; do not fork the schema |
| Replay results disagree | Classify rule mismatch, observability gap or implementation bug before changing a golden |
| Rust WIP depends on Go/FFI | Extract knowledge, rewrite natively, report remaining dependency |
| Local WIP conflicts with remote | Save patch/temp branch, rebase, never force-push over another agent |
| Experiment threatens live collection | TS live/calibration wins; kill only matched PIDs, never all Node/Rust processes |

## 7. Local notification mirror

Local agents may continue using:

```text
D:\Code\Projects\arena-mail.md
```

Minimal message:

```text
Race v2: Pure Rust is the only long-term mainline. TS keeps t1/t2 production and calibration; Rust owns t3/t4 validation. Go/FFI is frozen. Shared controller: Issue #27; implementation tracker: Issue #26.
```

Local mail is advisory and never overrides repository evidence.

## 8. Fixed next work

TS:

1. restore its current test baseline without reverting the 40-cell continuous exploration behavior;
2. keep t1/t2 live and calibration stable;
3. emit reduced fixtures, Runtime-Golden and explicit profiles;
4. avoid new long-term runtime architecture.

Pure Rust:

1. push the updated Pure Rust plan and current atomic WIP;
2. remove Go-host/FFI assumptions;
3. implement direct Hero protocol/client vertical slice;
4. implement exactly-once tenant runtime and fail-closed validator;
5. port world/resource memory and economic loop;
6. add exploration, reservation, threat, defense and combat in that order;
7. align replay/simulator and follow the promotion runbook.
