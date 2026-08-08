/**
 * HTTP Decider — 外部决策器 HTTP 传输（2026-08-08，平台化标志能力）
 *
 * 任何语言的 HTTP 服务都能当对手：POST {"tick":N,"state":<官方 PlayerState>}
 * → 响应体为官方 CommandPlan JSON（与子进程桥同一协议信封）。
 *
 * 同步性：runEpisode 主循环是同步的，HTTP 是异步的——复用 PersistentSyncBridge
 * 的 worker + SharedArrayBuffer + Atomics 方案：worker 线程持异步 fetch，
 * 主线程 Atomics.wait 同步等待。帧协议与 sync-bridge 一致。
 *
 * 用法（注册表或直接）：
 *   new HttpDecider("http://127.0.0.1:9000/decide")
 * 或 vs-arena --opponents http://127.0.0.1:9000/decide
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ProtoCommandPlan, ProtoCoreAction, ProtoPlayerState, ProtoUnitAction } from "./protocol-bridge.ts";
import type { ExternalDecider } from "./opponent-adapter.ts";
import { DECISION_TIMEOUT_MS } from "./sync-bridge.ts";

const FRAME_CAPACITY = 16 * 1024 * 1024;

const FLAG_IDLE = 0;
const FLAG_BUSY = 1;
const FLAG_RESPONSE = 2;
const FLAG_ERROR = 3;
const FLAG_CLOSE = 4;

/** 同步 HTTP RPC 桥（单请求一响应；worker 持 fetch，主线程 Atomics.wait）。 */
export class HttpBridge {
  private readonly worker: Worker;
  private readonly frame: Uint8Array;
  private readonly flags: Int32Array;
  private closed = false;

  constructor(endpoint: string, timeoutMs: number) {
    const shared = new SharedArrayBuffer(FRAME_CAPACITY);
    this.flags = new Int32Array(shared, 0, 2);
    this.frame = new Uint8Array(shared, 8);
    this.worker = new Worker(
      fileURLToPath(new URL("./http-bridge-worker.cjs", import.meta.url)),
      {
        workerData: { buffer: shared, endpoint, timeoutMs },
      },
    );
  }

  exchange(requestJson: string): string {
    if (this.closed) throw new Error("http bridge: exchange after close");
    const bytes = new TextEncoder().encode(requestJson);
    if (bytes.length > FRAME_CAPACITY - 8) {
      throw new Error(`http bridge: request too large (${bytes.length} bytes)`);
    }
    Atomics.store(this.flags, 0, FLAG_BUSY);
    Atomics.store(this.flags, 1, bytes.length);
    this.frame.set(bytes, 0);
    this.worker.postMessage(requestJson);

    const deadline = Date.now() + DECISION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      Atomics.wait(this.flags, 0, FLAG_BUSY, 200);
      const flag = Atomics.load(this.flags, 0);
      if (flag === FLAG_RESPONSE) {
        const length = Atomics.load(this.flags, 1);
        const payload = new TextDecoder().decode(this.frame.slice(0, length));
        Atomics.store(this.flags, 0, FLAG_IDLE);
        return payload;
      }
      if (flag === FLAG_ERROR) {
        const length = Atomics.load(this.flags, 1);
        const message = new TextDecoder().decode(this.frame.slice(0, length));
        Atomics.store(this.flags, 0, FLAG_IDLE);
        throw new Error(message);
      }
      if (flag === FLAG_CLOSE) throw new Error("http bridge: closed");
    }
    throw new Error(`http bridge: decision timeout (${DECISION_TIMEOUT_MS}ms)`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage("close");
      Atomics.wait(this.flags, 0, FLAG_IDLE, 2000);
    } catch {
      // worker 可能已退出——忽略。
    }
    try {
      this.worker.terminate();
    } catch {
      // 已终止。
    }
  }
}

/** HTTP 外部决策器：任何语言实现的 POST /decide 服务。 */
export class HttpDecider implements ExternalDecider {
  readonly endpoint: string;
  readonly bridge: HttpBridge;
  ready = true;

  constructor(endpoint: string, timeoutMs = DECISION_TIMEOUT_MS) {
    this.endpoint = endpoint;
    this.bridge = new HttpBridge(endpoint, timeoutMs);
  }

  decide(player: ProtoPlayerState, tick: number): ProtoCommandPlan {
    const request = JSON.stringify({ tick, state: player });
    const line = this.bridge.exchange(request);
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
        `http decider plan JSON parse failed (tick ${tick}): ${String(error)}` +
          `\nraw: ${line.slice(0, 2000)}`,
      );
    }
  }

  close(): void {
    this.bridge.close();
  }
}
