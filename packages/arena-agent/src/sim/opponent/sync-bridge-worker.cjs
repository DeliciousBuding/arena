/**
 * sync-bridge worker（CommonJS——Worker eval 模式按 CJS 编译，不能用 import）。
 * 持有常驻 Python 子进程（异步 readline 管道），与主线程经 SharedArrayBuffer
 * 帧槽 + Atomics 做同步 RPC。
 *
 * 帧布局（与 sync-bridge.ts 对齐，注意区段不重叠！）：
 *  - [0..8)   flags 区：Int32Array 视图（2 个 int32）
 *      flags[0]：状态标志（0=空闲 1=请求中 2=响应就绪 3=错误 4=关闭）
 *      flags[1]：载荷字节长度
 *  - [8..)    数据区：Uint8Array 视图（UTF-8 字节）
 */
"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { TextEncoder } = require("node:util");

const FLAG_IDLE = 0;
const FLAG_BUSY = 1;
const FLAG_RESPONSE = 2;
const FLAG_ERROR = 3;
const FLAG_CLOSE = 4;

const DECISION_TIMEOUT_MS = 10_000;

const { buffer, python, bridgeScript, bridgeArgs } = workerData;
const flags = new Int32Array(buffer, 0, 2);
const frame = new Uint8Array(buffer, 8);
const encoder = new TextEncoder();

const child = spawn(python, [bridgeScript, ...bridgeArgs], {
  stdio: ["pipe", "pipe", "inherit"],
  ...(workerData.env !== undefined ? { env: workerData.env } : {}),
  ...(workerData.cwd !== undefined ? { cwd: workerData.cwd } : {}),
});

// 孤儿进程防护（M2 卫生项）：worker 线程退出（正常结束/被 parentPort.close
// 或 worker.terminate 终止）时 kill 子进程，防常驻 Python 桥变孤儿。
process.on("exit", () => {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
});
parentPort.on("close", () => {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
});

const lines = [];
const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
reader.on("line", (line) => lines.push(line));

function fail(message) {
  if (Atomics.load(flags, 0) === FLAG_ERROR) return;
  // 先写长度/数据，最后原子写状态标志（标志=数据就绪信号，主线程读到标志
  // 时必须保证长度与载荷都已就绪——普通写在先会导致主线程读到中间态）。
  const bytes = encoder.encode(message);
  Atomics.store(flags, 1, bytes.length);
  frame.set(bytes, 0);
  Atomics.store(flags, 0, FLAG_ERROR);
  Atomics.notify(flags, 0);
}

child.on("error", (err) => fail("bridge spawn failed: " + String(err)));
child.on("exit", (code) => fail("bridge exited " + String(code)));

async function waitForResponse() {
  const deadline = Date.now() + DECISION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (lines.length > 0) {
      const line = lines.shift();
      const bytes = encoder.encode(line);
      Atomics.store(flags, 1, bytes.length);
      frame.set(bytes, 0);
      Atomics.store(flags, 0, FLAG_RESPONSE);
      Atomics.notify(flags, 0);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  fail("decision timeout");
  return false;
}

parentPort.on("message", async (request) => {
  if (request === "close") {
    // 优雅退出：发协议内定义的退出哨兵行 → bridge 识别后静默 return（走
    // finally：强制 flush 状态槽 + 遥测 disconnected/剩余事件批量上报），
    // 进程自己干净退出，无需杀进程。
    // （stdin.end() 在本环境 worker 线程里会挂起——不能依赖 EOF。）
    try {
      child.stdin.write("__arena_quit__\n");
    } catch {
      /* 已退出 */
    }
    // 等待窗口：python 退出前 close() 会 join 遥测线程（最多 3s）完成上报；
    // 超时才强杀（进程异常卡死时的兜底）。
    const exitDeadline = Date.now() + 3000;
    while (child.exitCode === null && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
    // 主线程 close() 在 Atomics.wait(FLAG_IDLE, 2000) 上等收尾——必须显式
    // 置回 IDLE 通知它"收尾完成"，否则主线程立即 terminate 本 worker。
    Atomics.store(flags, 0, FLAG_IDLE);
    Atomics.notify(flags, 0);
    parentPort.close();
    return;
  }
  child.stdin.write(request + "\n");
  await waitForResponse();
});

Atomics.store(flags, 0, FLAG_IDLE);
Atomics.notify(flags, 0);
