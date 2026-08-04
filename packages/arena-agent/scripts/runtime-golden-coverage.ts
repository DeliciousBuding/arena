/**
 * Runtime-Golden 专项事件覆盖分析（Issue #1 Phase 6）。
 *
 * 消费 RuntimeGoldenRecorder 产出的 dataset（manifest.json + cases/*.json），
 * 检测四类专项是否被真实数据覆盖：
 *   - combat：SWEEP_RESOLVED / SHOT_HIT / SHOT_MISSED / UNIT_DAMAGED
 *   - core-migration：CORE_MOVE_STARTED / CORE_MOVE_SUCCEEDED / CORE_MOVE_FAILED
 *   - beacon：BEACON_PICKUP_FAILED / BEACON_DROPPED / BEACON_DROP_FAILED
 *   - respawn：CORE_RESPAWNED / RESPAWN_DELAYED / UNIT_SELF_DESTRUCTED
 *
 * 输出 JSON 报告（stdout），列明每个事件的触发 case、tick 与 hard mismatch 状态。
 * 该工具不参与决策，不连接真实 Arena，只读 dataset 目录。buildReport 可被测试直接导入。
 *
 * 用法：
 *   npx tsx packages/arena-agent/scripts/runtime-golden-coverage.ts \
 *     --dataset <runtime-golden dataset dir> [--json]
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PlayerState } from "@arena/arena-hero-ts";
import type { CalibrationCaseV1 } from "../src/sim/calibration/schema.ts";
import type { RuntimeGoldenDatasetManifest } from "../src/runtime-golden/recorder.ts";

const SPECIAL_EVENTS: Record<string, { group: string; label: string }> = {
  SWEEP_RESOLVED: { group: "combat", label: "Vanguard SWEEP 结算" },
  SHOT_HIT: { group: "combat", label: "Ranger SHOOT 命中" },
  SHOT_MISSED: { group: "combat", label: "Ranger SHOOT 未命中" },
  UNIT_DAMAGED: { group: "combat", label: "单位受击" },
  CORE_MOVE_STARTED: { group: "core-migration", label: "Core 迁移启动" },
  CORE_MOVE_SUCCEEDED: { group: "core-migration", label: "Core 迁移完成" },
  CORE_MOVE_FAILED: { group: "core-migration", label: "Core 迁移失败" },
  CORE_ACTION_FAILED: { group: "core-migration", label: "Core 动作失败" },
  BEACON_PICKUP_FAILED: { group: "beacon", label: "Beacon 拾取失败" },
  BEACON_DROPPED: { group: "beacon", label: "Beacon 落地" },
  BEACON_DROP_FAILED: { group: "beacon", label: "Beacon 落地失败" },
  BEACON_HARVEST_BONUS: { group: "beacon", label: "Beacon 采集加成" },
  CORE_RESPAWNED: { group: "respawn", label: "Core 重生" },
  RESPAWN_DELAYED: { group: "respawn", label: "重生延迟" },
  UNIT_SELF_DESTRUCTED: { group: "respawn", label: "单位自毁（重生触发）" },
};

const EVENT_GROUPS = ["combat", "core-migration", "beacon", "respawn"] as const;
type EventGroup = (typeof EVENT_GROUPS)[number];

interface CaseCoverage {
  readonly caseId: string;
  readonly tick: number;
  readonly file: string;
  readonly events: readonly string[];
  readonly groups: readonly EventGroup[];
}

export interface EventCoverage {
  readonly eventType: string;
  readonly label: string;
  readonly group: EventGroup;
  readonly triggered: boolean;
  readonly caseIds: readonly string[];
  readonly ticks: readonly number[];
}

export interface CoverageReport {
  readonly schema: "runtime-golden-coverage-v1";
  readonly datasetId: string;
  readonly tenantId: string;
  readonly sourceCommit: string;
  readonly rulesVersion: string;
  readonly caseCount: number;
  readonly coveredCases: number;
  readonly groupCoverage: Record<EventGroup, { covered: boolean; events: readonly EventCoverage[] }>;
  readonly uncovered: readonly EventCoverage[];
  readonly summary: {
    readonly combat: boolean;
    readonly coreMigration: boolean;
    readonly beacon: boolean;
    readonly respawn: boolean;
    readonly allCovered: boolean;
  };
}

function collectEvents(state: PlayerState): string[] {
  const types = new Set<string>();
  for (const event of state.events ?? []) {
    types.add(String(event.event_type));
  }
  return [...types].sort();
}

function eventsInCase(calibrationCase: CalibrationCaseV1): string[] {
  const events = new Set<string>();
  for (const state of [calibrationCase.before.state, calibrationCase.after.state]) {
    for (const eventType of collectEvents(state)) events.add(eventType);
  }
  return [...events].sort();
}

function groupsOf(events: readonly string[]): EventGroup[] {
  const groups = new Set<EventGroup>();
  for (const event of events) {
    const mapping = SPECIAL_EVENTS[event];
    if (mapping !== undefined) groups.add(mapping.group as EventGroup);
  }
  return EVENT_GROUPS.filter((group) => groups.has(group));
}

export function buildReport(datasetDir: string): CoverageReport {
  const manifest = JSON.parse(
    readFileSync(join(datasetDir, "manifest.json"), "utf-8"),
  ) as RuntimeGoldenDatasetManifest;

  const casesDir = join(datasetDir, "cases");
  const caseFiles = readdirSync(casesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const perCase: CaseCoverage[] = [];
  const eventTicks = new Map<string, { caseIds: string[]; ticks: number[] }>();
  for (const file of caseFiles) {
    const calibrationCase = JSON.parse(
      readFileSync(join(casesDir, file), "utf-8"),
    ) as CalibrationCaseV1;
    const events = eventsInCase(calibrationCase);
    const groups = groupsOf(events);
    perCase.push({
      caseId: calibrationCase.caseId,
      tick: calibrationCase.before.tick,
      file,
      events,
      groups,
    });
    for (const event of events) {
      if (SPECIAL_EVENTS[event] === undefined) continue;
      const entry = eventTicks.get(event) ?? { caseIds: [], ticks: [] };
      entry.caseIds.push(calibrationCase.caseId);
      entry.ticks.push(calibrationCase.before.tick);
      eventTicks.set(event, entry);
    }
  }

  const groupCoverage = {} as Record<EventGroup, { covered: boolean; events: EventCoverage[] }>;
  const uncovered: EventCoverage[] = [];
  const summary = {
    combat: false,
    coreMigration: false,
    beacon: false,
    respawn: false,
    allCovered: false,
  };

  for (const group of EVENT_GROUPS) {
    const groupEvents: EventCoverage[] = [];
    let groupCovered = false;
    for (const [eventType, mapping] of Object.entries(SPECIAL_EVENTS)) {
      if (mapping.group !== group) continue;
      const stats = eventTicks.get(eventType);
      const covered = stats !== undefined && stats.ticks.length > 0;
      const eventCoverage: EventCoverage = {
        eventType,
        label: mapping.label,
        group,
        triggered: covered,
        caseIds: stats?.caseIds ?? [],
        ticks: stats?.ticks ?? [],
      };
      groupEvents.push(eventCoverage);
      if (covered) groupCovered = true;
      if (!covered) uncovered.push(eventCoverage);
    }
    groupCoverage[group] = { covered: groupCovered, events: groupEvents };
    if (group === "combat") summary.combat = groupCovered;
    if (group === "core-migration") summary.coreMigration = groupCovered;
    if (group === "beacon") summary.beacon = groupCovered;
    if (group === "respawn") summary.respawn = groupCovered;
  }
  summary.allCovered = summary.combat && summary.coreMigration && summary.beacon && summary.respawn;

  return {
    schema: "runtime-golden-coverage-v1",
    datasetId: manifest.datasetId,
    tenantId: manifest.tenantId,
    sourceCommit: manifest.sourceCommit,
    rulesVersion: manifest.rulesVersion,
    caseCount: manifest.caseCount,
    coveredCases: perCase.filter((item) => item.groups.length > 0).length,
    groupCoverage,
    uncovered,
    summary,
  };
}

function printReport(report: CoverageReport): void {
  console.log(`dataset: ${report.datasetId} (tenant=${report.tenantId} commit=${report.sourceCommit.slice(0, 7)})`);
  console.log(`cases: ${report.caseCount} total, ${report.coveredCases} contain special events`);
  for (const group of EVENT_GROUPS) {
    const entry = report.groupCoverage[group];
    const triggered = entry.events.filter((event) => event.triggered);
    console.log(`\n[${group}] ${entry.covered ? "COVERED" : "NOT COVERED"} (${triggered.length}/${entry.events.length} events)`);
    for (const event of entry.events) {
      const detail = event.triggered ? `ticks=${event.ticks.join(",")}` : "no trigger";
      console.log(`  ${event.triggered ? "✔" : "✘"} ${event.eventType} (${event.label}): ${detail}`);
    }
  }
  console.log(
    `\nsummary: combat=${report.summary.combat} core-migration=${report.summary.coreMigration} beacon=${report.summary.beacon} respawn=${report.summary.respawn} allCovered=${report.summary.allCovered}`,
  );
  if (!report.summary.allCovered) {
    console.log("\nuncovered events:");
    for (const event of report.uncovered) console.log(`  - ${event.group}/${event.eventType}`);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isMain) {
  const datasetIndex = process.argv.indexOf("--dataset");
  if (datasetIndex === -1 || process.argv[datasetIndex + 1] === undefined) {
    throw new Error("缺少 --dataset 参数");
  }
  const datasetDir = process.argv[datasetIndex + 1];
  const report = buildReport(datasetDir);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}
