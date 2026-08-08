/**
 * http-bridge worker（CommonJS）——HTTP 外部决策器传输层。
 * 与 sync-bridge-worker 同构：worker 持异步 fetch，主线程经 SharedArrayBuffer
 * 帧槽 + Atomics 同步 RPC。协议：POST {tick, state} → 响应体为 CommandPlan JSON。
 * 帧布局与 sync-bridge.ts 一致（flags 区 [0..8) + 数据区 [8..)）。
 *
 * 代理防御（2026-08-08 实测）：本机有 HTTP_PROXY 环境变量时 undici 可能把
 * 127.0.0.1 请求也路由到代理导致挂起——worker 启动即清除代理变量（仅影响
 * 本 worker 的 env 拷贝，不影响父进程），本地决策端点必须直连。
 */
"use strict";

const { parentPort, workerData } = require("node:worker_threads");

delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.ALL_PROXY;
delete process.env.all_proxy;

const FLAG_IDLE = 0;
const FLAG_BUSY = 1;
const FLAG_RESPONSE = 2;
const FLAG_ERROR = 3;
const FLAG_CLOSE = 4;

const DECISION_TIMEOUT_MS = 10_000;

const { buffer, endpoint, timeoutMs } = workerData;
const flags = new Int32Array(buffer, 0, 2);
const frame = new Uint8Array(buffer, 8);

function fail(message) {
  if (Atomics.load(flags, 0) === FLAG_ERROR) return;
  const bytes = Buffer.from(message, "utf8");
  Atomics.store(flags, 1, bytes.length);
  frame.set(bytes, 0);
  Atomics.store(flags, 0, FLAG_ERROR);
  Atomics.notify(flags, 0);
}

async function decide(requestJson) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DECISION_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestJson,
      signal: controller.signal,
    });
    if (!response.ok) {
      fail(`http decider: endpoint ${endpoint} returned ${response.status}`);
      return;
    }
    const text = await response.text();
    if (text.trim() === "") {
      fail(`http decider: empty response from ${endpoint}`);
      return;
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > frame.length) {
      fail(`http decider: response too large (${bytes.length} bytes)`);
      return;
    }
    Atomics.store(flags, 1, bytes.length);
    frame.set(bytes, 0);
    Atomics.store(flags, 0, FLAG_RESPONSE);
    Atomics.notify(flags, 0);
  } catch (error) {
    fail(`http decider: request failed (${String(error)})`);
  } finally {
    clearTimeout(timer);
  }
}

parentPort.on("message", (request) => {
  if (request === "close") {
    Atomics.store(flags, 0, FLAG_CLOSE);
    Atomics.notify(flags, 0);
    parentPort.close();
    return;
  }
  void decide(request);
});

Atomics.store(flags, 0, FLAG_IDLE);
Atomics.notify(flags, 0);
