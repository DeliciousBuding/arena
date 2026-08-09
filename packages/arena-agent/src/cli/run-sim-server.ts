/**
 * sim-server（agent-ecosystem-v1 P2a）：把模拟器 episode 引擎包装成官方
 * Arena Hero WebSocket 服务，官方 SDK（Python/TS fork）零改动直连。
 *
 * 协议对齐（wire 单源见 arena-hero-ts/src/wire-schema.ts 与
 * reference/official/arena-hero-python/src/arena_hero/_protocol.py）：
 *   服务器 → 客户端（text frame）：
 *     {"type":"tick","data":N}            —— N>=1，逻辑 tick 开始
 *     {"type":"state","data":PlayerState} —— 本玩家私有观察（含上轮私有事件）
 *     {"type":"received","data":Received} —— 计划入库回执（plan 原样回显）
 *   客户端 → 服务器（CommandPlan JSON）：
 *     WS text message（自定义直连路径）
 *     POST /api/v1/game/commands（官方 SDK turn.submit 路径，202 + Accepted）
 *
 * 世界循环复用 episode 的每 tick 流程（simTurnLike → reduceTurn →
 * validatePlan → settleTick → privateEventsForPlayer），只把 planner.decide
 * 换成客户端提交的计划；sim/ 引擎零改动（纯函数调用）。
 *
 * 结算事件按官方协议随下一 tick 的 PlayerState.events 私有投递：官方
 * parse_stream_message 只认 tick/state/received 三种信封，独立事件帧会被
 * 拒绝，官方没有独立事件消息类型。
 *
 * WS 传输用 node:http 手写 RFC 6455（arena-agent 无 ws 依赖，按隔离纪律
 * 不在 sim/ 闭包内加网络代码；服务在 CLI 层）。
 */

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { resolveArenaDataRoot } from "../app/data-root.ts";
import type { Plan, TickState } from "../domain/model.ts";
import { validatePlan, type ValidationResult } from "../domain/plan-validator.ts";
import { reduceTurn, type TurnLike } from "../domain/state-reducer.ts";
import {
  manifestHash,
  type RulesManifest,
} from "../sim/contracts/rules-manifest.ts";
import { createSeededRng } from "../sim/deterministic/rng.ts";
import { settleTick, type SettlementContext } from "../sim/engine/settlement.ts";
import { hashPlan, type EpisodeRecord, type EpisodeResult } from "../sim/harness/episode.ts";
import { stateToOfficialJson } from "../sim/bridge/official-state.ts";
import { planFromOfficialJson } from "../sim/bridge/official-plan.ts";
import {
  normalizeOwnerUsername,
  type ProtoCommandPlan,
} from "../sim/opponent/protocol-bridge.ts";
import { privateEventsForPlayer } from "../sim/visibility/private-events.ts";
import { simTurnLike } from "../sim/visibility/visibility.ts";
import {
  TELEMETRY_ENDPOINT_ENV,
  tickSummaryFromTickState,
  type SimTelemetrySink,
} from "../sim/telemetry.ts";
import {
  atomicWriteJson,
  atomicWriteJsonl,
  atomicWriteText,
  defaultRunId,
  prepareRunDir,
  resolveOutputBase,
  sha256Json,
  sha256Text,
} from "../sim/tools/artifacts.ts";
import { summarizeEpisode } from "../sim/tools/experiments.ts";
import { canonicalWorldJson, worldHash } from "../sim/world/canonical.ts";
import { worldFromScenario } from "../sim/world/loaders.ts";
import type { SimWorld } from "../sim/world/types.ts";
import type { ResolutionEvent } from "../sim/engine/phase.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");

const WEBSOCKET_PATH = "/api/v1/game/ws";
const COMMAND_PATH = "/api/v1/game/commands";
/** RFC 6455 握手 GUID。 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const COMMAND_SOURCE = "AGENT" as const;
const PLAN_TIMEOUT_MS = 5000;
const TICK_INTERVAL_MS = 200;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY_VIOLATION = 1008;

export interface SimServerOptions {
  readonly scenarioPath: string;
  readonly scenario: unknown;
  readonly rules: RulesManifest;
  readonly rulesPath: string;
  readonly ticks: number;
  readonly seed: number;
  readonly port: number;
  /** 空数组 = 不认证（本地模拟）；否则 WS 握手必须带 Bearer 其中某个 key。
   *  支持多 key（官方 SDK 每客户端独立 api_key，多客户端同场时各用各的）。 */
  readonly simKeys: string[];
  readonly dataRoot: string | null;
  readonly output: string | null;
  readonly runId: string | null;
  readonly force: boolean;
}

/* ============================================================
 * RFC 6455 最小服务端传输层（arena-agent 无 ws 依赖，手写）
 * ============================================================ */

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header: number[] = [0x80 | opcode];
  const length = payload.length;
  if (length < 126) {
    header.push(length);
  } else if (length < 0x10000) {
    header.push(126, (length >>> 8) & 0xff, length & 0xff);
  } else {
    header.push(127);
    const wide = Buffer.allocUnsafe(8);
    wide.writeBigUInt64BE(BigInt(length));
    header.push(...wide);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

interface WebSocketCallbacks {
  readonly onMessage: (text: string) => void;
  readonly onClose: () => void;
}

/** 帧解码：text/continuation/ping/pong/close；客户端帧必须 masked（RFC 6455）。 */
class WebSocketConnection {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragmented: Buffer<ArrayBufferLike> | null = null;
  private closed = false;
  private notifiedClose = false;
  private readonly socket: Duplex;
  private readonly callbacks: WebSocketCallbacks;

  constructor(
    socket: Duplex,
    callbacks: WebSocketCallbacks,
  ) {
    this.socket = socket;
    this.callbacks = callbacks;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("close", () => this.notifyClose());
    socket.on("error", () => this.notifyClose());
  }

  private notifyClose(): void {
    if (this.notifiedClose) return;
    this.notifiedClose = true;
    this.callbacks.onClose();
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close(code: number, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf8");
    this.socket.write(encodeFrame(0x8, payload));
    this.socket.end();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  /** 喂入 socket 数据（含 upgrade 时随请求头到达的 head 帧）。 */
  feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    while (!this.closed) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) {
          this.close(1009, "message too large");
          return;
        }
        length = Number(wide);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.close(1009, "message too large");
        return;
      }
      if (!masked) {
        this.close(1002, "client frames must be masked");
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(length);
      const start = offset + 4;
      for (let index = 0; index < length; index += 1) {
        payload[index] = this.buffer[start + index] ^ mask[index & 3];
      }
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(fin, opcode, payload);
    }
  }

  private dispatch(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1 && this.fragmented !== null) {
        this.close(1002, "unexpected new data frame");
        return;
      }
      if (opcode === 0x0 && this.fragmented === null) {
        this.close(1002, "unexpected continuation frame");
        return;
      }
      this.fragmented =
        this.fragmented === null ? payload : Buffer.concat([this.fragmented, payload]);
      if (fin) {
        const message = this.fragmented;
        this.fragmented = null;
        this.callbacks.onMessage(message.toString("utf8"));
      }
      return;
    }
    if (opcode === 0x9) {
      // ping → pong（Python websockets 客户端 ping_interval=20s 依赖它）
      if (!this.closed) this.socket.write(encodeFrame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x8) {
      this.closed = true;
      this.socket.write(encodeFrame(0x8, payload.subarray(0, 2)));
      this.socket.end();
      return;
    }
    this.close(1002, `unsupported opcode ${opcode}`);
  }
}

/* ============================================================
 * 模拟器遥测（agent-telemetry-bridge-v1 §3.4）——复用 run-sim.ts
 * 的 SimHttpSink 模式（CLI 层 HTTP sink，fire-and-forget）
 * ============================================================ */

class SimHttpSink implements SimTelemetrySink {
  private readonly events: Array<Record<string, unknown>> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly tenant: string;

  constructor(endpoint: string, tenant: string) {
    this.endpoint = endpoint;
    this.tenant = tenant;
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref?.();
  }

  emitTick(tick: number, state: TickState): void {
    this.events.push({
      tenant: this.tenant,
      instance: this.tenant,
      ts: Date.now() / 1000,
      ...tickSummaryFromTickState(tick, state),
    });
    if (this.events.length >= 20) this.flush();
  }

  close(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private flush(): void {
    if (this.events.length === 0) return;
    const batch = this.events.splice(0);
    postJsonSilent(this.endpoint, { events: batch });
  }
}

/** node:http(s) 原生 POST（隔离合规：sim 闭包禁 fetch/长连接 token）。 */
function postJsonSilent(endpoint: string, payload: unknown): void {
  const url = new URL(endpoint);
  const body = JSON.stringify(payload);
  const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = doRequest(
    {
      hostname: url.hostname,
      port: url.port !== "" ? Number(url.port) : undefined,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume();
    },
  );
  req.on("error", () => {});
  req.end(body);
}

/* ============================================================
 * 协议工具
 * ============================================================ */

interface WireAccepted {
  readonly accepted: true;
  readonly tick: number;
  readonly source: "AGENT";
  readonly received_at: string;
}

interface PlayerSession {
  readonly playerId: string;
  readonly token: string | null;
  ws: WebSocketConnection | null;
  /** 当前 tick 客户端提交的内部计划（结算时消费）。 */
  pendingPlan: Plan | null;
  /** 最近一次实际执行的计划（未回时的重放源）。 */
  lastPlan: Plan | null;
  /** 最近一次客户端 wire 计划（Received 回执原样回显用）。 */
  lastWirePlan: Record<string, unknown> | null;
  /** 已广播 state 的 tick；迟连客户端不算入本 tick 计划等待。 */
  tickDelivered: number;
}

interface WorldOutcome {
  readonly world: SimWorld;
  readonly records: readonly EpisodeRecord[];
  readonly settledTicks: number;
  readonly illegalPlans: number;
  readonly repairedPlans: number;
  readonly totalEvents: number;
  readonly wallMs: number;
}

function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match === null ? null : match[1].trim();
}

function emptyPlan(tick: number): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceLabel(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith("..") ? `external:${basename(path)}` : rel.replaceAll("\\", "/");
}

/** 宽松 CommandPlan 形状校验 → 中立协议模型（细节由 protoPlanToPlan 兜底）。 */
function parseCommandPlanJson(raw: unknown): ProtoCommandPlan | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.tick !== "number" || !Number.isInteger(value.tick) || value.tick < 1) {
    return null;
  }
  const unitActions: Record<string, ProtoCommandPlan["unit_actions"][string]> = {};
  const unitRaw = value.unit_actions;
  if (unitRaw !== undefined && unitRaw !== null) {
    if (typeof unitRaw !== "object" || Array.isArray(unitRaw)) return null;
    for (const [id, action] of Object.entries(unitRaw as Record<string, unknown>)) {
      if (action === null || typeof action !== "object" || Array.isArray(action)) return null;
      const actionValue = action as Record<string, unknown>;
      if (typeof actionValue.type !== "string") return null;
      unitActions[id] = actionValue as ProtoCommandPlan["unit_actions"][string];
    }
  }
  let coreAction: ProtoCommandPlan["core_action"] = null;
  if (value.core_action !== undefined && value.core_action !== null) {
    if (typeof value.core_action !== "object" || Array.isArray(value.core_action)) return null;
    const coreValue = value.core_action as Record<string, unknown>;
    if (typeof coreValue.type !== "string") return null;
    coreAction = coreValue as ProtoCommandPlan["core_action"];
  }
  return { tick: value.tick, unit_actions: unitActions, core_action: coreAction };
}

/** 回显用的 wire plan：只保留官方 CommandPlan 声明字段。 */
function sanitizeWirePlan(wire: ProtoCommandPlan): Record<string, unknown> {
  const unitActions: Record<string, unknown> = {};
  for (const [id, action] of Object.entries(wire.unit_actions)) {
    if (action !== null && typeof action === "object") unitActions[id] = action;
  }
  const out: Record<string, unknown> = { tick: wire.tick, unit_actions: unitActions };
  if (wire.core_action !== null) out.core_action = wire.core_action;
  return out;
}

/**
 * stateToOfficialJson 的官方严格兼容适配：v0.14 上游移除
 * population_tier/upkeep_next_tick（官方 Python SDK extra="forbid"，多余
 * 字段拒收）；RESPAWNING 必须带 respawn_at_tick；MOVING Core 必须带迁移
 * 四字段（官方 CoreView 校验要求）；owner_username 过官方 pattern 归一化。
 */
function officialPlayerStateJson(
  world: SimWorld,
  playerId: string,
  state: TickState,
): Record<string, unknown> {
  const wire = stateToOfficialJson(state);
  delete wire.population_tier;
  delete wire.upkeep_next_tick;

  const player = world.players.get(playerId);
  if (player !== undefined && player.status === "RESPAWNING") {
    wire.respawn_at_tick = player.respawnAtTick;
  }

  const objects = wire.objects as Array<Record<string, unknown>>;
  const coreView = objects.find(
    (object) => object.kind === "CORE" && object.controlled === true,
  );
  if (coreView !== undefined && coreView.state === "MOVING") {
    const core = state.core;
    coreView.move_direction = core?.moveDirection ?? null;
    coreView.move_progress = core?.moveProgress ?? null;
    coreView.move_required_ticks = core?.moveRequiredTicks ?? null;
    coreView.destination = core?.destination ?? null;
  }
  if (coreView !== undefined && typeof coreView.owner_username === "string") {
    coreView.owner_username = normalizeOwnerUsername(coreView.owner_username);
  }
  return wire;
}

/* ============================================================
 * 服务运行时
 * ============================================================ */

class SimServerRuntime {
  private readonly options: SimServerOptions;
  private readonly playerIds: readonly string[];
  private readonly playerSessions = new Map<string, PlayerSession>();
  private readonly tokenToPlayer = new Map<string, string>();
  private readonly server: Server;
  private readonly runDir: string;
  private readonly runId: string;
  private readonly telemetrySinks = new Map<string, SimHttpSink>();
  private currentTick = 0;
  /** 最近一次广播/结算所基于的 SimWorld（计划反查 UUID 映射用）。 */
  private currentWorld: SimWorld | null = null;
  private planWaitResolve: (() => void) | null = null;
  private planWaitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SimServerOptions) {
    this.options = options;
    const loaded = worldFromScenario(options.scenario);
    this.playerIds = [...loaded.players.keys()];
    const output = this.resolveOutput();
    this.runId = output.runId;
    this.runDir = prepareRunDir(output.outputBase, output.runId, options.force);
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server.on("error", (error) => {
      console.error(`sim-server: http error: ${error.message}`);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    console.log(
      `sim-server listening: ws://127.0.0.1:${this.options.port}${WEBSOCKET_PATH} ` +
        `players=${this.playerIds.join(",")} ticks=${this.options.ticks} seed=${this.options.seed}` +
        (this.options.simKeys.length === 0 ? " (auth disabled)" : " (auth enabled)"),
    );
  }

  async run(): Promise<number> {
    const started = performance.now();
    const outcome = await this.runWorldLoop();
    await this.closeClients(CLOSE_NORMAL);
    const finalWorldHash = worldHash(outcome.world);
    const result: EpisodeResult = {
      finalWorld: outcome.world,
      finalWorldHash,
      records: outcome.records,
      metrics: {
        ticks: outcome.settledTicks,
        illegalPlans: outcome.illegalPlans,
        repairedPlans: outcome.repairedPlans,
        unsupported: [...new Set(outcome.records.flatMap((record) => record.unsupported))].sort(),
        totalEvents: outcome.totalEvents,
        wallMs: outcome.wallMs,
        perPlayer: {},
        endedEarly: outcome.settledTicks < this.options.ticks,
        endReason: outcome.settledTicks < this.options.ticks ? ("all-dead" as const) : null,
        endedAtTick: outcome.settledTicks < this.options.ticks ? outcome.settledTicks : null,
      },
    };
    const summary = summarizeEpisode(
      {
        scenario: this.options.scenario,
        rulesPath: this.options.rulesPath,
        seed: this.options.seed,
        ticks: outcome.settledTicks,
        tenants: [],
      },
      result,
    );
    const recordsHash = atomicWriteJsonl(join(this.runDir, "records.jsonl"), outcome.records);
    const finalWorld = canonicalWorldJson(outcome.world);
    atomicWriteText(join(this.runDir, "final-world.json"), finalWorld);
    const finalWorldFileHash = sha256Text(finalWorld);
    const summaryHash = atomicWriteJson(join(this.runDir, "summary.json"), summary);
    const performanceArtifact = {
      schema: "sim.performance.v1",
      wallMs: outcome.wallMs,
      ticksPerSecond: outcome.settledTicks / (outcome.wallMs / 1000),
    };
    atomicWriteJson(join(this.runDir, "performance.json"), performanceArtifact);
    atomicWriteJson(join(this.runDir, "manifest.json"), {
      schema: "sim.run.v1",
      kind: "sim-server",
      runId: this.runId,
      status: "completed",
      source: sourceLabel(this.options.scenarioPath),
      sourceHash: sha256Json(this.options.scenario),
      rulesVersion: this.options.rules.rulesVersion,
      rulesManifestHash: manifestHash(this.options.rules),
      config: {
        ticks: this.options.ticks,
        settledTicks: outcome.settledTicks,
        seed: this.options.seed,
        port: this.options.port,
        players: [...this.playerIds],
        planTimeoutMs: PLAN_TIMEOUT_MS,
        tickIntervalMs: TICK_INTERVAL_MS,
        endedEarly: outcome.settledTicks < this.options.ticks,
        clients: [...this.playerSessions.values()].map((session) => ({
          playerId: session.playerId,
          connectedAtEnd: session.ws !== null,
        })),
      },
      deterministicArtifacts: {
        "records.jsonl": recordsHash,
        "final-world.json": finalWorldFileHash,
        "summary.json": summaryHash,
      },
      performanceArtifact: "performance.json",
    });
    await this.shutdownServer();
    this.closeAllTelemetry();
    console.log(
      `sim-server ok: ticks=${outcome.settledTicks}/${this.options.ticks} ` +
        `illegal=${outcome.illegalPlans} repaired=${outcome.repairedPlans} ` +
        `events=${outcome.totalEvents} out=${this.runDir}`,
    );
    return 0;
  }

  /* ---------------- 世界循环 ---------------- */

  private async runWorldLoop(): Promise<WorldOutcome> {
    const rules = this.options.rules;
    let world: SimWorld = { ...worldFromScenario(this.options.scenario), seed: this.options.seed };
    const rng = createSeededRng(this.options.seed);
    const context: SettlementContext = { rules, rng: () => rng.next() };
    const previousEvents = new Map<string, readonly ResolutionEvent[]>();
    const records: EpisodeRecord[] = [];
    const seenUnsupported = new Set<string>();
    let illegalPlans = 0;
    let repairedPlans = 0;
    let totalEvents = 0;
    let settledTicks = 0;
    const started = performance.now();

    for (let step = 0; step < this.options.ticks; step += 1) {
      const tick = world.tick;
      this.currentTick = tick;
      this.currentWorld = world;
      const before = world;

      // 1) 每玩家私有观察（simTurnLike → reduceTurn，含上轮私有事件）
      const observations = new Map<string, TickState>();
      for (const playerId of this.playerIds) {
        const turn: TurnLike = simTurnLike(
          world,
          playerId,
          rules,
          previousEvents.get(playerId) ?? [],
        );
        const state = reduceTurn(turn);
        observations.set(playerId, state);
        this.telemetrySinkFor(playerId)?.emitTick(tick, state);
      }

      // 2) 广播 Tick + PlayerState（新 tick 清掉上一轮未消费计划）
      for (const session of this.playerSessions.values()) session.pendingPlan = null;
      for (const playerId of this.playerIds) {
        const session = this.playerSessions.get(playerId);
        if (session === undefined || session.ws === null) continue;
        session.tickDelivered = tick;
        session.ws.sendText(JSON.stringify({ type: "tick", data: tick }));
        session.ws.sendText(
          JSON.stringify({
            type: "state",
            data: officialPlayerStateJson(before, playerId, observations.get(playerId)!),
          }),
        );
      }

      // 3) 等所有已连接客户端回计划（超时后未回 = 上轮重放或 WAIT）
      await this.waitForTickPlans();

      // 4) 收集计划 → 校验/修复 → settleTick 推进世界
      const settlementPlans = new Map<string, Plan>();
      const plans: Record<string, Plan> = {};
      const planHashes: Record<string, string> = {};
      const validations: Record<string, { valid: boolean; repaired: boolean; issueCount: number }> = {};
      for (const playerId of this.playerIds) {
        const state = observations.get(playerId)!;
        const { plan, validation } = this.planForPlayer(playerId, tick, state);
        if (!validation.valid) illegalPlans += 1;
        if (validation.repaired) repairedPlans += 1;
        settlementPlans.set(playerId, plan);
        plans[playerId] = plan;
        planHashes[playerId] = hashPlan(plan);
        validations[playerId] = {
          valid: validation.valid,
          repaired: validation.repaired,
          issueCount: validation.issues.length,
        };
      }
      const result = settleTick(world, settlementPlans, context);
      world = result.world;

      // 5) 私有事件入账（下一 tick 观察透传）
      for (const playerId of this.playerIds) {
        previousEvents.set(
          playerId,
          privateEventsForPlayer(before, world, playerId, result.events),
        );
      }
      for (const feature of result.unsupported) seenUnsupported.add(feature);
      totalEvents += result.events.length;
      records.push({
        tick,
        plans,
        planHashes,
        validations,
        aggregatePlanHash: sha256Json(plans),
        events: result.events,
        unsupported: result.unsupported,
        unknownEffects: result.unknownEffects,
        // P4e：sim-server 客户端计划走 PLAN_TIMEOUT_MS 超时（桥层语义），
        // 不启用 episode 引擎决策预算 → 恒空。
        decisionTimeouts: {},
        decisionTimeoutSkipped: [],
      });
      settledTicks += 1;

      // 6) 终局：全员阵亡，或多玩家局出现唯一存活（无待重生者）时提前结束；
      //    单玩家局只有 0 存活才算终局（1 存活 = 仍在运行，等 --ticks 跑完）。
      const alive = [...world.players.values()].filter((player) => player.core !== null).length;
      const respawning = [...world.players.values()].filter(
        (player) => player.status === "RESPAWNING",
      ).length;
      const decisive =
        alive === 0 || (alive === 1 && this.playerIds.length >= 2);
      if (decisive && respawning === 0) break;

      await sleep(TICK_INTERVAL_MS);
    }

    return {
      world,
      records,
      settledTicks,
      illegalPlans,
      repairedPlans,
      totalEvents,
      wallMs: performance.now() - started,
    };
  }

  private allConnectedHavePlans(): boolean {
    for (const session of this.playerSessions.values()) {
      if (
        session.ws !== null &&
        session.tickDelivered === this.currentTick &&
        session.pendingPlan === null
      ) {
        return false;
      }
    }
    return true;
  }

  private notifyPlanArrived(): void {
    if (this.planWaitResolve !== null && this.allConnectedHavePlans()) {
      const resolve = this.planWaitResolve;
      this.planWaitResolve = null;
      if (this.planWaitTimer !== null) {
        clearTimeout(this.planWaitTimer);
        this.planWaitTimer = null;
      }
      resolve();
    }
  }

  private async waitForTickPlans(): Promise<void> {
    if (this.allConnectedHavePlans()) return;
    await new Promise<void>((resolve) => {
      this.planWaitResolve = resolve;
      this.planWaitTimer = setTimeout(() => {
        this.planWaitResolve = null;
        this.planWaitTimer = null;
        resolve();
      }, PLAN_TIMEOUT_MS);
    });
    if (this.planWaitTimer !== null) {
      clearTimeout(this.planWaitTimer);
      this.planWaitTimer = null;
    }
    this.planWaitResolve = null;
  }

  /** 单个槽位的结算计划：本 tick 提交 → 上轮重放 → WAIT 空计划，均过校验。 */
  private planForPlayer(
    playerId: string,
    tick: number,
    state: TickState,
  ): { plan: Plan; validation: ValidationResult } {
    const session = this.playerSessions.get(playerId);
    let candidate: Plan | null = null;
    if (session !== undefined && session.ws !== null && session.pendingPlan !== null) {
      candidate = session.pendingPlan;
    } else if (session !== undefined && session.ws !== null && session.lastPlan !== null) {
      candidate = { ...session.lastPlan, tick };
    }
    const base = candidate ?? emptyPlan(tick);
    const validation = validatePlan(state, base);
    const usable = validation.valid || validation.repaired
      ? validation.plan
      : emptyPlan(tick);
    if (!validation.valid) {
      const codes = validation.issues
        .map((issue) => `${issue.code}(${issue.actorId})`)
        .join(", ");
      console.log(`sim-server: plan repaired for ${playerId} at tick ${tick}: ${codes}`);
    }
    if (session !== undefined) {
      session.lastPlan = usable;
      session.pendingPlan = null;
    }
    return { plan: usable, validation };
  }

  /* ---------------- 连接/计划入口 ---------------- */

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    const token = bearerToken(req.headers.authorization);

    // 认证失败/超员：握手成功后立即 close 1008（官方 SDK 映射 PolicyViolation）
    const rejection = this.authRejection(token);
    if (rejection !== null) {
      const ws = new WebSocketConnection(socket, { onMessage: () => {}, onClose: () => {} });
      ws.close(CLOSE_POLICY_VIOLATION, rejection);
      console.log(`sim-server: rejected connection: ${rejection}`);
      return;
    }
    const playerId = this.assignSlot(token);
    if (playerId === null) {
      const ws = new WebSocketConnection(socket, { onMessage: () => {}, onClose: () => {} });
      ws.close(CLOSE_POLICY_VIOLATION, "server full");
      console.log("sim-server: rejected connection: server full");
      return;
    }

    const session = this.playerSessions.get(playerId)!;
    session.ws = new WebSocketConnection(socket, {
      onMessage: (text) => this.handleClientPlanMessage(session, text),
      onClose: () => {
        session.ws = null;
        console.log(`sim-server: client disconnected: player=${playerId}`);
      },
    });
    if (head.length > 0) session.ws.feed(head);
    console.log(`sim-server: client connected: player=${playerId}`);
  }

  private authRejection(token: string | null): string | null {
    if (this.options.simKeys.length === 0) return null;
    return token !== null && this.options.simKeys.includes(token)
      ? null
      : "invalid authorization";
  }

  /** 连接顺序 → scenario player slot（token 可回收断线槽位；超员返回 null）。 */
  private assignSlot(token: string | null): string | null {
    if (token !== null) {
      const reclaimed = this.tokenToPlayer.get(token);
      if (reclaimed !== undefined) return reclaimed;
    }
    for (const playerId of this.playerIds) {
      if (!this.playerSessions.has(playerId)) {
        this.playerSessions.set(playerId, {
          playerId,
          token,
          ws: null,
          pendingPlan: null,
          lastPlan: null,
          lastWirePlan: null,
          tickDelivered: 0,
        });
        if (token !== null) this.tokenToPlayer.set(token, playerId);
        return playerId;
      }
    }
    return null;
  }

  private handleClientPlanMessage(session: PlayerSession, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log("sim-server: ignored non-JSON client message");
      return;
    }
    const outcome = this.intakePlan(session, parsed);
    if (!outcome.ok) {
      console.log(`sim-server: client plan rejected: ${outcome.reason}`);
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === COMMAND_PATH) {
      this.handleCommandSubmit(req, res);
      return;
    }
    writeJson(res, 404, { error: "NOT_FOUND", message: `no endpoint at ${req.url}` });
  }

  private handleCommandSubmit(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: "use POST" });
      return;
    }
    const token = bearerToken(req.headers.authorization);
    const session = this.sessionForToken(token);
    if (session === null) {
      writeJson(res, 401, {
        error: "UNAUTHORIZED",
        message: "unknown api key or no matching connection",
      });
      return;
    }
    collectBody(req, MAX_MESSAGE_BYTES)
      .then((body) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          writeJson(res, 400, { error: "INVALID_PLAN", message: "invalid JSON body" });
          return;
        }
        const outcome = this.intakePlan(session, parsed);
        if (!outcome.ok) {
          const status = outcome.reason?.startsWith("plan tick") ? 409 : 400;
          writeJson(res, status, { error: "INVALID_PLAN", message: outcome.reason });
          return;
        }
        writeJson(res, 202, outcome.accepted);
      })
      .catch(() => {
        writeJson(res, 413, { error: "PAYLOAD_TOO_LARGE", message: "body too large" });
      });
  }

  /** 共享计划入口：WS 直发 / HTTP POST 都落这里。 */
  private intakePlan(
    session: PlayerSession,
    raw: unknown,
  ): { ok: true; accepted: WireAccepted } | { ok: false; reason: string } {
    const wire = parseCommandPlanJson(raw);
    if (wire === null) return { ok: false, reason: "invalid command plan" };
    if (wire.tick !== this.currentTick) {
      return {
        ok: false,
        reason: `plan tick ${wire.tick} does not match current tick ${this.currentTick}`,
      };
    }
    // wire 上的实体 id 是 canonicalUuid(simId) 形式 → 用官方桥的反查翻译
    //（与 stateToOfficialJson 对偶；未知/陈旧单位 fail-open 丢弃）。
    const translated = planFromOfficialJson(raw, this.worldEntityIds());
    for (const warning of translated.warnings) {
      console.log(
        `sim-server: plan warning for ${session.playerId}: ${warning.kind} ${warning.detail}`,
      );
    }
    const receivedAt = new Date().toISOString();
    session.pendingPlan = translated.plan;
    session.lastWirePlan = sanitizeWirePlan(wire);
    this.broadcastReceived(session, receivedAt);
    this.notifyPlanArrived();
    return {
      ok: true,
      accepted: { accepted: true, tick: wire.tick, source: COMMAND_SOURCE, received_at: receivedAt },
    };
  }

  /** 当前世界全部实体的 sim id（unit_actions 键 / SHOOT target 反查表）。 */
  private worldEntityIds(): readonly string[] {
    const world = this.currentWorld;
    if (world === null) return [];
    const ids: string[] = [];
    for (const player of world.players.values()) {
      if (player.core !== null) ids.push(player.core.id);
      for (const unit of player.units) ids.push(unit.id);
    }
    return ids;
  }

  private broadcastReceived(session: PlayerSession, receivedAt: string): void {
    if (session.ws === null || session.lastWirePlan === null) return;
    session.ws.sendText(
      JSON.stringify({
        type: "received",
        data: {
          tick: this.currentTick,
          source: COMMAND_SOURCE,
          received_at: receivedAt,
          plan: session.lastWirePlan,
        },
      }),
    );
  }

  /** HTTP POST 无独立连接身份：按 api_key 路由槽位（tokenToPlayer 对偶，见 assignSlot）。 */
  private sessionForToken(token: string | null): PlayerSession | null {
    const sessions = [...this.playerSessions.values()];
    if (sessions.length === 0) return null;
    if (token !== null) {
      const routedPlayerId = this.tokenToPlayer.get(token);
      if (routedPlayerId !== undefined) {
        const routed = this.playerSessions.get(routedPlayerId);
        if (routed !== undefined) return routed;
      }
      if (this.options.simKeys.length > 0 && !this.options.simKeys.includes(token)) {
        return null;
      }
    }
    const connected = sessions.filter((session) => session.ws !== null);
    if (connected.length === 1) return connected[0];
    if (sessions.length === 1) return sessions[0];
    return null;
  }

  /* ---------------- 遥测 / 输出 / 关停 ---------------- */

  private telemetrySinkFor(playerId: string): SimTelemetrySink | null {
    const endpoint = (process.env[TELEMETRY_ENDPOINT_ENV] ?? "").trim();
    if (!endpoint) return null;
    let sink = this.telemetrySinks.get(playerId);
    if (sink === undefined) {
      sink = new SimHttpSink(endpoint, `sim-${playerId}`);
      this.telemetrySinks.set(playerId, sink);
    }
    return sink;
  }

  private closeAllTelemetry(): void {
    for (const sink of this.telemetrySinks.values()) sink.close();
  }

  private resolveOutput(): { outputBase: string; runId: string } {
    const dataRoot = resolveArenaDataRoot(
      REPO_ROOT,
      this.options.dataRoot ?? undefined,
      process.env.ARENA_DATA_ROOT,
    );
    const outputBase = resolveOutputBase(dataRoot, this.options.output);
    const identity = {
      kind: "sim-server",
      scenarioHash: sha256Json(this.options.scenario),
      rulesManifestHash: manifestHash(this.options.rules),
      ticks: this.options.ticks,
      seed: this.options.seed,
      port: this.options.port,
    };
    const runId = this.options.runId ?? defaultRunId("sim-server", identity);
    return { outputBase, runId };
  }

  private async closeClients(code: number): Promise<void> {
    for (const session of this.playerSessions.values()) {
      if (session.ws !== null) session.ws.close(code);
    }
    await sleep(300);
    for (const session of this.playerSessions.values()) {
      if (session.ws !== null) session.ws.destroy();
    }
  }

  private shutdownServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function collectBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 启动服务并跑完整场 episode；正常完成返回 0。 */
export async function runSimServer(options: SimServerOptions): Promise<number> {
  const runtime = new SimServerRuntime(options);
  await runtime.listen();
  return runtime.run();
}
