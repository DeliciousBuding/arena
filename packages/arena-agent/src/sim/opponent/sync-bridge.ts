/**
 * Persistent Sync Bridge — 常驻子进程同步 RPC 桥（2026-08-08，路线 A）
 *
 * 问题：`runEpisode` 主循环是同步的，而 Node `spawn` 管道是异步的；
 * Windows 下 libuv 管道无 OS fd，`fs.readSync` 不能同步读长驻进程 stdout
 * （这正是旧实现退回 `spawnSync --one-shot` 每 tick 重建进程的原因——
 * 每次重建都重新 import pydantic SDK，实测 290ms/tick 的真相）。
 *
 * 方案：worker_threads + SharedArrayBuffer + Atomics。
 *  - worker 线程持有 Python 常驻子进程（异步 readline 管道），主线程完全不碰 IO；
 *  - 主线程（同步循环内）把请求 JSON 写入 SAB 帧槽 → postMessage 触发 worker →
 *    Atomics.wait 阻塞等待（主线程阻塞不卡事件循环——worker 独立运行）；
 *  - worker 写子进程 stdin、读回一行 stdout、写 SAB、Atomics.notify 主线程。
 *
 * 由此"同步的 runEpisode 循环 + 常驻外部决策进程"两者兼得：每 tick 只剩
 * 决策本身（ms 级），不再为进程启动/import 买单。协议与 one-shot 版完全
 * 一致（stdin 一行 {"tick","state"} → stdout 一行 CommandPlan JSON）。
 *
 * 帧协议（SAB 帧槽，固定 16MB，区段不重叠）：
 *  - [0..8)  flags 区：Int32Array 视图（2 个 int32）——状态标志 + 载荷长度
 *  - [8..)   数据区：Uint8Array 视图——UTF-8 字节
 * 单槽串行（一次一请求一响应），天然匹配决策器的串行语义。
 *
 * 注意：worker 代码在 sync-bridge-worker.cjs（CommonJS——Worker eval 模式
 * 按 CJS 编译，内联模板里 import 会语法错误；文件 worker 更稳）。
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

/** 帧槽总字节数（16MB：PlayerState JSON 上限远低于此，留足余量）。 */
const FRAME_CAPACITY = 16 * 1024 * 1024;

/** 单 tick 决策超时（对齐 Rust 线 DECISION_TIMEOUT_MS=10s——榜二决策 ms 级）。 */
export const DECISION_TIMEOUT_MS = 10_000;

const FLAG_IDLE = 0;
const FLAG_BUSY = 1;
const FLAG_RESPONSE = 2;
const FLAG_ERROR = 3;
const FLAG_CLOSE = 4;

export interface SyncBridgeConfig {
  readonly python: string;
  /** 桥接脚本路径（opponent-bridge.py）。 */
  readonly bridgeScript: string;
  /** 传给桥接脚本的额外参数（--farmer-repo / --sdk-repo / --state-slot）。 */
  readonly bridgeArgs: readonly string[];
  /** L-C config-injection：spawn 桥进程时附加的环境变量（ARENA_CFG_* 等）。 */
  readonly env?: Record<string, string>;
  /** 桥进程工作目录（缺省继承父进程 cwd）。并发评测时用于隔离第三方 agent
   *  的相对路径状态文件（如 waaiging 的 .arena_hero_*.json）——见
   *  opponent-adapter.ts PersistentSubprocessDecider 的 per-instance temp dir。 */
  readonly cwd?: string;
}

/**
 * 常驻子进程同步桥：主线程同步 RPC ↔ worker 异步管道 ↔ 常驻 Python 进程。
 * 使用方式（单线程语义）：
 *   const bridge = new PersistentSyncBridge(config);
 *   const result = bridge.exchange(JSON.stringify({ tick, state }));
 *   bridge.close();
 */
export class PersistentSyncBridge {
  private readonly worker: Worker;
  private readonly frame: Uint8Array;
  private readonly flags: Int32Array;
  private closed = false;

  constructor(config: SyncBridgeConfig) {
    const shared = new SharedArrayBuffer(FRAME_CAPACITY);
    // flags 区 [0..8)（2 个 int32），数据区 [8..)——两区不重叠！
    this.flags = new Int32Array(shared, 0, 2);
    this.frame = new Uint8Array(shared, 8);
    this.worker = new Worker(
      fileURLToPath(new URL("./sync-bridge-worker.cjs", import.meta.url)),
      {
        workerData: {
          buffer: shared,
          python: config.python,
          bridgeScript: config.bridgeScript,
          bridgeArgs: config.bridgeArgs,
          ...(config.env !== undefined ? { env: config.env } : {}),
          ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        },
      },
    );
  }

  /**
   * 提交请求（流水线预取，P4g）：写请求 JSON 到帧槽 → postMessage 唤醒 worker，
   * 立即返回不阻塞。结果由 awaitResponse() 取回。与 awaitResponse 严格成对
   * 交替使用：同一时刻至多一个未决请求（单槽帧协议天然保证）。
   */
  submit(requestJson: string): void {
    if (this.closed) {
      throw new Error("sync bridge: exchange after close");
    }
    const bytes = new TextEncoder().encode(requestJson);
    if (bytes.length > FRAME_CAPACITY - 8) {
      throw new Error(`sync bridge: request too large (${bytes.length} bytes)`);
    }
    // 所有共享内存访问一律走 Atomics：worker 端"先写载荷、最后原子置状态标志"，
    // 主线程必须用原子读才能保证读到标志时载荷/长度已就绪（普通读可能读到中间态）。
    Atomics.store(this.flags, 0, FLAG_BUSY);
    Atomics.store(this.flags, 1, bytes.length);
    this.frame.set(bytes, 0);
    this.worker.postMessage(requestJson);
  }

  /**
   * 取回 submit 发起的请求结果（流水线预取，P4g）：阻塞等待响应（未完成则
   * 等——保底逻辑；10s 超时 fail-fast）。submit 后只能调用一次。
   */
  awaitResponse(): string {
    const waitStartedAt = Date.now();
    const deadline = Date.now() + DECISION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      Atomics.wait(this.flags, 0, FLAG_BUSY, 200);
      const flag = Atomics.load(this.flags, 0);
      if (flag === FLAG_RESPONSE) {
        const length = Atomics.load(this.flags, 1);
        const payload = new TextDecoder().decode(this.frame.slice(0, length));
        Atomics.store(this.flags, 0, FLAG_IDLE);
        // 临时计时（ARENA_BRIDGE_TIMING=1 时输出；默认关 = 零行为变化）。
        if (process.env.ARENA_BRIDGE_TIMING === "1") {
          console.error(
            `[sync-bridge timing] awaitBlockedMs=${Date.now() - waitStartedAt} respBytes=${Buffer.byteLength(payload)}`,
          );
        }
        return payload;
      }
      if (flag === FLAG_ERROR) {
        const length = Atomics.load(this.flags, 1);
        const message = new TextDecoder().decode(this.frame.slice(0, length));
        Atomics.store(this.flags, 0, FLAG_IDLE);
        throw new Error(`sync bridge: ${message}`);
      }
      if (flag === FLAG_CLOSE) {
        throw new Error("sync bridge: closed");
      }
    }
    throw new Error(`sync bridge: decision timeout (${DECISION_TIMEOUT_MS}ms)`);
  }

  /** 同步往返：发送请求 JSON → 阻塞等待响应 JSON。失败抛错（fail-fast）。
   *  语义与既有行为逐字节一致（submit + awaitResponse 的组合）。 */
  exchange(requestJson: string): string {
    const startedAt = Date.now();
    this.submit(requestJson);
    const response = this.awaitResponse();
    // 临时计时（ARENA_BRIDGE_TIMING=1 时输出到 stderr；默认关 = 零行为变化）。
    if (process.env.ARENA_BRIDGE_TIMING === "1") {
      console.error(
        `[sync-bridge timing] roundtrip=${Date.now() - startedAt}ms ` +
          `reqBytes=${Buffer.byteLength(requestJson)} respBytes=${Buffer.byteLength(response)}`,
      );
    }
    return response;
  }

  /** 关闭：通知 worker 优雅终止子进程（EOF/哨兵退出窗口内完成状态槽与遥测
   *  flush），并释放。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage("close");
      // worker 收尾（子进程优雅退出 + 遥测 flush）后置回 FLAG_IDLE；
      // 等待窗口 ≥ worker 的优雅窗口，防提前 terminate 打断上报。
      Atomics.wait(this.flags, 0, FLAG_IDLE, 4000);
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

/**
 * 构造一个"随用随起"的常驻桥（对局级生命周期）：默认 state-slot 走
 * os.tmpdir() 随机名；bridge 脚本按本文件相对定位。
 */
export function createReferenceBridge(options: {
  readonly python?: string;
  readonly farmerRepoDir: string;
  readonly sdkRepoDir?: string;
  readonly stateSlot?: string;
  readonly bridgeScript?: string;
  /** python-agents.json 注册名；默认 farmer。 */
  readonly agent?: string;
  /** P4c+d（2026-08-09）：遥测台账 instance 用 seed 推导（--seed <n>
   *  → bridge 端 instance=<agent>-s<n>）；null/缺省 = 不传（bridge 按
   *  --state-slot 文件名 / sim-<agent> 兜底）。 */
  readonly seed?: number | null;
  /** P4c+d：台账 instance 显式覆盖（优先于 --seed/--state-slot 推导）。 */
  readonly instance?: string | null;
  /** L-C config-injection：spawn 桥进程时附加的环境变量（ARENA_CFG_* 等）。 */
  readonly env?: Record<string, string>;
  /** 桥进程工作目录（缺省继承父进程 cwd；并发评测隔离用，见 SyncBridgeConfig）。 */
  readonly cwd?: string;
}): { readonly bridge: PersistentSyncBridge; readonly stateSlot: string } {
  const stateSlot =
    options.stateSlot ?? join(tmpdir(), `arena-ref-${randomUUID()}.pkl`);
  const bridgeScript =
    options.bridgeScript ??
    fileURLToPath(new URL("../../../scripts/opponent-bridge.py", import.meta.url));
  const bridgeArgs = [
    "--state-slot",
    stateSlot,
    "--farmer-repo",
    options.farmerRepoDir,
  ];
  // 只在非默认对手时显式传 --agent：默认 farmer 保持与旧 bridge 脚本 wire 兼容。
  if (options.agent !== undefined && options.agent !== "farmer") {
    bridgeArgs.push("--agent", options.agent);
  }
  if (options.sdkRepoDir !== undefined && options.sdkRepoDir.length > 0) {
    bridgeArgs.push("--sdk-repo", options.sdkRepoDir);
  }
  if (options.seed !== undefined && options.seed !== null) {
    bridgeArgs.push("--seed", String(options.seed));
  }
  if (options.instance !== undefined && options.instance !== null && options.instance.length > 0) {
    bridgeArgs.push("--instance", options.instance);
  }
  const bridge = new PersistentSyncBridge({
    python: options.python ?? "python",
    bridgeScript,
    bridgeArgs,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  return { bridge, stateSlot };
}

