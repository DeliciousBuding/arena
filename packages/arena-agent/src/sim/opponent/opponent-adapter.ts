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
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plan, TickState } from "../../domain/model.ts";
import { cellKey } from "../../domain/model.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";
import {
  protoPlanToPlan,
  tickStateToProto,
  type ProtoCommandPlan,
  type ProtoCoreAction,
  type ProtoPlayerState,
  type ProtoUnitAction,
} from "./protocol-bridge.ts";
import { createReferenceBridge, PersistentSyncBridge } from "./sync-bridge.ts";

/** 对手决策器端口：输入官方玩家观察 → 输出官方计划（纯协议，无模拟器依赖）。
 *
 * 流水线预取端口（P4g，2026-08-09，可选）：`prefetch` 异步发起决策（不阻塞，
 * 结果缓存在实现内部），`decideCached` 取缓存结果（未完成则等待）。两者要么
 * 都实现要么都不实现；缺省 = 调用方退回同步 `decide`（逐字节不变）。 */
export interface ExternalDecider {
  /** 是否可用（e.g. 子进程就绪 / HTTP 连接建立）。 */
  readonly ready: boolean;
  /** 对单个观察做一次决策。实现方不得假设线程/时序。 */
  decide(player: ProtoPlayerState, tick: number): ProtoCommandPlan;
  prefetch?(player: ProtoPlayerState, tick: number): void;
  decideCached?(): ProtoCommandPlan;
  close(): void;
}

/** 把外部对手包装成决策器 PlanProvider。selfPlayerId 用于标记视图内"我方"单位。 */
export class OpponentAdapter implements PlanProvider {
  readonly decider: ExternalDecider;
  readonly selfPlayerId: string;
  readonly label: string;
  /** R2 桥状态投影（默认关）：传给 tickStateToProto 的 projectFields。 */
  private projectFields: boolean;
  /** 流水线预取缓存（decider 无原生 prefetch 时的同步兜底）：prefetch 同步
   *  计算缓存，decideCached 取。decider 原生支持时恒为 null。 */
  private prefetchedCommand: ProtoCommandPlan | null = null;

  constructor(
    decider: ExternalDecider,
    selfPlayerId: string,
    label = "opponent",
    options: { readonly projectFields?: boolean } = {},
  ) {
    this.decider = decider;
    this.selfPlayerId = selfPlayerId;
    this.label = label;
    this.projectFields = options.projectFields === true;
    // P4g+：decider 原生支持 prefetch/decideCached（持久桥）时 prefetch 为
    // 真异步（提交后不等待）——episode 调度优先发起；否则同步计算（假异步）。
    this.parallelPrefetch =
      typeof decider.prefetch === "function" && typeof decider.decideCached === "function";
  }

  /** R2：按 runFreeForAll bridgeProjection 逐 agent 开关状态投影（默认关）。 */
  setProjection(on: boolean): void {
    this.projectFields = on;
  }

  /** P4g+：prefetch 是否非阻塞发起（真异步桥）。 */
  readonly parallelPrefetch: boolean;

  decide(input: { readonly state: TickState; readonly policy?: import("../../runtime/macro-policy.ts").MacroPolicy }): Plan {
    const proto = tickStateToProto(input.state, this.selfPlayerId, { projectFields: this.projectFields });
    if (!this.decider.ready) return emptyPlanForTick(input.state.tick);
    const command = this.decider.decide(proto, input.state.tick);
    return protoPlanToPlan(command, this.label);
  }

  /** 流水线预取：decider 原生支持则异步发起（不阻塞）；否则同步计算并缓存
   *  （decideCached 取——行为与串行 decide 逐字节一致，仅时间点前移）。 */
  prefetch(input: { readonly state: TickState; readonly policy?: import("../../runtime/macro-policy.ts").MacroPolicy }): void {
    const proto = tickStateToProto(input.state, this.selfPlayerId, { projectFields: this.projectFields });
    this.prefetchedCommand = null;
    if (!this.decider.ready) {
      // 与 decide() 的空计划兜底对齐：不可用 → 缓存空计划（全 WAIT）。
      this.prefetchedCommand = { tick: input.state.tick, unit_actions: {}, core_action: null };
      return;
    }
    if (
      typeof this.decider.prefetch === "function" &&
      typeof this.decider.decideCached === "function"
    ) {
      this.decider.prefetch(proto, input.state.tick);
    } else {
      this.prefetchedCommand = this.decider.decide(proto, input.state.tick);
    }
  }

  /** 取流水线预取结果（decider 原生支持时可能阻塞等待——保底逻辑）。 */
  decideCached(): Plan {
    if (this.prefetchedCommand !== null) {
      const command = this.prefetchedCommand;
      this.prefetchedCommand = null;
      return protoPlanToPlan(command, this.label);
    }
    if (typeof this.decider.decideCached === "function") {
      return protoPlanToPlan(this.decider.decideCached(), this.label);
    }
    throw new Error("opponent adapter: decideCached without prefetch");
  }

  close(): void {
    this.decider.close();
  }
}

function emptyPlanForTick(tick: number): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

/* ============================================================
 * Persistent bridge — 常驻子进程决策器（路线 A，2026-08-08）
 * 用 PersistentSyncBridge（worker + Atomics）做同步 RPC：每 tick 不再
 * 重建 Python 进程（省掉 ~300ms import），热往返 ~12ms。协议与
 * one-shot 版完全一致；state-slot 语义相同（确定性不变）。
 * （历史注记：旧 one-shot 版 ReferenceSubprocessDecider 已于 2026-08-10
 * 删除——无调用方，仅剩本常驻版。）
 * ============================================================ */

export interface PersistentReferenceConfig {
  /** Python 解释器路径（默认 "python"）。 */
  readonly python?: string;
  /** 兼容占位（2026-08-10 死参数清理）：历史调用方仍传；bridge 已从
   *  python-agents.json 注册表解析仓库，不再传给 --farmer-repo。 */
  readonly farmerRepoDir?: string;
  /** 官方 SDK 仓库根（arena-hero-python），传给 bridge 的 --sdk-repo。 */
  readonly sdkRepoDir?: string;
  /** arena_farmer 的源码路径（.py，兼容旧接口；当前仅作校验占位）。 */
  readonly farmerPath: string;
  /** CoreFarmer 记忆 pickle 槽路径；缺省用 os.tmpdir() 下随机名（对局结束清理）。 */
  readonly stateSlot?: string;
  /** bridge 脚本路径（scripts/opponent-bridge.py），缺省按本文件相对定位。 */
  readonly bridgeScript?: string;
  /** python-agents.json 注册名；默认 farmer。 */
  readonly agent?: string;
  /** P4c+d：遥测台账 instance 用 seed 推导（--seed <n> → <agent>-s<n>）。 */
  readonly seed?: number | null;
  /** P4c+d：台账 instance 显式覆盖（优先于 --seed 推导）。 */
  readonly instance?: string | null;
  /** L-C config-injection：spawn 桥进程时附加的环境变量（ARENA_CFG_* 等）。 */
  readonly env?: Record<string, string>;
  /** 桥进程工作目录（缺省：per-instance 临时目录——隔离第三方 agent 的相对
   *  路径状态文件，防并发评测跨进程写冲突；显式传入则用传入目录不清理）。 */
  readonly cwd?: string;
}

/** 创建桥进程的隔离工作目录：per-instance mkdtemp + 复制父 cwd 的 .env
 *  （farmer/tactic 等经 Path.cwd()/.env 读 key——保持 key 读取兼容）。
 *  调试/兼容开关：ARENA_BRIDGE_CWD 显式指定共享工作目录时跳过隔离
 *  （= v3 全量时代的 cwd 行为；第三方 agent 有 cwd 依赖时使用）。 */
function createIsolatedBridgeCwd(): string {
  const shared = process.env.ARENA_BRIDGE_CWD;
  if (shared !== undefined && shared.length > 0) {
    return shared;
  }
  const isolated = mkdtempSync(join(tmpdir(), "arena-bridge-cwd-"));
  try {
    const dotEnv = join(process.cwd(), ".env");
    if (existsSync(dotEnv)) {
      copyFileSync(dotEnv, join(isolated, ".env"));
    }
  } catch {
    // .env 复制失败不阻断（非关键路径）。
  }
  return isolated;
}

/** 常驻子进程决策器：对局级生命周期（随用随起），close() 释放进程与槽。 */
export class PersistentSubprocessDecider implements ExternalDecider {
  readonly bridge: PersistentSyncBridge;
  readonly stateSlot: string;
  readonly slotIsDefault: boolean;
  readonly agent: string;
  ready = true;
  /** 隔离 cwd（本次创建并持有；close 时清理）。显式传入的 cwd 不清理。 */
  private readonly bridgeCwd: string | null;
  /** cwd 是否本次创建（true = close 时清理；false = 调用方传入，不清理）。 */
  private readonly bridgeCwdOwned: boolean;
  /** 预取请求的 tick（decideCached 解析响应兜底用；prefetch/decideCached 成对）。 */
  private pendingTick: number | null = null;

  constructor(config: PersistentReferenceConfig) {
    this.bridgeCwdOwned = config.cwd === undefined;
    this.bridgeCwd = config.cwd ?? createIsolatedBridgeCwd();
    const created = createReferenceBridge({
      python: config.python,
      sdkRepoDir: config.sdkRepoDir,
      stateSlot: config.stateSlot,
      bridgeScript: config.bridgeScript,
      agent: config.agent,
      seed: config.seed,
      instance: config.instance,
      cwd: this.bridgeCwd,
      ...(config.env !== undefined ? { env: config.env } : {}),
    });
    this.bridge = created.bridge;
    this.stateSlot = created.stateSlot;
    this.slotIsDefault = config.stateSlot === undefined;
    this.agent = config.agent ?? "farmer";
  }

  /** 流水线预取（P4g）：提交请求到 worker（不阻塞）——Python 决策与主线程
   *  结算/记录重叠；结果由 decideCached 取（此时桥已完成，等待≈0）。 */
  prefetch(player: ProtoPlayerState, tick: number): void {
    this.pendingTick = tick;
    const serializedAt = Date.now();
    const requestJson = JSON.stringify({ tick, state: player });
    // 临时计时（ARENA_BRIDGE_TIMING=1 时输出；默认关 = 零行为变化）。
    if (process.env.ARENA_BRIDGE_TIMING === "1") {
      console.error(
        `[sync-bridge timing] serializeMs=${Date.now() - serializedAt} reqBytes=${Buffer.byteLength(requestJson)}`,
      );
    }
    this.bridge.submit(requestJson);
  }

  /** 取预取结果（P4g）：桥未完成则阻塞等待（10s 超时兜底）。 */
  decideCached(): ProtoCommandPlan {
    const tick = this.pendingTick;
    this.pendingTick = null;
    if (tick === null) {
      throw new Error("persistent decider: decideCached without prefetch");
    }
    const line = this.bridge.awaitResponse();
    return parsePlanLine(line, this, tick);
  }

  decide(player: ProtoPlayerState, tick: number): ProtoCommandPlan {
    const request = JSON.stringify({ tick, state: player });
    const line = this.bridge.exchange(request);
    return parsePlanLine(line, this, tick);
  }

  close(): void {
    this.bridge.close();
    if (this.slotIsDefault && existsSync(this.stateSlot)) {
      try {
        unlinkSync(this.stateSlot);
      } catch {
        // 槽清理失败不阻断（临时目录会被系统回收）。
      }
    }
    if (this.bridgeCwdOwned && this.bridgeCwd !== null) {
      try {
        rmSync(this.bridgeCwd, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不阻断（系统会回收）。
      }
    }
  }
}

/** 解析桥响应行 → 官方 CommandPlan（decide / decideCached 共用）。
 *  解析失败把原始行带进错误（外部 agent 是黑盒——stdout 被污染时必须有原文可查）。 */
function parsePlanLine(
  line: string,
  decider: { readonly agent: string },
  tick: number,
): ProtoCommandPlan {
  try {
    const parsed = JSON.parse(line) as {
      readonly tick?: number;
      readonly unit_actions?: Readonly<Record<string, ProtoUnitAction | null>>;
      readonly core_action?: ProtoCoreAction | null;
    };
    return {
      tick: parsed.tick ?? tick,
      unit_actions: parsed.unit_actions ?? {},
      core_action: parsed.core_action ?? null,
    };
  } catch (error) {
    throw new Error(
      `opponent plan JSON parse failed (${decider.agent}, tick ${tick}): ${String(error)}` +
        `\nraw: ${line.slice(0, 2000)}`,
    );
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
