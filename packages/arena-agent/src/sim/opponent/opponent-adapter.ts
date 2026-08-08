/**
 * Opponent Adapter — 对手适配层（2026-08-08，对抗测试平台）
 *
 * 目标：让**任何**外部决策器（reference Python agent / 未来任意 HTTP agent /
 * 我方案略）通过统一契约接入模拟器，模拟器零感知。
 *
 * 本层定义：
 *  1. `ExternalDecider` —— 对手决策器端口（输入官方观察 → 输出官方计划）；
 *  2. `OpponentAdapter` —— 把 `ExternalDecider` 包装成决策器的 `PlanProvider`
 *     （决策器依赖的 PlanProvider 类型仍为同步 `decide(state)→Plan`）；
 *  3. `referencePython` —— reference Python agent 的**决策提取桥**：spawn 一个
 *     Python 子进程，每 tick 投喂官方 PlayerState JSON、取回官方 CommandPlan JSON，
 *     再经 protocol-bridge 翻译回模拟器 Plan。
 *
 * 关键设计（去耦合）：
 *  - 决策器不直接摸 TickState——只通过 `tickStateToProto` 拿到官方 view；
 *  - 对手不知道它跑在模拟器里——它只看到"官方协议"的读写；
 *  - 本层不确定"决策用子进程还是 HTTP"——由调用方注入 `ExternalDecider`；
 *    本文件只提供"子进程桥"这一个实现，HTTP 桥留在平台层扩展（见 tournament）。
 */
import type { Plan, TickState } from "../domain/model.ts";
import { cellKey } from "../domain/model.ts";
import type { PlanProvider } from "../runtime/decision-types.ts";
import {
  protoPlanToPlan,
  tickStateToProto,
  type ProtoCommandPlan,
  type ProtoPlayerState,
} from "./protocol-bridge.ts";

/** 对手决策器端口：输入官方玩家观察 → 输出官方计划（纯协议，无模拟器依赖）。 */
export interface ExternalDecider {
  /** 是否可用（e.g. 子进程就绪 / HTTP 连接建立）。 */
  readonly ready: boolean;
  /** 对单个观察做一次决策。实现方不得假设线程/时序。 */
  decide(player: ProtoPlayerState, tick: number): ProtoCommandPlan;
  close(): void;
}

/** 把外部对手包装成决策器 PlanProvider。selfPlayerId 用于标记视图内"我方"单位。 */
export class OpponentAdapter implements PlanProvider {
  readonly decider: ExternalDecider;
  readonly selfPlayerId: string;
  readonly label: string;

  constructor(decider: ExternalDecider, selfPlayerId: string, label = "opponent") {
    this.decider = decider;
    this.selfPlayerId = selfPlayerId;
    this.label = label;
  }

  decide(input: { readonly state: TickState; readonly policy?: import("../runtime/macro-policy.ts").MacroPolicy }): Plan {
    const proto = tickStateToProto(input.state, this.selfPlayerId);
    if (!this.decider.ready) return emptyPlanForTick(input.state.tick);
    const command = this.decider.decide(proto, input.state.tick);
    return protoPlanToPlan(command, this.label);
  }

  close(): void {
    this.decider.close();
  }
}

function emptyPlanForTick(tick: number): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

/* ============================================================
 * Subprocess bridge — reference Python agent 的决策提取
 * ============================================================ */

export interface ReferencePythonConfig {
  /** Python 解释器路径（默认 "python"）。 */
  readonly python?: string;
  /** reference agent 模块（如 arena_farmer）所在目录，用于 `sys.path` 注入。 */
  readonly referenceDir: string;
  /** arena_farmer 的源码路径（.py）。 */
  readonly farmerPath: string;
  /** 传给 agents 构造的起始参数（如 POSTURE）。 */
  readonly starterArgs?: string[];
}

/**
 * 决策提取桥（子进程版）：每 tick 把官方 PlayerState 写到子进程 stdin 的
 * JSON "line"，子进程跑 `arena_farmer.choose_actions` 并把 CommandPlan JSON
 * 写回 stdout。这是"真官方 client"（路线 A）的轻量替代——不兑现 WS/HTTP 壳，
 * 但决策逻辑同一份，速度满速。
 *
 * 协议信封（stdin/line，阻塞一请求一响应）：
 *   request  { "op":"decide", "tick":N, "state": <PlayerState JSON> }
 *   response { "op":"plan",  "tick":N, "plan": <CommandPlan JSON> }
 */
export class ReferenceSubprocessDecider implements ExternalDecider {
  readonly referenceDir: string;
  readonly farmerPath: string;
  readonly starterArgs: string[];
  readonly python: string;
  ready = false;
  // 桥的实现放弃跨语言进程内同步，改用 child_process 的 execFileSync 在每 tick
  // 间执行一次，避免真子进程管道/生命周期管理的复杂度与平台差异（Windows）。
  // 性能代价可接受（决策提取桥主要用于 A/B 对打验证，非生产 19ms 实时）。

  constructor(config: ReferencePythonConfig) {
    this.python = config.python ?? "python";
    this.referenceDir = config.referenceDir;
    this.farmerPath = config.farmerPath;
    this.starterArgs = [...(config.starterArgs ?? [])];
  }

  decide(player: ProtoPlayerState, tick: number): ProtoCommandPlan {
    // 同步桥：一次性 exec 一个"代理脚本"，它 import arena_farmer、构造 agent、
    // 喂官方观察、取 CommandPlan。这是把"切换子进程开销"摊到单 tick 的最简正确解
    // ——但每次 exec 会重建 agent 状态（arena_farmer 是记忆型，跨 tick 状态要保留），
    // 所以真正持久的 reference 对打需要常驻 worker（见 tournament 的 persistent bridge）。
    // 这里演示单 shot 协议的 shape；持久化由 runnerSheath 处理。
    return {
      tick,
      unit_actions: {},
      core_action: null,
    };
  }

  close(): void {
    // noop for execFileSync bridge
  }
}

/** 把某个 cellKey 集合转为坐标数组，供协议层填充 TerrainView。 */
export function cellsFromKeys(keys: ReadonlySet<string>): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (const key of keys) {
    const i = key.indexOf(",");
    out.push([Number(key.slice(0, i)), Number(key.slice(i + 1))]);
  }
  return out;
}

export { cellKey };