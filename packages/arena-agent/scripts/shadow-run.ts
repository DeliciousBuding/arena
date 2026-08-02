/** Shadow 验证：真实状态喂 TS 决策闭环，只观察不提交。
 *
 * 两种模式：
 * 1. 真机（默认）：连线上游戏（ARENA_HERO_API_KEY_4，需账号有进行中游戏）
 * 2. 离线 replay（--replay-dir=...）：读 burn-in 的 raw-state 快照，走
 *    parseStreamMessage → Turn → handleTurn(shadow) 全链路，不碰网络
 *
 * 用法（arena-pr-verify/packages/arena-agent）：
 *   npx tsx scripts/shadow-run.ts --replay-dir=PROJECT_ROOT/arena/runs/<run>/raw-state [--ticks N]
 *
 * 输出：每 Tick 一行 JSON（tick/status/source/决策要点），结束后打印汇总。
 */

import { ArenaHeroClient, Turn, parseStreamMessage } from "@arena/arena-hero-ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import { handleTurn } from "../src/runtime/loop.ts";

const ARENA_ROOT = "PROJECT_ROOT/arena"; // 主仓库（.env 所在）

function apiKey(name: string): string {
  const envPath = `${ARENA_ROOT}/.env`;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(new RegExp(`^${name}=(.*)$`));
    if (m) return m[1].trim();
  }
  throw new Error(`${envPath} 缺少 ${name}`);
}

const maxTicks = Number(process.argv.find((a) => a.startsWith("--ticks="))?.split("=")[1] ?? 20);
const replayDir = process.argv.find((a) => a.startsWith("--replay-dir="))?.split("=")[1];

const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
let ticks = 0;
const decisions: Record<string, number> = {};

/** shadow 模式不会提交，submitter 只是占位。 */
function noopSubmitter(): never {
  throw new Error("shadow: 不应提交");
}

async function runReplay(dir: string): Promise<void> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f)) // Python dump 命名：{tick}.json
    .sort((a, b) => Number(a) - Number(b))
    .slice(-maxTicks);
  console.log(`replay ${files.length} 个真实状态快照 from ${dir}`);
  let bad = 0;
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    } catch {
      bad += 1; // 多租户共享 raw_state_dir：同 tick 文件被并发写坏（拼接/截断）→ 跳过
      continue;
    }
    const state = parseStreamMessage(JSON.stringify({ type: "state", data: raw }));
    // Python dump 的 PlayerState 不含 tick——tick 在文件名（{tick}.json）
    const tick = Number(file.replace(".json", ""));
    const turn = new Turn(tick, state, noopSubmitter);
    const outcome = await handleTurn(turn as never, planner, { submissionMode: "disabled" }, 8000);
    decisions[outcome.source] = (decisions[outcome.source] ?? 0) + 1;

    ticks += 1;
    console.log(
      JSON.stringify({
        tick: outcome.tick,
        status: state.status,
        source: outcome.source,
        units: Object.keys(outcome.plan.unitActions).length,
        core: outcome.plan.coreAction?.type ?? null,
      }),
    );
  }
  if (bad > 0) console.log(`跳过 ${bad} 个并发写坏的快照（多租户 raw_state_dir 竞争）`);
}

async function runLive(): Promise<void> {
  const client = new ArenaHeroClient({ apiKey: apiKey("ARENA_HERO_API_KEY_4") });
  for await (const turn of client.turns()) {
    if (ticks >= maxTicks) break;
    const outcome = await handleTurn(turn as never, planner, { submissionMode: "disabled" }, 8000);
    decisions[outcome.source] = (decisions[outcome.source] ?? 0) + 1;

    ticks += 1;
    console.log(
      JSON.stringify({
        tick: outcome.tick,
        status: (turn.state as { status?: string }).status,
        source: outcome.source,
        units: Object.keys(outcome.plan.unitActions).length,
        core: outcome.plan.coreAction?.type ?? null,
      }),
    );
  }
  client.close();
}

await (replayDir ? runReplay(replayDir) : runLive());

console.log(`\n=== shadow 汇总（${ticks} ticks）===`);
console.log(JSON.stringify({ ticks, decisions }, null, 2));
process.exit(0);
