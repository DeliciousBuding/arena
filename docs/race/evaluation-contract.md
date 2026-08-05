# Evaluation Contract — Race v2

## 1. Purpose

Race v2 measures whether Pure Rust is safe and useful enough to replace the current TS production implementation. The architecture decision is already made; evaluation controls production promotion.

Every official window binds:

- implementation and git SHA;
- profile ID, normalized profile and hash;
- scenario/rules/fixture hashes;
- seed set and tick count;
- submission mode;
- hard-gate counts;
- raw evidence and summary paths;
- scorer version.

Different initial states, refill assumptions, rules or scorer versions are not directly rankable.

## 2. Hard gates

Any non-zero count sets `eligible=false` and no total score is reported:

```text
wrongTickSubmit
duplicateSubmit
staleCandidateExecuted
illegalFinalPlan
unknownRepair
secondWriter
crossTenantStateLeak
orphanProcess
unhandledPanic
silentPlannerFallback
protocolContractMismatch
credentialLeak
```

Rules:

- shadow windows record submit counters as zero and set `submissionMode=shadow`;
- `INCONCLUSIVE` is not a match and not automatically a failure; keep its classification;
- any repair of deterministic output invalidates the window even when the repaired plan is legal;
- switching to another planner/runtime invalidates the Rust window;
- a transport decode/schema mismatch is a hard failure, not an expected strategy difference;
- missing telemetry that prevents hard-gate determination makes the window ineligible.

## 3. Score groups

### 3.1 Core survival and recovery — 35 points

Report:

- `coreSurvivalRate`
- `coreHpAuc`
- `respawnRecoveryTicks`
- `catastrophicLosses`
- `minimumEconomicLoopRecoveryTicks`

Suggested normalized score:

```text
35 × clamp(
  0.45 * coreSurvivalRate
+ 0.35 * coreHpAuc
+ 0.20 * recoveryScore,
0, 1)
```

### 3.2 Net economy — 30 points

Do not rank only by final resources.

```text
netEconomy =
  finalResources
+ survivingUnitAssetValue
+ grossDeposited
+ confirmedLoot
- upkeepPaid
- lostUnitAssetValue
- healCost
- failedSpawnCost
```

Also report:

- `resourceDelta`
- `workerProductiveTicks`
- `travelWasteTicks`
- `cargoBlockedTicks`
- `failedHarvestTicks`
- `spawnEfficiency`

Unit prices belong to the rules fixture, not the result schema.

### 3.3 Effective exploration — 15 points

Report:

- `newVisibleCells`
- `valuableDiscoveries`
- `firstResourceDiscoveryTick`
- `duplicateCoverageRatio`
- `emptyExploreTicks`
- `maxUsefulDistance`
- `blacklistAvoidedRetries`

Pure maximum distance is not a benefit unless it produces resource, combat or information value.

### 3.4 Combat and enemy Core pressure — 10 points

Report:

- `enemyCoreDamage`
- `enemyCoreDestroyed`
- `combatValueTrade`
- `militarySurvivalRate`
- `defenseLeakCount`

For economy-only scenarios set `applicable=false`; redistribute the remaining weights proportionally rather than assigning zero.

### 3.5 Runtime stability — 10 points

Report:

- decision latency p50/p95/max;
- reconnect recovery time;
- stream gaps and recovery count;
- RSS and CPU;
- clean shutdown and lock release;
- telemetry completeness;
- deterministic replay repeatability;
- startup/deployment complexity.

## 4. Minimum scenario matrix

| ID | Purpose |
|---|---|
| economy-dense | basic harvesting, deposit and congestion |
| economy-sparse | memory and discovery efficiency |
| resource-far | long exploration and return path |
| obstacle-maze | navigation around long walls and narrow gates |
| core-gate | deposit/spawn congestion at the Core |
| enemy-defensive | force composition and Core siege |
| enemy-aggressive | survival and counter-pressure |
| crossfire | multi-axis threat and Core defense |
| depleted | blacklist and strategy transition |
| reconnect | exactly-once after stream interruption |
| respawn | recovery override and minimum viable economy |

Formal promotion evidence requires:

- at least 20 paired seeds per strategy scenario;
- 1,000 ticks or scenario terminal state;
- identical initial state and rules/refill fixture;
- mean, median, worst 10%, standard deviation and failure rate.

Two or three seeds may be used for development screening, never for formal promotion.

## 5. Promotion statistics

Rust advances relative to the fixed TS production baseline only when:

1. all hard gates are zero;
2. the primary target metric improves or is explicitly non-inferior;
3. worst 10% does not degrade by more than 5%;
4. failure rate does not increase;
5. evidence holds across at least two scenario families;
6. another runner can replay the result;
7. no result depends on an unsupported profile field hidden by defaults.

A mean improvement with a materially worse tail remains an experimental profile.

## 6. Artifact layout

Each formal run emits a `race.result.v2` JSON:

```text
runtime/race/<race-id>/result.json
runtime/race/<race-id>/manifest.json
runtime/race/<race-id>/raw/
runtime/race/<race-id>/summary.md
```

`runtime/**` is not committed by default. Commit only reduced fixtures, profiles, scorer code and reviewed summary numbers.
