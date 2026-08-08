/**
 * W31/W32 工程修复测试（2026-08-09）：
 *  - W31：ARENA_DATA_ROOT 解析——缺省 fail-fast（纯函数 + 子进程双验证）、设置后正确解析
 *  - W32：cancel 租户隔离——intent 精确移除、PID 白名单枚举/杀进程、跨租户互不干扰
 *
 * 杀进程部分无法在测试里真实执行（会杀真进程），故测其可抽出的部分：
 *  - listTenantDriverPids：白名单枚举（租户过滤 + 非法登记文件排除）
 *  - killTenantDrivers：对"必然已死"的 pid 只跳过不误杀，且清理登记文件
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CTL_SCRIPT = join(HERE, "..", "scripts", "arena-ctl.mts");
const DRIVER_SCRIPT = join(HERE, "..", "scripts", "core-migrate-driver.mts");

// arena-ctl 的模块级 DATA_ROOT 在导入时解析：先用临时目录设好 env，再动态导入
const fixture = mkdtempSync(join(tmpdir(), "arena-ctl-safety-"));
process.env.ARENA_DATA_ROOT = fixture;
const ctl = await import("../scripts/arena-ctl.mts");

after(() => {
  rmSync(fixture, { recursive: true, force: true });
});

/* ---------- 测试辅助 ---------- */

type StoreEntry = { id: string; [k: string]: unknown };

interface StoreShape {
  version: number;
  mode: string;
  commands: StoreEntry[];
  goals: StoreEntry[];
  updatedAt: string;
}

function makeStore(commands: StoreEntry[], goals: StoreEntry[] = []): StoreShape {
  return { version: 1, mode: "override", commands, goals, updatedAt: "2026-08-09T00:00:00.000Z" };
}

function humanCommandsDir(): string {
  const dir = join(fixture, "runtime", "human-commands");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readStore(tenant: string): { commands: StoreEntry[]; goals: StoreEntry[] } {
  return JSON.parse(readFileSync(join(humanCommandsDir(), `${tenant}.json`), "utf-8")) as {
    commands: StoreEntry[];
    goals: StoreEntry[];
  };
}

function spawnWithoutDataRoot(args: readonly string[]): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env.ARENA_DATA_ROOT;
  const r = spawnSync(process.execPath, [...args], { encoding: "utf-8", env, timeout: 30000 });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/* ---------- W31 · 数据根解析 ---------- */

test("W31: resolveDataRoot 缺省/空白 env → 抛错（fail-fast，不静默回退）", () => {
  assert.throws(() => ctl.resolveDataRoot({}), /ARENA_DATA_ROOT/);
  assert.throws(() => ctl.resolveDataRoot({ ARENA_DATA_ROOT: "   " }), /ARENA_DATA_ROOT/);
  assert.throws(() => ctl.resolveDataRoot({ ARENA_DATA_ROOT: "" }), /ARENA_DATA_ROOT/);
});

test("W31: resolveDataRoot 显式设置 → 返回 trim 后的路径", () => {
  assert.equal(ctl.resolveDataRoot({ ARENA_DATA_ROOT: "D:/tmp/arena-data" }), "D:/tmp/arena-data");
  assert.equal(ctl.resolveDataRoot({ ARENA_DATA_ROOT: "  D:/tmp/arena-data  " }), "D:/tmp/arena-data");
});

test("W31: 无 ARENA_DATA_ROOT 时 arena-ctl 模块导入即 fail-fast 报错退出", () => {
  const r = spawnWithoutDataRoot(["--input-type=module", "-e", "await import(process.argv[1])", pathToFileURL(CTL_SCRIPT).href]);
  assert.notEqual(r.status, 0, `期望非零退出，实际 ${r.status}: ${r.output}`);
  assert.match(r.output, /ARENA_DATA_ROOT/);
});

test("W31: 无 ARENA_DATA_ROOT 且无 --data-root 时 driver 启动即报错退出", () => {
  const r = spawnWithoutDataRoot([DRIVER_SCRIPT, "--tenant=t9", "--max-steps=0"]);
  assert.notEqual(r.status, 0, `期望非零退出，实际 ${r.status}: ${r.output}`);
  assert.match(r.output, /ARENA_DATA_ROOT/);
});

test("W31: 设置 ARENA_DATA_ROOT 后 driver 正确解析并干净退出（临时数据根）", () => {
  const hc = humanCommandsDir();
  // 预置一条命令：driver 收尾 clearCommand 应清空（证明它读写的是 env 指定的数据根）
  writeFileSync(join(hc, "t1.json"), JSON.stringify(makeStore([{ id: "cmd-migrate-1", unitId: "core-1", action: { type: "START_MOVE", direction: "LEFT" } }])));
  const env = { ...process.env, ARENA_DATA_ROOT: fixture };
  const r = spawnSync(
    process.execPath,
    [DRIVER_SCRIPT, "--tenant=t1", "--target-x=300", "--target-y=-150", "--max-steps=0", "--interval-ms=1"],
    { encoding: "utf-8", env, timeout: 30000 },
  );
  assert.equal(r.status, 0, `driver 应干净退出: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  const store = readStore("t1");
  assert.deepEqual(store.commands, []);
  assert.deepEqual(store.goals, []);
  // PID 登记文件在正常退出时已注销
  const driversDir = join(fixture, "runtime", "drivers");
  const leftover = existsSync(driversDir)
    ? readdirSync(driversDir).filter((f) => f.startsWith("t1."))
    : [];
  assert.deepEqual(leftover, []);
});

/* ---------- W32 · cancel 租户隔离（纯逻辑） ---------- */

test("W32: filterHumanStore 无 intentId → 全清（commands + goals）", () => {
  const { next, removed } = ctl.filterHumanStore(makeStore([{ id: "c1" }, { id: "c2" }], [{ id: "g1" }]), undefined);
  assert.deepEqual(next.commands, []);
  assert.deepEqual(next.goals, []);
  assert.deepEqual(removed, ["c1", "c2", "g1"]);
});

test("W32: filterHumanStore 指定 intentId → 只移除该条，其余保留", () => {
  const { next, removed } = ctl.filterHumanStore(makeStore([{ id: "c1" }, { id: "c2" }], [{ id: "g1" }]), "c2");
  assert.deepEqual(next.commands.map((c) => c.id), ["c1"]);
  assert.deepEqual(next.goals.map((g) => g.id), ["g1"]);
  assert.deepEqual(removed, ["c2"]);
});

test("W32: filterHumanStore intentId 未命中 → 不移除任何条目", () => {
  const { next, removed } = ctl.filterHumanStore(makeStore([{ id: "c1" }]), "no-such-id");
  assert.equal(removed.length, 0);
  assert.deepEqual(next.commands.map((c) => c.id), ["c1"]);
});

test("W32: clearHumanStore 只清指定租户文件，跨租户文件不受影响", () => {
  const hc = humanCommandsDir();
  writeFileSync(join(hc, "t1.json"), JSON.stringify(makeStore([{ id: "c1" }, { id: "c2" }], [{ id: "g1" }])));
  writeFileSync(join(hc, "t2.json"), JSON.stringify(makeStore([{ id: "c3" }])));
  const res = ctl.clearHumanStore("t1");
  assert.deepEqual([...res.removed].sort(), ["c1", "c2", "g1"]);
  const t1 = readStore("t1");
  assert.deepEqual(t1.commands, []);
  assert.deepEqual(t1.goals, []);
  const t2 = readStore("t2");
  assert.deepEqual(t2.commands, [{ id: "c3" }]);
  assert.deepEqual(t2.goals, []);
});

test("W32: clearHumanStore 指定 intentId → 精确移除该条，其余保留", () => {
  const hc = humanCommandsDir();
  writeFileSync(join(hc, "t4.json"), JSON.stringify(makeStore([{ id: "c1" }, { id: "c2" }], [{ id: "g1" }])));
  const res = ctl.clearHumanStore("t4", "c1");
  assert.deepEqual(res.removed, ["c1"]);
  const t4 = readStore("t4");
  assert.deepEqual(t4.commands.map((c) => c.id), ["c2"]);
  assert.deepEqual(t4.goals.map((g) => g.id), ["g1"]);
});

/* ---------- W32 · 杀进程 PID 白名单 ---------- */

test("W32: listTenantDriverPids 只枚举本租户合法登记文件，跨租户/非法文件排除", () => {
  const driversDir = join(fixture, "runtime", "drivers");
  mkdirSync(driversDir, { recursive: true });
  const write = (name: string, content: Record<string, unknown>) => writeFileSync(join(driversDir, name), JSON.stringify(content));
  try {
    write("t1.1111.json", { tenant: "t1", pid: 1111, startedAt: "2026-08-09T00:00:00.000Z" });
    write("t1.2222.json", { tenant: "t1", pid: 2222, startedAt: "2026-08-09T00:00:00.000Z" });
    write("t2.3333.json", { tenant: "t2", pid: 3333, startedAt: "2026-08-09T00:00:00.000Z" });
    write("t1.notpid.json", { tenant: "t1", startedAt: "x" }); // 文件名不合法（pid 非数字）
    write("t1.4444.json", { tenant: "t1", pid: "4444", startedAt: "x" }); // pid 字段非数字 → 跳过
    write("t1.5555.json", { tenant: "t2", pid: 5555, startedAt: "x" }); // 文件内 tenant 与文件名不一致 → 仍按文件名租户归入
    const t1 = ctl.listTenantDriverPids(fixture, "t1");
    assert.deepEqual(t1.map((r) => r.pid).sort(), [1111, 2222, 5555]);
    const t2 = ctl.listTenantDriverPids(fixture, "t2");
    assert.deepEqual(t2.map((r) => r.pid), [3333]);
  } finally {
    rmSync(driversDir, { recursive: true, force: true });
  }
});

test("W32: killTenantDrivers 无登记文件 → 零操作（不触发任何杀进程）", () => {
  assert.deepEqual(ctl.killTenantDrivers(join(fixture, "no-such-drivers-dir"), "t1"), { killed: [], skipped: [] });
});

test("W32: killTenantDrivers 对已死 pid 只跳过不误杀，并清理登记文件", () => {
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf-8" }).pid;
  assert.ok(typeof deadPid === "number" && deadPid > 0, "应拿到已退出子进程的 pid");
  const driversDir = join(fixture, "runtime", "drivers");
  mkdirSync(driversDir, { recursive: true });
  const record = join(driversDir, `t1.${deadPid}.json`);
  writeFileSync(record, JSON.stringify({ tenant: "t1", pid: deadPid, startedAt: "2026-08-09T00:00:00.000Z" }));
  const result = ctl.killTenantDrivers(fixture, "t1");
  assert.deepEqual(result.killed, [], "白名单内但已死的进程必须跳过，不得误杀");
  assert.deepEqual(result.skipped, [deadPid]);
  assert.equal(existsSync(record), false, "处理完的登记文件应被清理");
});

test("W32: cmdCancel 端到端——只清本租户文件、审计落盘、JSON 输出", () => {
  const hc = humanCommandsDir();
  writeFileSync(join(hc, "t1.json"), JSON.stringify(makeStore([{ id: "c1" }, { id: "c2" }])));
  writeFileSync(join(hc, "t3.json"), JSON.stringify(makeStore([{ id: "c3" }])));
  const orig = console.log;
  let output = "";
  console.log = (msg: string): void => { output = msg; };
  try {
    ctl.cmdCancel("t1", "c2");
  } finally {
    console.log = orig;
  }
  const t1 = readStore("t1");
  assert.deepEqual(t1.commands.map((c) => c.id), ["c1"], "t1 只应移除 intent c2");
  const t3 = readStore("t3");
  assert.deepEqual(t3.commands.map((c) => c.id), ["c3"], "跨租户 t3 不受影响");
  const parsed = JSON.parse(output) as { ok: boolean; removed: string[]; killed: number[]; skipped: number[] };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.removed, ["c2"]);
  assert.deepEqual(parsed.killed, []);
  const audit = readFileSync(join(fixture, "runtime", "command-audit", "t1.jsonl"), "utf-8").trim().split("\n");
  assert.ok(audit.some((l) => l.includes('"cancelled"') && l.includes('"c2"')));
});
