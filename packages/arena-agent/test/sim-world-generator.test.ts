import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calibrateWorldDistribution,
  generateTerrainForChunks,
  isGeneratedBackboneCell,
  squareChunkWindow,
  W53_GENERATOR_PROFILE_20260809,
} from "../src/sim/world/generator.ts";
import { chunkKey, chunkOf } from "../src/sim/world/chunks.ts";
import { makeGeneratedArenaScenarioN, makeSafetyEntry } from "../src/sim/opponent/tournament.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

function maxComponent(cells: readonly (readonly [number, number])[]): number {
  const left = new Set(cells.map(([x, y]) => `${x},${y}`));
  let max = 0;
  while (left.size > 0) {
    const first = left.values().next().value as string;
    left.delete(first);
    const [sx, sy] = first.split(",").map(Number);
    const stack: [number, number][] = [[sx!, sy!]];
    let count = 0;
    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      count += 1;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        const key = `${nx},${ny}`;
        if (!left.delete(key)) continue;
        stack.push([nx, ny]);
      }
    }
    max = Math.max(max, count);
  }
  return max;
}

test("W53 survey calibration separates chunk support from conditional density", () => {
  const report = calibrateWorldDistribution({
    observedChunkKeys: ["0,0", "1,0", "0,1", "1,1"],
    resourceCells: [[1, 1], [2, 1], [40, 1]],
    obstacleCells: [[1, 2], [2, 2], [3, 2], [40, 2], [40, 3]],
    coreSightings: [
      { owner: "alpha", position: [0, 0], lastSeenTick: 10 },
      { owner: "alpha", position: [100, 100], lastSeenTick: 1 },
      { owner: "beta", position: [8, 0], lastSeenTick: 10 },
      { owner: "gamma", position: [24, 0], lastSeenTick: 10 },
    ],
  }, "synthetic-test");
  assert.equal(report.profile.observedChunks, 4);
  assert.equal(report.profile.resourceChunkProbability, 2 / 4);
  assert.equal(report.profile.obstacleChunkProbability, 2 / 4);
  assert.equal(report.diagnostics.resourceBearingChunks, 2);
  assert.equal(report.diagnostics.obstacleBearingChunks, 2);
  assert.equal(report.diagnostics.conditionalResourceCount.p50, 1.5);
  assert.equal(report.diagnostics.conditionalObstacleCount.p50, 2.5);
  assert.equal(report.diagnostics.uniqueCoreOwners, 3);
  assert.equal(report.profile.coreNearestChebyshev?.p50, 8);
  // Observed topology is diagnostic; generated topology remains deliberately capped.
  assert.equal(report.profile.maxObstacleComponentSize, 12);
});

test("W53 generated terrain is deterministic and remote chunks do not perturb local chunk streams", () => {
  const chunks = squareChunkWindow(2);
  const a = generateTerrainForChunks(17, chunks);
  const b = generateTerrainForChunks(17, [...chunks].reverse());
  assert.deepEqual(a, b);

  const local = generateTerrainForChunks(23, [[0, 0]]);
  const withRemote = generateTerrainForChunks(23, [[5, 5], [0, 0], [-7, 4]]);
  const onlyLocal = (cells: readonly (readonly [number, number])[]) => cells.filter(([x, y]) => {
    const [cx, cy] = chunkOf(x, y);
    return cx === 0 && cy === 0;
  });
  assert.deepEqual(onlyLocal(withRemote.resources), local.resources);
  assert.deepEqual(onlyLocal(withRemote.obstacles), local.obstacles);
});

test("W53 generated terrain preserves global chunk backbones and bounded obstacle components", () => {
  const terrain = generateTerrainForChunks(9, squareChunkWindow(4), {
    profile: {
      ...W53_GENERATOR_PROFILE_20260809,
      obstacleChunkProbability: 1,
      obstacleDensityP10: 0.12,
      obstacleDensityP50: 0.14,
      obstacleDensityP90: 0.18,
    },
  });
  assert.ok(terrain.obstacles.length > 0);
  assert.ok(terrain.resources.every(([x, y]) => !isGeneratedBackboneCell(x, y)));
  assert.ok(terrain.obstacles.every(([x, y]) => !isGeneratedBackboneCell(x, y)));
  assert.ok(maxComponent(terrain.obstacles) <= W53_GENERATOR_PROFILE_20260809.maxObstacleComponentSize);
});

test("W53 support probabilities converge near the calibrated two-stage profile", () => {
  const chunks = squareChunkWindow(3);
  let resourceActive = 0;
  let obstacleActive = 0;
  let total = 0;
  for (let seed = 0; seed < 120; seed += 1) {
    const terrain = generateTerrainForChunks(seed, chunks);
    resourceActive += terrain.activeResourceChunks.length;
    obstacleActive += terrain.obstacleChunks.length;
    total += chunks.length;
  }
  const resourceRate = resourceActive / total;
  const obstacleRate = obstacleActive / total;
  assert.ok(Math.abs(resourceRate - W53_GENERATOR_PROFILE_20260809.resourceChunkProbability) < 0.02);
  assert.ok(Math.abs(obstacleRate - W53_GENERATOR_PROFILE_20260809.obstacleChunkProbability) < 0.02);
});

test("W53 generated FFA scenario loads with reserved spawn/beacon cells and non-fixed terrain", () => {
  const entries = [makeSafetyEntry("a"), makeSafetyEntry("b"), makeSafetyEntry("c")];
  const rawA = makeGeneratedArenaScenarioN(entries, 1);
  const rawB = makeGeneratedArenaScenarioN(entries, 2);
  const world = worldFromScenario(rawA);
  assert.equal(world.players.size, 3);
  assert.notDeepEqual(rawA, rawB);
  const terrainKeys = new Set([
    ...world.terrain.obstacles,
    ...world.terrain.resources.keys(),
  ]);
  for (const player of world.players.values()) {
    assert.ok(player.core !== null);
    assert.equal(terrainKeys.has(`${player.core!.position[0]},${player.core!.position[1]}`), false);
    for (const unit of player.units) {
      assert.equal(terrainKeys.has(`${unit.position[0]},${unit.position[1]}`), false);
    }
  }
  const [bcx, bcy] = chunkOf(world.beacon!.position[0], world.beacon!.position[1]);
  assert.ok(Number.isSafeInteger(bcx) && Number.isSafeInteger(bcy));
  assert.equal(terrainKeys.has(`${world.beacon!.position[0]},${world.beacon!.position[1]}`), false);
  assert.ok([...world.terrain.resources.keys()].every((key) => {
    const [x, y] = key.split(",").map(Number);
    return terrainKeys.has(key) && chunkKey(...chunkOf(x!, y!)).length > 0;
  }));
});
