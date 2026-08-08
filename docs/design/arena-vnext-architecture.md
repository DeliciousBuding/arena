# Arena vNext Architecture

Status: integration contract for `feat/runtime-vnext`.

The goal is one deterministic production control stack with replaceable policy modules, not multiple parallel planners that can each write actions.

## 1. Ownership hierarchy

```text
Canonical observations / survey / intel
                |
                v
      Alliance StrategicProfile          (cross-tenant, slow loop)
                |
                v
      Strategic task generation
                |
                v
       Alliance task market              (tenant allocation)
                |
                v
       Fleet / TaskForce metadata
                |
          ASSIST directives only
                |
       +--------+---------+
       | tenant-local     |
       v                  |
Safety veto -> Mission/Task set -> route-aware global assignment
       |                  |
       +-------> Unit/Core action resolution
                         |
                 ProgressContract
                         |
                 Worker liveness
                         |
               local targeted recovery
                         |
                    Arena writer
```

Hard invariant: the tenant runtime owns the only Arena writer. Alliance, Command Center advice, ML models, simulators and offline evaluators never acquire submit ownership.

## 2. Hot-plug boundaries

### 2.1 Immutable code release

TypeScript implementation code is immutable for the life of a process/release. Production must never execute arbitrary `.ts` discovered from disk at runtime.

A new algorithm implementation is promoted as a tested release commit.

### 2.2 Local strategy hot reload

The hot local strategy surface is compiled through one registry/compiler boundary.

Current hot surface:

- registered `variants`
- `mission` tuning

The compiler produces three independent identities:

- `configHash`: complete desired config
- `strategyHash`: fields that may atomically change without process replacement
- `restartHash`: immutable runtime/writer/model/deadline/path surface

A reload is successful only after the current child ACKs the expected config/strategy identity. Sending IPC is not success. Child replacement invalidates old ACK/timeouts.

### 2.3 Strategic policy hot switch

Alliance strategy is a separate domain from local Safety variants.

A `StrategicProfile` may change only on an Alliance Director replan boundary. A profile controls strategic task priority/thresholds (for example DEFEND/INTERCEPT/RAID/SCOUT/RESERVE), not local unit actions.

Required profile semantics:

- registered name + version + deterministic content hash
- monotonically increasing selection revision
- bounded selection history
- explicit last-good marker
- deterministic rollback
- ASSIST-only output

Do not put SafetyPlanner flags into StrategicProfile and do not put Alliance mission allocation into the local variant registry.

## 3. Allocation cores

### 3.1 Worker allocation

The production target is one global deterministic assignment core:

1. forced tasks and Safety vetoes are removed from the economic market;
2. visible + eligible remembered resource tasks are candidates;
3. bounded route distance is used when useful, with deterministic approximation when the local routing budget is exhausted;
4. a rectangular minimum-cost assignment allocates at most one worker per resource task;
5. dummy columns represent no economic assignment;
6. mission policy decides whether the remaining worker surveys/waits;
7. assignments produce explicit `ProgressContract`s.

Do not maintain a second greedy production allocator beside this path. Greedy/precomputed-pair logic may exist only as a benchmark/reference implementation.

### 3.2 Alliance allocation

StrategicProfile generates/prioritizes strategic tasks. A separate deterministic task market assigns tenants/fleets. This separation prevents profiles from becoming bespoke allocation algorithms.

Expected chain:

```text
StrategicProfile -> strategic tasks -> task-market clearing
                 -> local fleet refs -> TaskForce metadata
                 -> tenant ASSIST directives
```

No fabricated FleetRef is allowed. If a real strike fleet is unavailable, keep per-tenant ASSIST mission metadata and omit TaskForce rather than inventing ownership.

## 4. Progress and recovery

Liveness judges task contracts, not intent strings.

Current contracts:

- `GO_RESOURCE`, `DEPOSIT`: distance-to-target must improve (or cargo state changes as appropriate)
- `HARVEST_CURRENT`: cargo/result must change
- `EXPLORE`: coverage must advance

Future `RESURVEY` must receive its own refresh/target progress contract. It must not reuse EXPLORE merely to obtain liveness behavior.

Recovery order:

1. unit-local reset/rotate/cooldown;
2. local task reallocation;
3. tenant-level recovery only after aggregate evidence;
4. watchdog process replacement only as the final operational fallback.

Capacity waits and explicit tactical holds are not worker liveness failures.

## 5. ML / DL boundary

ML is initially an offline decision-support and policy-candidate plane, not a writer.

```text
production/sim trajectories
        |
versioned trajectory schema
        |
feature/label export + episode-safe split
        |
+-------+----------------+----------------+
| Behavior Cloning       | DAgger         | Offline sequence policy
+-------+----------------+----------------+
        |
offline benchmark / counterfactual replay
        |
shadow candidate / advisory policy
        |
promotion evidence
```

Recommended order:

1. Behavior Cloning against the deterministic expert.
2. DAgger/expert relabelling on states reached by the learned candidate.
3. Offline sequence models once enough long-horizon trajectories exist.
4. MAPPO/QMIX only in simulator research when a cooperative MARL hypothesis has evidence that deterministic allocation is the bottleneck.

A learned model may first enter as shadow/advice. Granting it action ownership is a separate promotion decision and must pass the same Safety/writer boundaries; Alliance ML never gets direct Arena submit capability.

## 6. Simulator and evaluation

Production and simulator must share pure policy/allocation cores. The simulator supplies observations and records outcomes; it must not carry an alternate copy of strategic logic.

Every candidate algorithm needs at least one of:

- deterministic counterexample proving correctness improvement;
- A/B scenario showing outcome improvement;
- bounded-latency benchmark;
- production telemetry hypothesis with before/after window.

Algorithm names alone are not a reason to integrate MAPF, MARL, auction or swarm techniques.

## 7. Health model

Health is intentionally multi-dimensional:

- process healthy: child exists/responds
- writer ready: exclusive Arena writer/lock is correct
- config ready: active attested config matches desired config
- progress healthy: gameplay/task progress is occurring

`/ready` keeps writer compatibility semantics. Config and progress health are exposed separately so a live process with stale configuration or deadlocked gameplay cannot masquerade as fully healthy.

## 8. Promotion and rollback

Promotion is commit-addressed:

1. freeze tested integration commit;
2. run schema/registry preflight against real t1-t4 configs;
3. run targeted + full tests and Command Center verify;
4. fast-forward/create an immutable production worktree to exactly that commit;
5. acquire maintenance lease;
6. graceful supervisor shutdown;
7. verify all writers and locks are naturally gone;
8. release lease and start watchdog;
9. verify writer readiness, config attestation, process paths/PIDs and telemetry freshness;
10. compare gameplay progress metrics against the pre-promotion window.

Rollback points to the previous immutable release commit; it never depends on reconstructing an old runtime by mutating files in place.

## 9. Things we intentionally do not build

- arbitrary runtime `.ts` plugin loading
- two competing production Worker allocators
- an Alliance Director with submit/action ownership
- a generic mega-registry that duplicates the local variant registry and strategic-profile registry
- Python/PyTorch dependencies in the live TypeScript writer path
- full CBS/MAPF or MARL in the live tick loop without measured evidence
- watchdog restarts as the primary gameplay recovery algorithm
