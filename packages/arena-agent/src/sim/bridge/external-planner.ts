/**
 * 外部策略进程桥接决策器（与 Rust 线 arena-sim-bridge 对偶）：把外部策略
 * （榜二 arena_farmer，经 scripts/opponent-bridge.py 包成服务）作为
 * PlanProvider 接入模拟器 episode——同场景同 seed 下直接 A/B 对照。
 *
 * 形态：每 tick 一次性 `spawnSync`（桥接脚本 `--one-shot`：读 stdin 一行
 * → 决策 → 输出一行 → 退出）。Windows 下 spawn 的 pipe 无 OS fd（libuv
 * 命名管道），无法同步读长驻进程 stdout；one-shot 是跨平台可靠解。
 * 记忆等价性：solo 场景全可见（vision 不过滤、资源/障碍全量透传），
 * 榜二跨 tick 记忆冗余——行为等价（Rust 线协议注释同口径）。
 *
 * 协议：stdin 一行 `{"tick":N,"state":<官方 PlayerState JSON>}` → stdout
 * 一行官方 CommandPlan JSON。stderr 透传（诊断日志）。决策失败 fail-fast。
 */

import { spawnSync } from "node:child_process";
import type { Plan, TickState } from "../../domain/model.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";
import { stateToOfficialJson } from "./official-state.ts";
import { planFromOfficialJson, type PlanWarning } from "./official-plan.ts";

export interface ExternalPlannerOptions {
  /** 外部策略命令（如 `python scripts/opponent-bridge.py --one-shot`）。 */
  readonly command: string;
  /** 每 tick 往返记录回调（数据收集）。 */
  readonly onExchange?: (tick: number, warnings: readonly PlanWarning[]) => void;
}

/** 本 tick 可见的全部模拟器 ID（外部策略只能操作这些单位）。 */
function simIdsOf(state: TickState): string[] {
  const ids = [...state.workers, ...state.vanguards, ...state.rangers].map((unit) => unit.id);
  if (state.core !== null) ids.push(state.core.id);
  return ids;
}

export class ExternalPlanner implements PlanProvider {
  private readonly command: string;
  private readonly onExchange?: (tick: number, warnings: readonly PlanWarning[]) => void;
  private tick = 0;

  constructor(options: ExternalPlannerOptions) {
    this.command = options.command;
    this.onExchange = options.onExchange;
  }

  decide(input: { readonly state: TickState }): Plan {
    const state = input.state;
    this.tick += 1;
    const request = JSON.stringify({ tick: this.tick, state: stateToOfficialJson(state) });
    const [program, ...args] = tokenizeCommand(this.command);
    const result = spawnSync(program, args, {
      input: request + "\n",
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      throw new Error(`opponent spawn failed (tick ${this.tick}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `opponent exited ${String(result.status)} (tick ${this.tick}): ${(result.stderr ?? "").trim()}`,
      );
    }
    const line = (result.stdout ?? "").trim();
    if (line.length === 0) {
      throw new Error(`opponent returned empty plan (tick ${this.tick})`);
    }
    const simIds = simIdsOf(state);
    const { plan, warnings } = planFromOfficialJson(JSON.parse(line), simIds);
    if (warnings.length > 0 && this.onExchange !== undefined) {
      this.onExchange(this.tick, warnings);
    }
    return plan;
  }
}

/** 命令 tokenizer：空格分隔 + 双引号分组（Windows 下无 shell 语义）。 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const character of command) {
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if ((character === " " || character === "\t") && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
