/**
 * 模拟器平台化测试（2026-08-08）：
 *  - 对手注册中心：内置名 / http:// 前缀 / 未知名解析；
 *  - survey 场景：窗口选择、坐标系平移、对手 id 参数化；
 *  - HttpBridge：本地 HTTP 服务端到端往返（worker + Atomics 同步帧）、
 *    错误路径（非 200 / 连接拒绝）fail-fast。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { resolveOpponent, opponentEntry } from "../src/sim/opponent/registry.ts";
import { HttpBridge } from "../src/sim/opponent/http-decider.ts";
import { makeArenaScenarioN, makeSafetyEntry, runFreeForAll } from "../src/sim/opponent/tournament.ts";
import {
  inWindow,
  makeSurveyScenario,
  pickWindow,
  WINDOW_SIZE,
  type SurveyResource,
} from "../src/sim/opponent/survey-scenario.ts";

// ---------- 注册中心 ----------

test("registry: 内置名解析 farmer/core", () => {
  const farmer = resolveOpponent("farmer");
  assert.equal(farmer.kind, "reference-python");
  assert.equal(farmer.pythonAgent, "farmer");
  const core = resolveOpponent("core");
  assert.equal(core.kind, "reference-python");
  assert.equal(core.pythonAgent, "core");
});

test("registry: http:// 前缀 → HTTP spec，端点透传", () => {
  const spec = resolveOpponent("http://127.0.0.1:9000/decide");
  assert.equal(spec.kind, "http");
  assert.equal(spec.endpoint, "http://127.0.0.1:9000/decide");
});

test("registry: 未知对手名报错并列出可用项", () => {
  assert.throws(() => resolveOpponent("nope"), /unknown opponent nope.*farmer, core/);
});

test("registry: opponentEntry 的 id 约定 name-s<seed>", () => {
  const http = opponentEntry(resolveOpponent("http://127.0.0.1:1/decide"), 3);
  assert.equal(http.id, "http://127.0.0.1:1/decide-s3");
  const farmer = opponentEntry(resolveOpponent("farmer"), 7);
  assert.equal(farmer.id, "farmer-s7");
});

// ---------- survey 场景纯函数 ----------

const sampleResources: readonly SurveyResource[] = [
  { x: 10, y: 10, lastSeenTick: 100, state: "visible" },
  { x: 12, y: 11, lastSeenTick: 101, state: "visible" },
  { x: 11, y: 14, lastSeenTick: 102, state: "visible" },
  { x: 200, y: 200, lastSeenTick: 103, state: "visible" }, // 远点（孤立）
];

test("survey-scenario: pickWindow 选矿最密窗口（锚点扫描，孤立点不干扰）", () => {
  const window = pickWindow(sampleResources);
  // 三个近邻矿应落在窗口内；孤立点 200,200 被排除
  assert.ok(inWindow(window.x0, window.y0, 10, 10));
  assert.ok(inWindow(window.x0, window.y0, 12, 11));
  assert.ok(inWindow(window.x0, window.y0, 11, 14));
  assert.ok(!inWindow(window.x0, window.y0, 200, 200));
});

test("survey-scenario: makeSurveyScenario 平移坐标 + 对手 id 参数化（M4-2/3/5 官方语义）", () => {
  const window = pickWindow(sampleResources);
  // M4-5：窗外 30 格重生环边距由场景构造器内部过滤——传入全量切片
  const scenario = makeSurveyScenario(window, sampleResources, [], 5, "farmer-s5") as {
    players: Array<{ id: string; resources: number; core: { position: [number, number] }; units: Array<{ id: string }> }>;
    terrain: { resources: Array<[number, number]>; obstacles: Array<[number, number]> };
    beacon: { position: [number, number] };
  };
  assert.deepEqual(scenario.players.map((p) => p.id), ["mine", "farmer-s5"]);
  const mineCore = scenario.players[0].core.position;
  const farmerCore = scenario.players[1].core.position;
  assert.equal(mineCore[0], 2);
  assert.equal(farmerCore[0], WINDOW_SIZE - 3);
  // 所有矿平移后都应在窗口内（近邻矿均落在窗口内）
  for (const [x, y] of scenario.terrain.resources) {
    assert.ok(x >= 0 && x < WINDOW_SIZE && y >= 0 && y < WINDOW_SIZE);
  }
  // M4-2：beacon 平移窗口中心（距两核 28/27 > 视野 5），且在窗口内
  const [bx, by] = scenario.beacon.position;
  assert.deepEqual(scenario.beacon.position, [WINDOW_SIZE / 2, WINDOW_SIZE / 2], "M4-2：beacon 窗口中心");
  assert.ok(bx >= 0 && bx < WINDOW_SIZE && by >= 0 && by < WINDOW_SIZE, "beacon 在窗口内");
  // M4-3：起点 5 资源 + 1 worker（官方 startingResources/startingWorkerCount）
  for (const p of scenario.players) {
    assert.equal((p as { resources: number }).resources, 5, "M4-3：起点 5 资源");
    assert.equal(p.units.length, 1, "M4-3：起点 1 worker");
  }
});

test("survey-scenario: M4-5 窗口外扩 30 格——重生环边距内障碍/资源进入场景", () => {
  // 窗口外 15 格（重生环 20-30 带内）的障碍与资源应被纳入场景地形
  const window = pickWindow(sampleResources);
  const marginResource = { x: window.x0 - 15, y: window.y0, lastSeenTick: 100, state: "visible" as const };
  const marginObstacle = { x: window.x0 + WINDOW_SIZE + 15, y: window.y0 };
  const scenario = makeSurveyScenario(window, [marginResource], [marginObstacle], 1, "farmer-s1") as {
    terrain: { resources: Array<[number, number]>; obstacles: Array<[number, number]> };
  };
  assert.deepEqual(scenario.terrain.resources, [[-15, 0]], "窗外 15 格（边距内）资源进入场景");
  assert.deepEqual(scenario.terrain.obstacles, [[WINDOW_SIZE + 15, 0]], "窗外 15 格（边距内）障碍进入场景");
  // 超出边距的孤立远点（sampleResources 的 200,200）不进入场景
  const farScenario = makeSurveyScenario(window, sampleResources, [], 1, "farmer-s1") as {
    terrain: { resources: Array<[number, number]> };
  };
  assert.ok(!farScenario.terrain.resources.some(([x]) => x > WINDOW_SIZE), "窗外 30 格外不进入场景");
});

// ---------- HttpBridge 端到端 ----------

/**
 * 测试服务器必须跑在独立 worker 线程：HttpBridge.exchange 同步阻塞主线程
 * （Atomics.wait），若服务器与 exchange 同进程，主线程被阻塞 → 服务器无法
 * 处理请求 → 死锁超时。worker 内服务器模拟真实"外部服务"（跨线程语义）。
 */
function startDecideServerInWorker(options: { fail500?: boolean } = {}): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const script = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { createServer } = require("node:http");
    const fail500 = workerData.fail500;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (fail500) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("boom");
          return;
        }
        const reply = JSON.stringify({ tick: body.tick, unit_actions: {}, core_action: { type: "SPAWN", unit_type: "WORKER" } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(reply);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      parentPort.postMessage({ ready: true, port: server.address().port });
    });
    parentPort.on("message", (msg) => {
      if (msg === "close") { server.close(); parentPort.close(); }
    });
  `;
  return new Promise((resolveStart) => {
    const worker = new Worker(script, { eval: true, workerData: { fail500: options.fail500 ?? false } });
    worker.once("message", (msg: { ready: boolean; port: number }) => {
      resolveStart({
        port: msg.port,
        stop: () =>
          new Promise<void>((resolveStop) => {
            worker.once("exit", () => resolveStop());
            worker.postMessage("close");
          }),
      });
    });
  });
}

test("http-bridge: 本地服务端到端往返（官方 CommandPlan 信封）", async () => {
  const { port, stop } = await startDecideServerInWorker();
  const bridge = new HttpBridge(`http://127.0.0.1:${port}/decide`, 5000);
  try {
    const reply = bridge.exchange(JSON.stringify({ tick: 42, state: {} }));
    const plan = JSON.parse(reply) as { tick: number; core_action: { unit_type: string } };
    assert.equal(plan.tick, 42);
    assert.equal(plan.core_action.unit_type, "WORKER");
  } finally {
    bridge.close();
    await stop();
  }
});

test("http-bridge: 非 200 响应 fail-fast（错误透传）", async () => {
  const { port, stop } = await startDecideServerInWorker({ fail500: true });
  const bridge = new HttpBridge(`http://127.0.0.1:${port}/decide`, 5000);
  try {
    assert.throws(() => bridge.exchange(JSON.stringify({ tick: 1, state: {} })), /500/);
  } finally {
    bridge.close();
    await stop();
  }
});

test("http-bridge: 连接拒绝 fail-fast（服务不可达）", async () => {
  // 127.0.0.1:1 通常无监听（无需真实服务即可验证错误路径）
  const bridge = new HttpBridge("http://127.0.0.1:1/decide", 3000);
  try {
    assert.throws(() => bridge.exchange(JSON.stringify({ tick: 1, state: {} })), /request failed|ECONNREFUSED|fetch failed/);
  } finally {
    bridge.close();
  }
});

// ---------- 多玩家混战（runFreeForAll） ----------

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

test("ffa: makeArenaScenarioN 三方圆周布局——核心/worker/资源唯一且不重叠", () => {
  const entries = ["mine", "farmer-s1", "core-s1"].map((id) => makeSafetyEntry(id));
  const scenario = makeArenaScenarioN(entries, 7) as {
    players: Array<{ id: string; resources: number; core: { position: [number, number]; id: string }; units: Array<{ id: string }> }>;
    terrain: { resources: Array<[number, number]>; obstacles: Array<[number, number]> };
    beacon: { position: [number, number] };
  };
  assert.equal(scenario.players.length, 3);
  const corePositions = scenario.players.map((p) => p.core.position.join(","));
  assert.equal(new Set(corePositions).size, 3, "核心位置必须唯一");
  const coreIds = scenario.players.map((p) => p.core.id);
  assert.equal(new Set(coreIds).size, 3, "核心 id 必须唯一");
  const workerIds = scenario.players.flatMap((p) => p.units.map((u) => u.id));
  assert.equal(new Set(workerIds).size, 3, "3 个 worker id 必须唯一（M4-3：起点 1 worker/家）");
  assert.equal(scenario.terrain.resources.length, 12, "3 核 × 4 近距资源");
  // M4-2：混战信标归位圆周圆心 [0,0]（所有核心距圆心 18 > 视野 5）
  assert.deepEqual(scenario.beacon.position, [0, 0], "M4-2：beacon 归位圆周圆心");
  // M4-3：起点 5 资源（官方 startingResources）
  for (const p of scenario.players) {
    assert.equal((p as { resources: number }).resources, 5, "M4-3：起点 5 资源");
  }
  // M4-4：seed 派生障碍集——8 格 4 块，|x|+|y| ≤ 10，不压信标/资源盘/核心，
  // 距任一核心 Manhattan > 3（核心周围 3 格无阻碍）
  const obstacleCells = scenario.terrain.obstacles;
  assert.equal(obstacleCells.length, 8, "M4-4：障碍 4 块 × 2 格");
  for (const [ox, oy] of obstacleCells) {
    assert.ok(Math.abs(ox) + Math.abs(oy) >= 4, "不压信标 [0,0]（距圆心 ≥ 4）");
    assert.ok(Math.abs(ox) + Math.abs(oy) <= 10, "障碍在圆心附近（|x|+|y| ≤ 10）");
    for (const [cx, cy] of corePositions.map((position) => position.split(",").map(Number) as [number, number])) {
      assert.ok(Math.abs(ox - cx) + Math.abs(oy - cy) > 3, "核心周围 3 格无阻碍");
    }
    for (const [rx, ry] of scenario.terrain.resources) {
      assert.ok(!(ox === rx && oy === ry), "障碍不与资源盘格重叠");
    }
  }
  // 每核资源盘在自己 ±7 内（无跨核漂移）
  for (let i = 0; i < 3; i += 1) {
    const [cx, cy] = scenario.players[i].core.position;
    for (const [x, y] of scenario.terrain.resources.slice(i * 4, i * 4 + 4)) {
      assert.ok(Math.abs(x - cx) <= 7 && Math.abs(y - cy) <= 7);
    }
  }
});

test("ffa: 三方纯 TS 混战完整跑完（多计划同场结算）", () => {
  const entries = ["mine", "p2", "p3"].map((id) => makeSafetyEntry(id));
  const result = runFreeForAll(entries, 3, 40, MANIFEST_PATH, { validatePlans: false, refillEveryTicks: null });
  assert.equal(result.players.length, 3);
  assert.equal(result.tickCount, 40);
  assert.ok(result.eventCount > 0);
  // 胜者要么是参与者之一，要么平局（全活资源/人口并列）
  if (result.winner !== null) {
    assert.ok(result.players.includes(result.winner));
  }
  // 三家核心状态与最终资源都记录
  for (const id of ["mine", "p2", "p3"]) {
    assert.ok(id in result.coreAlive);
    assert.ok(id in result.finalResources);
    assert.ok(id in result.finalPopulation);
  }
});

test("ffa: 四方混战（4 玩家）同样完整跑完", () => {
  const entries = ["mine", "p2", "p3", "p4"].map((id) => makeSafetyEntry(id));
  const result = runFreeForAll(entries, 5, 30, MANIFEST_PATH, { validatePlans: false, refillEveryTicks: null });
  assert.equal(result.players.length, 4);
  assert.equal(Object.keys(result.coreAlive).length, 4);
});

test("ffa: 五方混战（5 玩家）核心/worker id 全图唯一（防静默覆盖回归）", () => {
  const entries = ["mine", "p2", "p3", "p4", "p5"].map((id) => makeSafetyEntry(id));
  const scenario = makeArenaScenarioN(entries, 7) as {
    players: readonly {
      readonly core: { readonly id: string };
      readonly units: readonly { readonly id: string }[];
    }[];
  };
  const allCoreIds = scenario.players.map((p) => p.core.id);
  const allWorkerIds = scenario.players.flatMap((p) => p.units.map((u) => u.id));
  assert.equal(new Set(allCoreIds).size, 5, "5 家 core id 必须唯一");
  assert.equal(new Set(allWorkerIds).size, 5, "5 个 worker id 必须唯一（M4-3：起点 1 worker/家）");
  const result = runFreeForAll(entries, 7, 30, MANIFEST_PATH, { validatePlans: false, refillEveryTicks: null });
  assert.equal(Object.keys(result.coreAlive).length, 5);
});
