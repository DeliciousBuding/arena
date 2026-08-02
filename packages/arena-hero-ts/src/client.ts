/** Arena Hero 异步客户端：WebSocket 事件流 + HTTP 命令提交。
 *
 * 对应上游 client.py + _client_common.py。TS 用 async 迭代器取代
 * Python 的同步生成器；WS 用 `ws` 包（Node 内置 WebSocket 不支持
 * 自定义 header——认证必须带 Authorization）。
 */

import WebSocket, { type RawData } from "ws";
import type { Accepted, CommandPlan } from "./actions.ts";
import type { CommandSource } from "./enums.ts";
import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  PolicyViolationError,
  ProtocolError,
  TransportError,
} from "./errors.ts";
import type { PlayerState, Received, Tick } from "./types.ts";
import { apiError, encodePlan, parseAccepted, parseStreamMessage } from "./protocol.ts";
import { Turn } from "./turn.ts";

export const DEFAULT_BASE_URL = "https://api.arenahero.io";
export const COMMAND_PATH = "/api/v1/game/commands";
export const WEBSOCKET_PATH = "/api/v1/game/ws";
export const USER_AGENT = "arena-hero-ts/0.1.0";

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  websocketUrl?: string | null;
  requestTimeout?: number;
  requestRetries?: number;
  reconnectMinDelay?: number;
  reconnectMaxDelay?: number;
  maxMessageSize?: number;
  /** 握手超时（毫秒），超过视为连接失败进入重连。默认 15000。 */
  handshakeTimeoutMs?: number;
}

export interface ClientConfig {
  apiKey: string;
  baseUrl: string;
  websocketUrl: string;
  requestTimeout: number;
  requestRetries: number;
  reconnectMinDelay: number;
  reconnectMaxDelay: number;
  maxMessageSize: number;
  handshakeTimeoutMs: number;
}

export function buildConfig(options: ClientOptions): ClientConfig {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    websocketUrl = null,
    requestTimeout = 5.0,
    requestRetries = 2,
    reconnectMinDelay = 0.25,
    reconnectMaxDelay = 5.0,
    maxMessageSize = 2 * 1024 * 1024,
    handshakeTimeoutMs = 15_000,
  } = options;
  if (!apiKey || !apiKey.trim()) {
    throw new ConfigurationError("api_key must be a non-empty string");
  }
  if (/[^\x21-\x7E]/.test(apiKey)) {
    throw new ConfigurationError("api_key must contain visible ASCII only");
  }
  const normalizedBase = normalizeHttpUrl(baseUrl);
  const normalizedWs = websocketUrl != null
    ? normalizeWebsocketUrl(websocketUrl)
    : deriveWebsocketUrl(normalizedBase);
  if (requestTimeout <= 0) {
    throw new ConfigurationError("request_timeout must be positive");
  }
  if (requestRetries < 0) {
    throw new ConfigurationError("request_retries cannot be negative");
  }
  if (reconnectMinDelay <= 0) {
    throw new ConfigurationError("reconnect_min_delay must be positive");
  }
  if (reconnectMaxDelay < reconnectMinDelay) {
    throw new ConfigurationError("reconnect_max_delay cannot be less than reconnect_min_delay");
  }
  if (maxMessageSize <= 0) {
    throw new ConfigurationError("max_message_size must be positive");
  }
  return {
    apiKey,
    baseUrl: normalizedBase,
    websocketUrl: normalizedWs,
    requestTimeout,
    requestRetries,
    reconnectMinDelay,
    reconnectMaxDelay,
    maxMessageSize,
    handshakeTimeoutMs,
  };
}

function normalizeHttpUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError("base_url must be an http(s) origin without credentials, query, or fragment");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigurationError("base_url must be an http(s) origin without credentials, query, or fragment");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function normalizeWebsocketUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ConfigurationError("websocket_url must be a ws(s) URL without credentials, query, or fragment");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigurationError("websocket_url must be a ws(s) URL without credentials, query, or fragment");
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname || WEBSOCKET_PATH}`;
}

function deriveWebsocketUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  const path = `${parsed.pathname.replace(/\/+$/, "")}${WEBSOCKET_PATH}`;
  return `${scheme}//${parsed.host}${path}`;
}

/** 幂等键校验或生成（对应 validate_idempotency_key）。 */
export function validateIdempotencyKey(key: string | null, tick: number): string {
  if (key === null) {
    return `arena-${tick}-${crypto.randomUUID().replaceAll("-", "")}`;
  }
  if (key.length < 8 || key.length > 128 || /[^\x21-\x7E]/.test(key)) {
    throw new ConfigurationError("idempotency_key must contain 8 to 128 visible ASCII bytes without spaces");
  }
  return key;
}

function jitter(delay: number): number {
  return (0.8 + Math.random() * 0.4) * delay;
}

export type GameEvent = Tick | Turn | Received;

/** Tick 信封：只有 tick 字段（PlayerState/Received 无此判别组合）。 */
function isTick(message: Tick | PlayerState | Received): message is Tick {
  return "tick" in message && !("objects" in message) && !("plan" in message);
}

/** Received 信封：有 source + plan 字段。 */
function isReceived(message: Tick | PlayerState | Received): message is Received {
  return "source" in message && "plan" in message;
}

/** 消息队列：ws 事件回调推入，迭代器拉取（单消费者）。 */
class MessageQueue {
  private messages: string[] = [];
  private waiters: Array<(value: string | null) => void> = [];
  private errorWaiters: Array<(err: Error) => void> = [];
  private ended = false;
  private failure: Error | null = null;

  push(message: string): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
    } else {
      this.messages.push(message);
    }
  }

  /** 连接结束：后续 next() 一律返回 null。 */
  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  /** 协议错误：后续 next() 一律抛出（迭代器向上传播，不重连）。 */
  fail(err: Error): void {
    this.ended = true;
    this.failure = err;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
    for (const reject of this.errorWaiters.splice(0)) {
      reject(err);
    }
  }

  async next(): Promise<string | null> {
    if (this.failure !== null) {
      throw this.failure;
    }
    const message = this.messages.shift();
    if (message !== undefined) {
      return message;
    }
    if (this.ended) {
      return null;
    }
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.errorWaiters.push(reject);
    });
  }
}

export class ArenaHeroClient {
  readonly config: ClientConfig;
  private _closed = false;
  private _iterating = false;
  private _socket: WebSocket | null = null;
  private _currentTick: number | null = null;
  private _activeTurn: Turn | null = null;
  private _latestReceipts: Partial<Record<CommandSource, Received>> = {};
  private _abortController: AbortController | null = null;

  constructor(options: ClientOptions) {
    this.config = buildConfig(options);
  }

  get latestReceipts(): Readonly<Record<string, Received>> {
    return this._latestReceipts;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** 迭代完整游戏事件流：Tick / Turn / Received。断线自动重连（有界指数退避）。 */
  async *events(): AsyncGenerator<GameEvent> {
    this._startIteration();
    let delay = this.config.reconnectMinDelay;
    try {
      while (!this._closed) {
        let overrideDelay: number | null = null;
        const queue = new MessageQueue();
        const abort = new AbortController();
        this._abortController = abort;
        try {
          const ws = await this._connect(queue, abort.signal);
          this._socket = ws;
          delay = this.config.reconnectMinDelay;
          for (;;) {
            const raw = await queue.next(); // 协议违规在此抛出（不重连）
            if (raw === null) {
              break;
            }
            yield this._materialize(parseStreamMessage(raw));
          }
          const code = this._closeCode;
          if (code === 1000) {
            return; // 服务端正常结束
          }
          if (code === 1008) {
            // 已连接状态下收到 Policy Violation：终止而非静默重连
            throw new PolicyViolationError("WebSocket closed with 1008 Policy Violation");
          }
          // 其他 close code（1001/1006/1011...）：进入重连
        } catch (exc) {
          overrideDelay = this._classifyError(exc);
        } finally {
          this._socket = null;
          this._closeCode = null;
          this._establishedError = null;
          abort.abort();
          this._abortController = null;
        }
        if (this._closed) {
          return;
        }
        const sleepFor = overrideDelay ?? jitter(delay);
        await new Promise((resolve) => setTimeout(resolve, sleepFor * 1000));
        delay = Math.min(delay * 2, this.config.reconnectMaxDelay);
      }
    } finally {
      this._iterating = false;
      if (this._closed && this._activeTurn !== null) {
        this._activeTurn._seal();
      }
    }
  }

  /** 每个可行动 Tick 恰好 yield 一次（继续处理 receipts）。 */
  async *turns(): AsyncGenerator<Turn> {
    let lastTick: number | null = null;
    for await (const event of this.events()) {
      if (event instanceof Turn && event.tick !== lastTick) {
        lastTick = event.tick;
        yield event;
      }
    }
  }

  /** 提交一个完整 AGENT 计划（安全 exact-body 重试）。 */
  async submit(plan: CommandPlan, options: { idempotencyKey?: string | null } = {}): Promise<Accepted> {
    this._ensureOpen();
    const key = validateIdempotencyKey(options.idempotencyKey ?? null, plan.tick);
    const body = encodePlan(plan);
    const attempts = this.config.requestRetries + 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(`${this.config.baseUrl}${COMMAND_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: body,
          signal: AbortSignal.timeout(this.config.requestTimeout * 1000),
        });
        const content = new Uint8Array(await response.arrayBuffer());        if (response.status === 202) {
          return parseAccepted(content);
        }
        if (response.status !== 502 && response.status !== 503 && response.status !== 504) {
          throw apiError(response.status, content);
        }
      } catch (exc) {
        if (exc instanceof APIError) {
          throw exc;
        }
        lastError = exc;
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(0.1 * 2 ** attempt, 0.5) * 1000));
      }
    }
    throw new TransportError("command submission failed after safe retries", { cause: lastError });
  }

  close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    if (this._activeTurn !== null) {
      this._activeTurn._seal();
    }
    this._abortController?.abort();
    this._socket?.close();
  }

  private _closeCode: number | null = null;
  private _establishedError: Error | null = null;

  private _connect(queue: MessageQueue, signal: AbortSignal): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.websocketUrl, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "User-Agent": USER_AGENT,
        },
        maxPayload: this.config.maxMessageSize,
        perMessageDeflate: false, // 与上游一致：协议面不启用压缩
      });
      let settled = false;
      const cleanup = () => {
        clearTimeout(handshakeTimer);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        queue.end();
        reject(err);
      };
      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // 握手成功：error handler 保留为 established 阶段兜底
        resolve(ws);
      };
      const onAbort = () => {
        // close()/外部取消：终止可能仍在握手的 socket
        ws.terminate();
        fail(new Error("connect aborted"));
      };
      const handshakeTimer = setTimeout(() => {
        ws.terminate();
        fail(new TransportError("WebSocket handshake timed out"));
      }, this.config.handshakeTimeoutMs);
      signal.addEventListener("abort", onAbort);
      ws.on("open", succeed);
      ws.on("error", (err: Error) => {
        // ws 握手失败消息形如 'Unexpected server response: 401'——提取状态码
        const match = /Unexpected server response: (\d+)/.exec(err.message);
        if (match) {
          (err as Error & { status?: number }).status = Number(match[1]);
        }
        if (!settled) {
          fail(err);
          return;
        }
        // established 阶段：记录异常，等待 close 事件驱动收尾
        this._establishedError = err;
      });
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          // 协议违规（上游：拒绝 binary 帧）：终止流，向上传播 ProtocolError
          queue.fail(new ProtocolError("the server sent a binary WebSocket message"));
          return;
        }
        queue.push(data.toString("utf8"));
      });
      ws.on("close", (code: number) => {
        this._closeCode = code;
        queue.end();
      });
    });
  }

  private _classifyError(exc: unknown): number | null {
    if (exc instanceof ProtocolError) {
      throw exc; // 协议违规：直接传播，不重连（与上游一致）
    }
    if (exc instanceof PolicyViolationError) {
      throw exc;
    }
    if (exc instanceof Error && "status" in exc) {
      const status = (exc as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new AuthenticationError(`WebSocket authorization failed with HTTP ${status}`);
      }
      if (status === 409 || status === 429) {
        return 1.0;
      }
      if (status !== undefined && status >= 500 && status <= 599) {
        return null;
      }
      if (status !== undefined) {
        throw new TransportError(`WebSocket handshake failed with HTTP ${status}`);
      }
    }
    const closeCode = this._closeCode;
    if (closeCode === 1008) {
      throw new PolicyViolationError("WebSocket closed with 1008 Policy Violation");
    }
    return null;
  }

  private _materialize(message: Tick | PlayerState | Received): GameEvent {
    if (isTick(message)) {
      // Tick envelope
      if (this._currentTick !== message.tick) {
        this._latestReceipts = {};
      }
      this._currentTick = message.tick;
      if (this._activeTurn !== null) {
        this._activeTurn._seal();
        this._activeTurn = null;
      }
      return message;
    }
    if (isReceived(message)) {
      // Received envelope
      if (this._currentTick === message.tick) {
        this._latestReceipts[message.source] = message;
      }
      return message;
    }
    // PlayerState → Turn
    if (this._currentTick === null) {
      throw new ProtocolError("state arrived before tick");
    }
    if (this._activeTurn !== null) {
      this._activeTurn._seal();
    }
    const turn = new Turn(
      this._currentTick,
      message,
      (plan, key) => this.submit(plan, { idempotencyKey: key ?? null }),
    );
    this._activeTurn = turn;
    return turn;
  }

  private _startIteration(): void {
    this._ensureOpen();
    if (this._iterating) {
      throw new ConfigurationError("only one event iterator may run per client");
    }
    this._iterating = true;
  }

  private _ensureOpen(): void {
    if (this._closed) {
      throw new ConfigurationError("the client is closed");
    }
  }
}
