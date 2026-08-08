/**
 * Offline join for ml-sample-v1 -> decision.jsonl telemetry.
 *
 * Join key is exactly (processRunId, tick), matching the v3 M1 B+ design.
 * Missing telemetry is explicit; duplicate keys fail closed.
 */

import { readFileSync } from "node:fs";

import {
  FEATURE_V2_THREAT_MEMORY_TICKS,
  type FeatureV2ThreatLevel,
} from "../schema/feature-vector-v2.ts";

const THREAT_LEVELS = new Set<FeatureV2ThreatLevel>(["NORMAL", "ALERT", "ENGAGED", "BREAKOUT"]);

export interface DecisionJoinRecord {
  readonly processRunId: string;
  readonly tick: number;
  readonly tenantId: string | null;
  readonly runId: string | null;
  readonly threatLevel: FeatureV2ThreatLevel | null;
  readonly threatReason: string | null;
  readonly recentNonNormalThreatTicks6: number | null;
}

export interface DecisionJoinStats {
  readonly rowsParsed: number;
  readonly rowsIndexed: number;
  readonly rowsWithThreatLevel: number;
  readonly rowsWithoutThreatLevel: number;
  readonly malformedRows: number;
}

export interface DecisionJoinIndex {
  readonly records: ReadonlyMap<string, DecisionJoinRecord>;
  readonly stats: DecisionJoinStats;
}

export function decisionJoinKey(processRunId: string, tick: number): string {
  return `${processRunId}:${tick}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseThreatLevel(value: unknown): FeatureV2ThreatLevel | null {
  return typeof value === "string" && THREAT_LEVELS.has(value as FeatureV2ThreatLevel)
    ? value as FeatureV2ThreatLevel
    : null;
}

interface ParsedDecisionRow {
  readonly processRunId: string;
  readonly tick: number;
  readonly tenantId: string | null;
  readonly runId: string | null;
  readonly threatLevel: FeatureV2ThreatLevel | null;
  readonly threatReason: string | null;
}

function parseDecisionRow(value: unknown): ParsedDecisionRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.processRunId !== "string" || value.processRunId.length === 0) return null;
  if (!Number.isSafeInteger(value.tick) || (value.tick as number) < 1) return null;
  return {
    processRunId: value.processRunId,
    tick: value.tick as number,
    tenantId: typeof value.tenantId === "string" && value.tenantId.length > 0 ? value.tenantId : null,
    runId: typeof value.runId === "string" && value.runId.length > 0 ? value.runId : null,
    threatLevel: parseThreatLevel(value.threatLevel),
    threatReason: typeof value.threatReason === "string" ? value.threatReason : null,
  };
}

function withThreatMemory(rows: readonly ParsedDecisionRow[]): DecisionJoinRecord[] {
  const byProcessRun = new Map<string, ParsedDecisionRow[]>();
  for (const row of rows) {
    const group = byProcessRun.get(row.processRunId) ?? [];
    group.push(row);
    byProcessRun.set(row.processRunId, group);
  }

  const result: DecisionJoinRecord[] = [];
  for (const group of byProcessRun.values()) {
    group.sort((left, right) => left.tick - right.tick);
    const byTick = new Map(group.map((row) => [row.tick, row]));
    for (const row of group) {
      const window: ParsedDecisionRow[] = [];
      let complete = true;
      for (let offset = FEATURE_V2_THREAT_MEMORY_TICKS - 1; offset >= 0; offset -= 1) {
        const member = byTick.get(row.tick - offset);
        if (member === undefined || member.threatLevel === null) {
          complete = false;
          break;
        }
        window.push(member);
      }
      const recentNonNormalThreatTicks6 = complete
        ? window.filter((member) => member.threatLevel !== "NORMAL").length
        : null;
      result.push({ ...row, recentNonNormalThreatTicks6 });
    }
  }
  return result;
}

export function parseDecisionJsonl(text: string): DecisionJoinIndex {
  const parsedRows: ParsedDecisionRow[] = [];
  let rowsParsed = 0;
  let malformedRows = 0;

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    rowsParsed += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedRows += 1;
      continue;
    }
    const row = parseDecisionRow(value);
    if (row === null) {
      malformedRows += 1;
      continue;
    }
    parsedRows.push(row);
  }

  const records = new Map<string, DecisionJoinRecord>();
  let rowsWithThreatLevel = 0;
  let rowsWithoutThreatLevel = 0;
  for (const row of withThreatMemory(parsedRows)) {
    const key = decisionJoinKey(row.processRunId, row.tick);
    if (records.has(key)) {
      throw new Error(`duplicate decision telemetry join key: ${key}`);
    }
    records.set(key, Object.freeze(row));
    if (row.threatLevel === null) rowsWithoutThreatLevel += 1;
    else rowsWithThreatLevel += 1;
  }

  return {
    records,
    stats: Object.freeze({
      rowsParsed,
      rowsIndexed: records.size,
      rowsWithThreatLevel,
      rowsWithoutThreatLevel,
      malformedRows,
    }),
  };
}

export function loadDecisionJoinIndex(path: string): DecisionJoinIndex {
  return parseDecisionJsonl(readFileSync(path, "utf8"));
}

export function lookupDecisionRecord(
  index: DecisionJoinIndex,
  processRunId: string,
  tick: number,
): DecisionJoinRecord | null {
  return index.records.get(decisionJoinKey(processRunId, tick)) ?? null;
}
