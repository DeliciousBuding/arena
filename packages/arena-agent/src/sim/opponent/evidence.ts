/**
 * 对抗评测证据格式（M2，evidence-v1 契约，见根仓 docs/design/evidence-v1.md）：
 *  runner 跑完一批后写 manifest.json + summary.json（rounds/ 由 recorder.ts 的
 *  JSONL 承担）。schema 字段与 evidence-v1.md 完全一致；版本对比模式 seeds<12
 *  时 summary 标 "underpowered": true。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wilson95 } from "./stats.ts";

export type EvidenceMode = "matrix" | "version-compare" | "ffa";

export type EvidenceParticipantKind =
  | "config"
  | "git-tag"
  | "worktree-path"
  | "reference-python"
  | "http";

/** 参赛条目（id/desc/kind/source——source 为原始来源串：注册名/path:/配置档/对手名/端点）。 */
export interface EvidenceParticipant {
  readonly id: string;
  readonly desc: string;
  readonly kind: EvidenceParticipantKind;
  readonly source: string;
}

/** 单 seed 对局（1v1 或 ffa 一整场）。 */
export interface EvidenceRound {
  readonly seed: number;
  readonly winner: string | null;
  readonly finalResources: Readonly<Record<string, number>>;
  readonly finalPopulation: Readonly<Record<string, number>>;
  readonly coreAlive: Readonly<Record<string, boolean>>;
}

/** 汇总（按参与者 id 键控；wilson95 保留 2 位小数，winRate 2 位，均资源 1 位）。 */
export interface EvidenceSummary {
  readonly wins: Readonly<Record<string, number>>;
  readonly winRate: Readonly<Record<string, number>>;
  readonly wilson95: Readonly<Record<string, readonly [number, number]>>;
  readonly meanResources: Readonly<Record<string, number>>;
  /** 版本对比模式 seeds<12 时置 true（8 局 Wilson 半宽 ≈±30%，不可作 promotion 依据）。 */
  readonly underpowered?: true;
}

/** manifest.json 全文（evidence-v1.md §manifest.json schema 逐字段对应）。 */
export interface EvidenceManifest {
  readonly schema: "arena-ts/evidence/v1";
  readonly generatedAt: string;
  readonly rulesVersion: string;
  readonly engineCommit: string;
  readonly mode: EvidenceMode;
  readonly refillEveryTicks: number | null;
  readonly scenario: string;
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly participants: readonly EvidenceParticipant[];
  readonly rounds: readonly EvidenceRound[];
  readonly summary: EvidenceSummary;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 逐参与者汇总（wins/matches/resources 由调用方累计），rounds 全部计为 matches。 */
export function buildSummary(
  participants: readonly EvidenceParticipant[],
  stats: ReadonlyMap<string, { wins: number; matches: number; resources: readonly number[] }>,
  opts: { underpowered?: boolean },
): EvidenceSummary {
  const wins: Record<string, number> = {};
  const winRate: Record<string, number> = {};
  const wilson: Record<string, [number, number]> = {};
  const meanResources: Record<string, number> = {};
  for (const participant of participants) {
    const entry = stats.get(participant.id);
    const n = entry?.matches ?? 0;
    const w = entry?.wins ?? 0;
    wins[participant.id] = w;
    winRate[participant.id] = n === 0 ? 0 : round2(w / n);
    const [lower, upper] = n === 0 ? [0, 1] : wilson95(w, n);
    wilson[participant.id] = [round2(lower), round2(upper)];
    const resources = entry?.resources ?? [];
    meanResources[participant.id] =
      resources.length === 0 ? 0 : round1(resources.reduce((s, v) => s + v, 0) / resources.length);
  }
  return {
    wins,
    winRate,
    wilson95: wilson,
    meanResources,
    ...(opts.underpowered === true ? { underpowered: true } : {}),
  };
}

/** 按 evidence-v1 落盘 manifest.json + summary.json（目录自动创建，JSONL 不受影响）。 */
export function writeEvidence(recordDir: string, manifest: EvidenceManifest): void {
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(recordDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(recordDir, "summary.json"), `${JSON.stringify(manifest.summary, null, 2)}\n`);
}
