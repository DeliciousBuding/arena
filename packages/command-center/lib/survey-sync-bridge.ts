/**
 * 测绘同步惰性桥（2026-08-08，数据记录层保鲜）：无计划任务/定时任务——
 * 面板在 /api/health/pipeline 请求路径检测 survey-db 滞后 > 阈值时，后台
 * spawn 一次 `survey:sync --latest-only` 增量同步，把四租户测绘水位追到
 * 最新 calibration（实测 lag 184→1 tick）。
 *
 * 单一 writer 纪律保持：本桥只负责"触发"，写库仍由 survey-sync CLI 完成
 * （SAVEPOINT 幂等 + sync_meta 水位）；与 scripts/survey-sync-guard.py 共用
 * sync-guard.lock 单实例锁（fresh 锁不抢，stale 锁可抢），避免并发双写。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";

/** 滞后触发阈值（tick）：> 60 ≈ 1 分钟数据滞后即补同步。 */
const LAG_TRIGGER_TICKS = 60;
/** 两次同步最小间隔：防抖，避免高频请求反复触发。 */
const MIN_INTERVAL_MS = 60_000;
/** 锁文件新鲜窗口：超过视为死锁（进程崩溃残留），可抢。 */
const LOCK_STALE_MS = 5 * 60_000;
/** 同步子进程超时（秒）：正常 --latest-only 秒级，超时杀防悬挂。 */
const SPAWN_TIMEOUT_MS = 120_000;

const HERE = dirname(fileURLToPath(import.meta.url));
/** arena-agent 包路径（survey-sync CLI 所在）。缺包时跳过（迁移/异常态不阻塞面板）。 */
const AGENT_PKG = join(HERE, "..", "..", "arena-agent");
const SYNC_CLI = join(AGENT_PKG, "scripts", "run-survey-sync.mts");
const LOCK_FILE = join(DATA_ROOT, "runtime", "survey", "sync-guard.lock");
const LOG_FILE = join(DATA_ROOT, "runtime", "survey", "sync-guard.log");

interface SyncBridgeState {
  lastAttemptAt: number;
  running: boolean;
  lastResult: string | null;
  lastSyncAt: number | null;
}
const state: SyncBridgeState = { lastAttemptAt: 0, running: false, lastResult: null, lastSyncAt: null };

function log(msg: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${stamp}] [cc-bridge] ${msg}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    // 与 survey-sync-guard.py 共用日志文件，前缀区分触发方
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* 日志失败不阻塞同步 */ }
}

/** 锁文件是否可抢（不存在 / 超龄）。 */
function lockAvailable(): boolean {
  if (!existsSync(LOCK_FILE)) return true;
  try {
    const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    return age > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function takeLock(): boolean {
  if (!lockAvailable()) return false;
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now(), via: "command-center" }), "utf8");
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch { /* 忽略 */ }
}

/** 惰性触发：滞后超阈值且未在防抖窗口内 → 后台同步一次。返回是否触发。 */
export function maybeTriggerSurveySync(maxLagTicks: number, tenants: readonly string[] = TENANTS): boolean {
  if (maxLagTicks <= LAG_TRIGGER_TICKS) return false;
  const now = Date.now();
  if (state.running || now - state.lastAttemptAt < MIN_INTERVAL_MS) return false;
  if (!existsSync(SYNC_CLI)) {
    state.lastResult = "skip: arena-agent CLI 缺失（迁移/异常态）";
    log(state.lastResult);
    return false;
  }
  state.lastAttemptAt = now;
  if (!takeLock()) {
    state.lastResult = "skip: sync-guard 锁被占用（其他同步方进行中）";
    log(state.lastResult);
    return false;
  }
  state.running = true;
  log(`触发同步（lag=${maxLagTicks} tick > ${LAG_TRIGGER_TICKS}）tenants=${tenants.join(",")}`);
  const child = spawn(process.execPath, [
    SYNC_CLI,
    `--data-root=${DATA_ROOT}`,
    `--tenants=${tenants.join(",")}`,
    "--latest-only",
  ], { cwd: AGENT_PKG, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  let done = false;
  const finish = (ok: boolean, why: string) => {
    if (done) return;
    done = true;
    state.running = false;
    releaseLock();
    state.lastResult = `${ok ? "ok" : "fail"}: ${why}`.slice(0, 300);
    state.lastSyncAt = Date.now();
    log(`同步结束 ${state.lastResult}${out ? ` | ${out.trim().split("\n").slice(-2).join(" ")}` : ""}`);
  };
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  child.on("error", (e) => finish(false, `spawn error: ${e.message}`));
  child.on("close", (code) => finish(code === 0, `exit=${code}`));
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* 已退出 */ }
    finish(false, `timeout ${SPAWN_TIMEOUT_MS}ms`);
  }, SPAWN_TIMEOUT_MS);
  timer.unref();
  return true;
}

/** 桥状态（调试端点用）：最后触发/结果/同步时间。 */
export function surveySyncBridgeState(): { lastAttemptAt: number; running: boolean; lastResult: string | null; lastSyncAt: number | null } {
  return { ...state };
}
