/** client.ts 集成测试：本地 mock server（HTTP + WS）覆盖生命周期/重连/提交/错误路径。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";

import { ArenaHeroClient, type GameEvent } from "../src/client.ts";
import { APIError, AuthenticationError, ConfigurationError, PolicyViolationError, ProtocolError, TransportError } from "../src/errors.ts";
import { parseAccepted } from "../src/protocol.ts";
import { Turn } from "../src/turn.ts";
import type { Accepted } from "../src/actions.ts";

/** mock server：HTTP（submit）+ WS（事件流）。可编程行为。 */
class MockGameServer {
  readonly http: Server;
  readonly wss: WebSocketServer;
  port = 0;
  /** upgrade 行为：返回状态码数组（按连接顺序消费；undefined = 放行）。 */
  upgradeStatuses: Array<number | undefined> = [];
  /** 建立后行为钩子：每个新连接调用。 */
  onConnect: Array<(ws: WebSocket) => void> = [];
  /** 提交行为：返回 [status, body]；数组按请求顺序消费（undefined 换 202）。 */
  submitResponses: Array<[number, unknown] | undefined> = [];
  /** 记录 submit 收到的 Idempotency-Key（按请求顺序）。 */
  idempotencyKeys: string[] = [];
  submitCount = 0;
  /** 置 true：下一次 upgrade 挂起不响应（模拟握手超时）。 */
  hangNextUpgrade = false;
  /** 跟踪所有 raw socket（含挂起的握手），close 时强制销毁。 */
  private sockets = new Set<import("node:stream").Duplex>();
  private connections = new Set<WebSocket>();

  constructor() {
    this.http = createServer((req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/v1/game/commands")) {
        const key = req.headers["idempotency-key"];
        if (typeof key === "string") {
          this.idempotencyKeys.push(key);
        }
        const response = this.submitResponses.shift();
        const status = response?.[0] ?? 202;
        this.submitCount += 1;
        if (status === 202) {
          // 回填请求体的 tick（与真实服务端一致）
          let tick = 1;
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              tick = (JSON.parse(body) as { tick?: number }).tick ?? 1;
            } catch {
              // 保持默认
            }
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ accepted: true, tick, source: "AGENT", received_at: "2026-08-02T12:00:00Z" }));
          });
          return;
        }
        const body = response?.[1] ?? {};
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
      ws.on("close", () => this.connections.delete(ws));
    });
    this.http.on("upgrade", (req, socket, head) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      if (this.hangNextUpgrade) {
        this.hangNextUpgrade = false;
        return; // 挂起：不响应（客户端握手超时后 terminate，close 时 destroy）
      }
      const status = this.upgradeStatuses.shift();
      if (status !== undefined) {
        socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 409 ? "Conflict" : "Error"}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const behavior = this.onConnect.shift();
        if (behavior) {
          behavior(ws);
        }
        this.wss.emit("connection", ws, req);
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  /** 服务端主动发一条 WS 消息。 */
  send(ws: WebSocket, payload: unknown | Uint8Array): void {
    if (payload instanceof Uint8Array) {
      ws.send(payload, { binary: true });
    } else {
      ws.send(JSON.stringify(payload));
    }
  }

  /** 确定性关闭：销毁所有残留 socket/连接后关 server（await 完成）。 */
  async close(): Promise<void> {
    for (const ws of this.connections) {
      ws.close();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

function makeClient(server: MockGameServer, extra: Partial<import("../src/client.ts").ClientOptions> = {}): ArenaHeroClient {
  return new ArenaHeroClient({
    apiKey: "test-key-0000000000000000",
    baseUrl: `http://127.0.0.1:${server.port}`,
    websocketUrl: `ws://127.0.0.1:${server.port}/api/v1/game/ws`,
    reconnectMinDelay: 0.01,
    reconnectMaxDelay: 0.05,
    handshakeTimeoutMs: 500,
    requestRetries: 2,
    ...extra,
  });
}

const MIN_STATE = {
  status: "ACTIVE",
  respawn_at_tick: null,
  resources: 0,
  population: 0,
  population_tier: 0,
  upkeep_next_tick: 0,
  champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
  objects: [],
  events: [],
};

async function setup(behavior?: (ws: WebSocket) => void): Promise<MockGameServer> {
  const server = new MockGameServer();
  if (behavior) {
    server.onConnect.push(behavior);
  }
  await server.listen();
  return server;
}

// ---------- 事件流 ----------

test("tick+state 流 → Tick/Turn 依次产出", async () => {
  const server = await setup((ws) => {
    server.send(ws, { type: "tick", data: 1 });
    server.send(ws, { type: "state", data: MIN_STATE });
    ws.close(1000);
  });
  const client = makeClient(server);
  const events: GameEvent[] = [];
  for await (const event of client.events()) {
    events.push(event);
  }
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { tick: 1 });
  assert.ok(events[1] instanceof Turn);
  assert.equal((events[1] as Turn).tick, 1);
  await server.close();
});

test("close 1000：迭代正常结束", async () => {
  const server = await setup((ws) => {
    ws.close(1000);
  });
  const client = makeClient(server);
  const events: GameEvent[] = [];
  for await (const event of client.events()) {
    events.push(event);
  }
  assert.equal(events.length, 0); // 无消息直接 1000 → 正常结束
  await server.close();
});

test("已连接状态 close 1008 → PolicyViolationError（不重连）", async () => {
  let connections = 0;
  const server = await setup((ws) => {
    connections += 1;
    ws.close(1008, "policy violation");
  });
  const client = makeClient(server, { reconnectMaxDelay: 0.02 });
  await assert.rejects(async () => {
    for await (const _ of client.events()) {
      // 不产生事件，直接 1008 关闭
    }
  }, PolicyViolationError);
  assert.equal(connections, 1); // 没有重连
  await server.close();
});

test("binary 消息 → ProtocolError（终止流，不重连）", async () => {
  let connections = 0;
  const server = await setup((ws) => {
    connections += 1;
    server.send(ws, new Uint8Array([0x7b, 0x7d]));
  });
  const client = makeClient(server);
  await assert.rejects(async () => {
    for await (const _ of client.events()) {
      // 不产生事件
    }
  }, ProtocolError);
  assert.equal(connections, 1);
  await server.close();
});

test("断线（1006 abnormal）→ 自动重连成功", async () => {
  const server = new MockGameServer();
  server.onConnect.push((ws) => {
    server.send(ws, { type: "tick", data: 1 });
    ws.terminate(); // 1006 abnormal：应触发重连
  });
  server.onConnect.push((ws) => {
    server.send(ws, { type: "tick", data: 2 });
    server.send(ws, { type: "state", data: MIN_STATE });
    ws.close(1000);
  });
  await server.listen();
  const client = makeClient(server);
  const events: GameEvent[] = [];
  for await (const event of client.events()) {
    events.push(event);
  }
  assert.equal(events.length, 3); // tick1 + tick2 + Turn
  assert.deepEqual(events[0], { tick: 1 });
  assert.deepEqual(events[1], { tick: 2 });
  await server.close();
});

test("握手 401 → AuthenticationError", async () => {
  const server = new MockGameServer();
  server.upgradeStatuses.push(401);
  await server.listen();
  const client = makeClient(server);
  await assert.rejects(async () => {
    for await (const _ of client.events()) {
      // no-op
    }
  }, AuthenticationError);
  await server.close();
});

test("握手 409 → 重连后成功", async () => {
  const server = new MockGameServer();
  server.upgradeStatuses.push(409);
  server.onConnect.push((ws) => {
    server.send(ws, { type: "tick", data: 7 });
    ws.close(1000);
  });
  await server.listen();
  const client = makeClient(server);
  const events: GameEvent[] = [];
  for await (const event of client.events()) {
    events.push(event);
  }
  assert.deepEqual(events[0], { tick: 7 }); // 第一次 409 → 重连 → 成功
  await server.close();
});

test("握手超时（upgrade 挂起）→ 超时后重连成功", async () => {
  const server = new MockGameServer();
  server.hangNextUpgrade = true; // 第一次 upgrade 挂起 → 客户端握手超时
  server.onConnect.push((ws) => {
    server.send(ws, { type: "tick", data: 9 });
    ws.close(1000);
  });
  await server.listen();
  const client = makeClient(server, { handshakeTimeoutMs: 200 });
  const events: GameEvent[] = [];
  for await (const event of client.events()) {
    events.push(event);
  }
  assert.deepEqual(events[0], { tick: 9 }); // 超时 → 重连 → 成功
  await server.close();
});

test("握手期间 close() → 迭代立即结束", async () => {
  const server = new MockGameServer();
  await server.listen();
  const client = makeClient(server, { handshakeTimeoutMs: 5000 });
  const iterator = client.events();
  const pending = iterator.next(); // 在握手挂起时启动
  client.close(); // 应中断进行中的握手
  const result = await pending;
  assert.equal(result.done, true);
  await server.close();
});

// ---------- submit ----------

test("submit 202 → Accepted", async () => {
  const server = await setup();
  server.submitResponses.push(undefined);
  const client = makeClient(server);
  const accepted = await client.submit({ tick: 1, unit_actions: {}, core_action: null });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.tick, 1);
  assert.equal(accepted.source, "AGENT");
  await server.close();
});

test("submit 400 → APIError（不重试）", async () => {
  const server = await setup();
  server.submitResponses.push([400, { error: "BAD_PLAN", message: "invalid" }]);
  const client = makeClient(server);
  await assert.rejects(
    () => client.submit({ tick: 1, unit_actions: {}, core_action: null }),
    (err: unknown) => err instanceof APIError && err.statusCode === 400 && err.error === "BAD_PLAN",
  );
  assert.equal(server.submitCount, 1); // 400 不重试
  await server.close();
});

test("submit 409 → APIError 409", async () => {
  const server = await setup();
  server.submitResponses.push([409, { error: "TICK_MISMATCH" }]);
  const client = makeClient(server);
  await assert.rejects(
    () => client.submit({ tick: 1, unit_actions: {}, core_action: null }),
    (err: unknown) => err instanceof APIError && err.statusCode === 409,
  );
  await server.close();
});

test("submit 503 一次 → 重试后 202；幂等键保持一致", async () => {
  const server = await setup();
  server.submitResponses.push([503, {}]);
  server.submitResponses.push(undefined);
  const client = makeClient(server);
  const accepted = await client.submit({ tick: 5, unit_actions: {}, core_action: null }, { idempotencyKey: "fixed-key-12345678" });
  assert.equal(accepted.tick, 5);
  assert.equal(server.submitCount, 2);
  assert.deepEqual(server.idempotencyKeys, ["fixed-key-12345678", "fixed-key-12345678"]);
  await server.close();
});

test("submit 503 三次 → TransportError", async () => {
  const server = await setup();
  server.submitResponses.push([503, {}], [503, {}], [503, {}]);
  const client = makeClient(server, { requestRetries: 2 });
  await assert.rejects(
    () => client.submit({ tick: 1, unit_actions: {}, core_action: null }),
    TransportError,
  );
  assert.equal(server.submitCount, 3);
  await server.close();
});

test("submit 网络错误（连接拒绝）→ TransportError", async () => {
  const server = await setup();
  await new Promise<void>((resolve) => server.http.close(() => resolve()));
  const client = makeClient(server);
  await assert.rejects(
    () => client.submit({ tick: 1, unit_actions: {}, core_action: null }),
    TransportError,
  );
});

test("submit 无幂等键 → 自动生成 arena-<tick>-hex", async () => {
  const server = await setup();
  server.submitResponses.push(undefined);
  const client = makeClient(server);
  await client.submit({ tick: 42, unit_actions: {}, core_action: null });
  assert.match(server.idempotencyKeys[0], /^arena-42-[0-9a-f]{32}$/);
  await server.close();
});

// ---------- 生命周期/收尾 ----------

test("双迭代器 → ConfigurationError", async () => {
  const server = await setup((ws) => {
    server.send(ws, { type: "tick", data: 1 });
  });
  const client = makeClient(server);
  const first = client.events();
  await first.next(); // 第一个迭代器已活跃（产出 tick）
  // 第二个 events() 的生成器函数体在 next() 时才执行 → rejected promise
  await assert.rejects(client.events().next(), ConfigurationError);
  client.close();
  await server.close();
});

test("receipts：tick 变化时清空", async () => {
  const server = await setup((ws) => {
    server.send(ws, { type: "tick", data: 1 });
    server.send(ws, {
      type: "received",
      data: { tick: 1, source: "AGENT", received_at: "2026-08-02T12:00:00Z", plan: { tick: 1, unit_actions: {}, core_action: null } },
    });
    server.send(ws, { type: "tick", data: 2 });
    ws.close(1000);
  });
  const client = makeClient(server);
  for await (const _ of client.events()) {
    // 消费全部
  }
  // tick 2 后 receipts 已清空（tick1 的 receipt 属于过期 tick）
  assert.deepEqual(client.latestReceipts, {});
  await server.close();
});

test("close() 后提交被拒", async () => {
  const server = await setup();
  const client = makeClient(server);
  client.close();
  await assert.rejects(() => client.submit({ tick: 1, unit_actions: {}, core_action: null }), ConfigurationError);
  await server.close();
});

test("late accepted 验证：source 非法 → ProtocolError（parseAccepted 硬化）", () => {
  assert.throws(
    () => parseAccepted(new TextEncoder().encode('{"accepted":true,"tick":1,"source":"HACKER","received_at":"x"}')),
    ProtocolError,
  );
});
