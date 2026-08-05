# Implementation Mapping — TS ↔ Pure Rust

`StrategyProfile v1` is the cross-line input. Formal runs must pass a complete profile and record the normalized profile/hash. Implementation defaults do not qualify as migration evidence.

## 1. Field mapping

| Race v2 | TS | Pure Rust | Rule |
|---|---|---|---|
| `posture=economic` | `harvest` | economic/growth mode | boundary adapter only; schema enum stays language-neutral |
| `posture=balanced` | `balanced` | balanced/default | direct mapping |
| `posture=aggressive` | `aggressive` | aggressive | direct mapping |
| `workerTarget` | MacroPolicy/planner config | Rust strategy config | profile is authoritative |
| `populationCeiling` | planner config | Rust strategy config | no hidden default |
| `militaryRatio` | `[0,1]` number | `[0,1]` number | Rust must not retain legacy 0–100 semantics |
| `vanguardRatio` | `[0,1]` number | `[0,1]` number | unsupported must be reported |
| `accumulateThreshold` | surge state machine | Rust surge state machine | same resource-unit semantics |
| `attackForce` | force threshold | Rust force threshold | same unit count semantics |
| `exploreRadius` | planner config | Rust exploration config | direct mapping |
| `maxFocusDistance` | SafetyPlanner guard | Rust policy/strategy guard | final consumed value recorded |
| `threatDistance` | planner config | Rust threat config | direct mapping |
| `spawnReserve` | planner config | Rust economy config | direct mapping |
| `attackPriority=core` | `core` | enemy Core target | direct mapping |
| `attackPriority=workers` | `workers` | enemy economy target | direct mapping |
| `attackPriority=nearest` | nearest fallback | nearest legal target | explicit value, not null inference |
| `attackPriority=null` | no forced target | no forced target | direct mapping |
| `resourceMemory.*` | World/WorkerTaskPlanner | Rust World/ResourceMemory | same age/cooldown units |
| `exploration.*` | deterministic exploration | Rust ExplorationMemory | algorithms may differ; parameter meaning may not |
| `safety.clearPath` | planner variant | Rust strategy guard | direct mapping or report unsupported |
| `safety.enableCoreMigration` | planner config | Rust Core policy | default false; separate promotion required |

## 2. Types and units

- Ratios are floating-point values in `[0,1]`.
- Tick counts, distances, resources and populations are integers.
- Coordinates are signed integers.
- Distances use the named metric defined by the rules/fixture; do not silently mix Manhattan and Chebyshev.
- A profile contains no tenant secret, provider token or absolute secret path.
- Rust protocol DTO naming is not part of the shared contract; normalized values are.

## 3. Required manifest fields

Formal runs record:

```text
profileId
profileSchemaVersion
profileHash
normalizedProfile
unsupportedFields
implementation = ts | rust
gitSha
rulesVersion
rulesHash
scenarioHash
```

A missing profile hash or non-empty unapproved `unsupportedFields` makes the result ineligible.

## 4. Allowed strategy differences

TS and Rust do not need byte-identical plans. Allowed differences include:

- different legal patrol directions;
- earlier healing versus earlier pressure;
- different legal worker-resource matching;
- different memory algorithms producing explainable targets;
- different movement reservations with equal legality.

Not allowed:

- validator violations;
- different rule costs/capacities/vision;
- adapter-changing profile values;
- different tick/state interpretation;
- lost Rust planner state across ticks;
- silent fallback to a second implementation;
- treating a protocol mismatch as a strategy difference.

## 5. State normalization

The comparison boundary is normalized `TickState`, not raw TS/Rust transport DTOs.

```text
raw Hero payload
→ implementation-specific protocol DTO
→ shared semantic fields
→ TickState fixture / state hash
```

When raw payload fields are server-secret or unobservable, preserve them as unknown rather than inventing parity.
