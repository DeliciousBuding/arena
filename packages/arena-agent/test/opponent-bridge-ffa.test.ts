/** External opponent FFA regression: bridge must pin the local reference SDK source tree. */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { opponentEntry, resolveOpponent } from "../src/sim/opponent/registry.ts";
import { makeSafetyEntry, runFreeForAll } from "../src/sim/opponent/tournament.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function findCoordinationRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "reference", "official", "arena-hero-python"))) return current;
    if (existsSync(join(current, "reference", "arena-hero-python"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(PACKAGE_ROOT, "..", "..", "..");
}
const COORDINATION_ROOT = findCoordinationRoot(PACKAGE_ROOT);
/** 2026-08-09 重组后：官方 4 仓在 reference/official/，第三方在 reference/third-party/。 */
function repoDir(name: string): string {
  for (const subdir of ["third-party", "official"]) {
    const candidate = join(COORDINATION_ROOT, "reference", subdir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(COORDINATION_ROOT, "reference", name);
}
const REPOS_AVAILABLE = [
  "arena-hero-python",
  "arena-hero-agent",
  "arena-hero-guide",
  "arena-evolve",
].every((repo) => existsSync(repoDir(repo)));
const RULES = "src/sim/contracts/rules-v0.14.json";

test(
  "v0.14 FFA simultaneously runs arena-evolve + core through pinned reference SDK",
  { skip: REPOS_AVAILABLE ? false : "reference repos unavailable" },
  () => {
    const entries = [
      makeSafetyEntry("mine"),
      opponentEntry(resolveOpponent("arena-evolve"), 1),
      opponentEntry(resolveOpponent("core"), 1),
    ];
    const result = runFreeForAll(entries, 1, 5, RULES, { validatePlans: true });
    assert.equal(result.tickCount, 5);
    assert.ok(result.eventCount > 0);
    assert.deepEqual(result.players, ["mine", "arena-evolve-s1", "core-s1"]);
    assert.equal(result.coreAlive["arena-evolve-s1"], true);
    assert.equal(result.coreAlive["core-s1"], true);
  },
);
