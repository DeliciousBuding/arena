/**
 * Episode Recorder — 对局过程落盘（2026-08-08，真实度/可审计性）
 *
 * 只读观测：挂到 runEpisode 的 onTickRecorded 钩子，把每 tick 的
 * 结算快照写成 JSONL（不参与模拟语义，无回放等价要求）。
 *
 * 文件格式（JSONL，首行 meta 对象，其后每行一个 tick 记录）：
 *   {"kind":"meta","seed":N,"rulesVersion":"v0.14","rulesPath":"...",
 *    "ticks":200,"players":["mine","farmer-s1"],"descs":{...},"startedAt":"..."}
 *   {"kind":"tick","tick":1,"players":[{"id":"mine","resources":25,
 *    "population":3,"coreAlive":true,"corePosition":[0,0]}, ...],
 *    "events":[{"eventType":"UNIT_MOVE_SUCCEEDED","reasonCode":null,
 *    "actorId":"...","targetId":null,"position":[1,0]}, ...],
 *    "planHashes":{"mine":"sha256:...","farmer-s1":"sha256:..."}}
 *
 * 用途：
 *  - 审计：逐 tick 复盘双方行为（资源/人口/事件/计划）；
 *  - 校准：与生产 outcome.jsonl 的事件分布对照（scripts/calibrate-distribution.mts）；
 *  - 回归：对局可复现（seed + rules + players 描述 + 落盘世界演化）。
 */
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { Plan } from "../../domain/model.ts";
import { hashPlan } from "../harness/episode.ts";
import type { ResolutionEvent } from "../engine/phase.ts";
import type { SimWorld } from "../world/types.ts";

export interface RecorderMeta {
  readonly seed: number;
  readonly rulesVersion: string;
  readonly rulesPath: string;
  readonly ticks: number;
  readonly players: readonly string[];
  readonly descs: Readonly<Record<string, string>>;
  readonly refill?: Readonly<{ everyTicks: number }>;
}

export interface TickRecordPlayer {
  readonly id: string;
  readonly resources: number;
  readonly population: number;
  readonly coreAlive: boolean;
  readonly corePosition: readonly [number, number] | null;
}

export interface TickRecordEvent {
  readonly eventType: string;
  readonly reasonCode: string | null;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly position: readonly [number, number] | null;
}

export interface TickRecord {
  readonly kind: "tick";
  readonly tick: number;
  readonly players: readonly TickRecordPlayer[];
  readonly events: readonly TickRecordEvent[];
  readonly planHashes: Readonly<Record<string, string>>;
}

/** 创建对局记录器：返回 onTickRecorded 兼容回调；对局结束调用 close()。 */
export function createEpisodeRecorder(outputPath: string, meta: RecorderMeta): {
  readonly onTickRecorded: (args: {
    readonly tick: number;
    readonly before: SimWorld;
    readonly after: SimWorld;
    readonly plans: Readonly<Record<string, Plan>>;
    readonly events: readonly ResolutionEvent[];
  }) => void;
  readonly close: () => void;
} {
  mkdirSync(dirname(outputPath), { recursive: true });
  const stream: WriteStream = createWriteStream(outputPath, { flags: "w" });
  stream.write(
    JSON.stringify({
      kind: "meta",
      seed: meta.seed,
      rulesVersion: meta.rulesVersion,
      rulesPath: meta.rulesPath,
      ticks: meta.ticks,
      players: meta.players,
      descs: meta.descs,
      refill: meta.refill ?? null,
      startedAt: new Date().toISOString(),
    }) + "\n",
  );

  return {
    onTickRecorded({ after, plans, events }) {
      const players: TickRecordPlayer[] = [];
      for (const playerId of meta.players) {
        const player = after.players.get(playerId);
        players.push({
          id: playerId,
          resources: player?.resources ?? 0,
          population: player?.units.length ?? 0,
          coreAlive: player !== undefined && player.core !== null,
          corePosition: player?.core?.position ?? null,
        });
      }
      const record: TickRecord = {
        kind: "tick",
        tick: after.tick,
        players,
        events: events.map((event) => ({
          eventType: event.eventType,
          reasonCode: event.reasonCode,
          actorId: event.actorId,
          targetId: event.targetId,
          position: event.position ?? null,
        })),
        planHashes: Object.fromEntries(
          Object.entries(plans).map(([playerId, plan]) => [playerId, hashPlan(plan)]),
        ),
      };
      stream.write(JSON.stringify(record) + "\n");
    },
    close() {
      stream.end();
    },
  };
}

/** 读取记录文件：返回 meta + 全部 tick 记录（校验 kind 顺序）。 */
export function readEpisodeRecord(path: string): {
  readonly meta: RecorderMeta & { readonly startedAt: string };
  readonly ticks: readonly TickRecord[];
} {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const meta = JSON.parse(lines[0]) as RecorderMeta & { readonly startedAt: string };
  const ticks: TickRecord[] = [];
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line) as TickRecord;
    if (record.kind !== "tick") continue;
    ticks.push(record);
  }
  return { meta, ticks };
}
