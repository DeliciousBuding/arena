/**
 * 持久敌情测绘加载器（2026-08-07）：从本租户历史 calibration cases 提取
 * "最后已知敌 Core 位置"，供启动播种到 World——重启后军事仍记得敌方基地
 * （解决"重启→记忆清零→军队空转"）。只读 data/runtime/<tenant>/calibration/
 * （single-writer 纪律只约束写；本模块只读不写，无锁冲突）。
 *
 * 扫描范围有界：只读最新 N 个 run 目录（按目录 mtime），总文件数/耗时封顶，
 * 失败静默返回 []（启动播种是优化不是门禁，不阻断 live loop）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CoreHuntTarget } from "../domain/world.ts";

/** 扫描的最新 run 目录数（按目录 mtime 降序）。 */
const SCAN_RUNS = 14;
/** 单次扫描最大 case 文件数（防异常巨型历史拖慢启动）。 */
const MAX_FILES = 4000;
/** 返回的敌 Core 目标上限（4 租户共享同一世界？不——每租户独立世界，8 个足够）。 */
const MAX_TARGETS = 12;

interface RawCoreSighting {
  readonly position: readonly [number, number];
  readonly tick: number;
  readonly owner: string | null;
}

/** 从租户 calibration 根目录提取最后已知敌 Core 位置（按 owner 取最新；owner
 *  缺失按位置取最新）。返回按 tick 降序的 CoreHuntTarget[]。 */
export function loadPersistentEnemyIntel(calibrationRoot: string): readonly CoreHuntTarget[] {
  try {
    if (!statSync(calibrationRoot, { throwIfNoEntry: false })?.isDirectory()) return [];
    const runDirs = readdirSync(calibrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(calibrationRoot, entry.name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, SCAN_RUNS);
    const sightings: RawCoreSighting[] = [];
    let files = 0;
    for (const runDir of runDirs) {
      const casesDir = join(runDir, "cases");
      if (!statSync(casesDir, { throwIfNoEntry: false })?.isDirectory()) continue;
      const caseFiles = readdirSync(casesDir).filter((name) => name.endsWith(".json")).sort();
      for (const name of caseFiles) {
        if (files >= MAX_FILES) break;
        files += 1;
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(join(casesDir, name), "utf8"));
        } catch {
          continue;
        }
        const rawCase = raw as {
          before?: { tick?: unknown; state?: { objects?: unknown } };
          after?: { tick?: unknown };
        };
        const state = rawCase.before?.state;
        if (state === undefined || !Array.isArray(state.objects)) continue;
        const tick =
          typeof rawCase.before?.tick === "number"
            ? rawCase.before.tick
            : typeof rawCase.after?.tick === "number"
              ? rawCase.after.tick
              : 0;
        for (const obj of state.objects) {
          const o = obj as {
            kind?: unknown;
            controlled?: unknown;
            position?: unknown;
            owner_username?: unknown;
          };
          if (o.kind !== "CORE" || o.controlled === true) continue;
          const pos = o.position;
          if (!Array.isArray(pos) || pos.length !== 2 || typeof pos[0] !== "number" || typeof pos[1] !== "number") continue;
          sightings.push({
            position: [pos[0], pos[1]],
            tick,
            owner: typeof o.owner_username === "string" && o.owner_username.length > 0 ? o.owner_username : null,
          });
        }
      }
      if (files >= MAX_FILES) break;
    }
    // 按 owner 去重取最新；owner 缺失按位置取最新
    const byOwner = new Map<string, RawCoreSighting>();
    const byPos = new Map<string, RawCoreSighting>();
    for (const sighting of sightings) {
      if (sighting.owner !== null) {
        const prev = byOwner.get(sighting.owner);
        if (prev === undefined || sighting.tick > prev.tick) byOwner.set(sighting.owner, sighting);
      } else {
        const key = `${sighting.position[0]},${sighting.position[1]}`;
        const prev = byPos.get(key);
        if (prev === undefined || sighting.tick > prev.tick) byPos.set(key, sighting);
      }
    }
    const merged = [...byOwner.values(), ...byPos.values()];
    merged.sort((a, b) => b.tick - a.tick || a.position[0] - b.position[0] || a.position[1] - b.position[1]);
    return merged.slice(0, MAX_TARGETS).map((s) => ({
      position: s.position,
      lastSeenTick: s.tick,
      source: "CORE" as const,
      owner: s.owner,
    }));
  } catch {
    return [];
  }
}

