#!/usr/bin/env node
/**
 * Arena 本地看护（Node 版，2026-08-08 从 bash 迁移）：
 * v6（2026-08-09）：REPO 改相对脚本目录解析（vbs v5 同款语义，mjs 内部不再
 * 硬编码 worktree 路径）+ PowerShell 探测带 30s 超时；错误 worktree 路径
 * 报错退出（v4 MSYS 路径静默失效教训）。
 * 每分钟由计划任务调用一次；检查本地 supervisor /ready；异常则确认旧进程
 * 死透 → 清理死锁 → 重启 live supervisor（t1-t4 全 TS 线；t2/t3/t4 曾于
 * 2026-08-09 切到独立 python 客户端（arena-hero-tactic v2 进化版），
 * 2026-08-10 用户裁决暂回 TS 管，进化版搞稳后再议）。
 *
 * v7（2026-08-10）：单租户崩溃不再整体重启——/ready 503 响应解析 tenants
 * 详情（shouldFullRecover 纯函数），有租户存活 = 部分故障，信任 supervisor
 * 内部 auto-respawn（10 次 + 指数退避）自愈，stall 检测作整体兜底；只有
 * 网络失败/全租户 down 才走整体恢复。
 *
 * 与旧 bash 版（arena-watchdog.sh）的行为契约完全一致，仅把脆弱的面包屑
 * （curl + grep JSON 解析、netstat 端口探测）换成 Node fetch + 结构化解析：
 * - /ready JSON 用 response.json() 解析（旧 grep '"ready":true' 靠首字段
 *   顺序保证正确性，注释里记录过踩坑）；
 * - 8120 监听探测用 PowerShell Get-NetTCPConnection（旧 netstat -ano |
 *   grep ':8120'）；
 * - 进程枚举沿用 arena-pids.ps1（fail-closed：枚举失败 = 保留锁不重启）；
 * - 维护租约（maintenance.lease）、stall 检测（outcome mtime / decision /
 *   economy 三个独立脚本）、优雅关停（POST /shutdown → 8s 宽限 → taskkill
 *   兜底）全部保留。
 *
 * 日志：状态行追加 ~/arena-watchdog.log；supervisor 输出由重启命令重定向到
 * ~/arena-supervisor.log（与旧版一致）。
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** PowerShell 探测命令超时（毫秒）：PowerShell 挂死不能拖死看护——计划任务
 *  静默运行、无可见 console，挂死 = 看护静默失效（同 v4 教训）。 */
const PORT_PROBE_TIMEOUT_MS = 30_000;
const PID_PROBE_TIMEOUT_MS = 30_000;
/** 配置优先级：env(ARENA_WATCHDOG_*) > supervisor.config.json > 内置默认。
 *  config 文件位于 <dataRoot>/runtime/configs/supervisor.config.json（与租户
 *  配置同目录，gitignored；data 未跟踪）。缺失 = 纯内置默认（向后兼容
 *  旧行为零变化）。2026-08-10 配置化：消灭 watchdog/supervisor 双默认漂移
 *  ——SUPERVISOR_ARGS 由配置生成，单一事实源。 */
const DEFAULT_DATA_ROOT = "ARENA_REPO_ROOT/data";
const DEFAULT_PORT = 8120;
const ENV = process.env;

function envNumber(name, fallback) {
  const raw = ENV[name];
  const value = raw === undefined ? undefined : Number(raw);
  return raw === undefined || !Number.isFinite(value) ? fallback : value;
}
function envString(name, fallback) {
  const raw = ENV[name];
  return raw === undefined || raw.length === 0 ? fallback : raw;
}

const BOOT_DATA_ROOT = envString("ARENA_WATCHDOG_DATA_ROOT", DEFAULT_DATA_ROOT);

/** 读配置（缺失/损坏 = null，全部走默认；损坏配置打日志不崩溃）。 */
function loadSupervisorConfig() {
  try {
    const raw = readFileSync(join(BOOT_DATA_ROOT, "runtime", "configs", "supervisor.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
const CONFIG = loadSupervisorConfig();

const DATA_ROOT = envString("ARENA_WATCHDOG_DATA_ROOT", CONFIG?.watchdog?.dataRoot ?? DEFAULT_DATA_ROOT);
const PORT = envNumber("ARENA_WATCHDOG_PORT", CONFIG?.watchdog?.port ?? DEFAULT_PORT);
const RUNTIME_ROOT = join(DATA_ROOT, "runtime");
const READY_URL = `http://127.0.0.1:${PORT}/ready`;
const SHUTDOWN_URL = `http://127.0.0.1:${PORT}/shutdown`;
const RESTART_URL = `http://127.0.0.1:${PORT}/restart`;
const MAINTENANCE_LEASE = join(RUNTIME_ROOT, "maintenance.lease");
const WATCHDOG_LOCK = join(RUNTIME_ROOT, "watchdog.lock");
const TENANTS = CONFIG?.watchdog?.tenants ?? ["t1", "t2", "t3", "t4"];
/** outcome JSONL 超过该秒数未更新 = stall（与旧版一致）。 */
const STALL_MAX_AGE_S = envNumber("ARENA_WATCHDOG_STALL_MAX_AGE_S", CONFIG?.watchdog?.stallMaxAgeS ?? 600);
/** 启动宽限：8120 有监听但 /ready 未 true 时再等该毫秒复查（防慢启动被误杀）。 */
const BOOT_GRACE_MS = envNumber("ARENA_WATCHDOG_BOOT_GRACE_MS", CONFIG?.watchdog?.bootGraceMs ?? 30_000);
/** 优雅关停后等待秒数，仍监听则 taskkill 兜底（与旧版一致）。 */
const GRACEFUL_WAIT_S = envNumber("ARENA_WATCHDOG_GRACEFUL_WAIT_S", CONFIG?.watchdog?.gracefulWaitS ?? 8);
/** 启动宽限：lock 龄低于该秒数 = 租户刚启动尚未产出首个 outcome，不判 stall。
 *  2026-08-10 修复：旧逻辑用"lock 新于 outcome 则恒跳过"，启动即崩的租户
 *  锁恒新于 outcome → 永久盲区；改为 lock 绝对龄宽限。 */
const LOCK_FRESH_S = envNumber("ARENA_WATCHDOG_LOCK_FRESH_S", CONFIG?.watchdog?.lockFreshS ?? 600);
const LOG = envString("ARENA_WATCHDOG_LOG", CONFIG?.watchdog?.logPath ?? join(HOME, "arena-watchdog.log"));
const SUPERVISOR_LOG = envString("ARENA_WATCHDOG_SUPERVISOR_LOG", CONFIG?.watchdog?.supervisorLogPath ?? join(HOME, "arena-supervisor.log"));

/** 由 supervisor 配置段生成 SUPERVISOR_ARGS（单一事实源，2026-08-10）。 */
function buildSupervisorArgs() {
  const sup = CONFIG?.supervisor ?? {};
  const args = [
    `--data-root=${DATA_ROOT}`,
    `--configs=${(sup.configs ?? TENANTS).join(",")}`,
    `--mode=${sup.mode ?? "deterministic"}`,
  ];
  if (sup.live !== false) args.push("--live");
  if (sup.recordCalibration !== false) args.push("--record-calibration");
  const shadow = sup.allianceShadow ?? {};
  if (shadow.enabled !== false) {
    args.push("--record-alliance-shadow", `--alliance-shadow-interval-ticks=${shadow.intervalTicks ?? 3}`);
    const director = shadow.director ?? {};
    if (director.enabled !== false) {
      args.push(
        "--alliance-director-shadow",
        `--alliance-director-period-ticks=${director.periodTicks ?? 4}`,
        `--alliance-director-max-skew-ticks=${director.maxSkewTicks ?? 2}`,
      );
    }
  }
  const respawn = sup.respawn ?? {};
  const respawnLimit = envNumber("ARENA_WATCHDOG_RESPAWN_LIMIT", respawn.limit);
  const respawnDelayMs = envNumber("ARENA_WATCHDOG_RESPAWN_DELAY_MS", respawn.delayMs);
  if (respawnLimit !== undefined) args.push(`--respawn-limit=${respawnLimit}`);
  if (respawnDelayMs !== undefined) args.push(`--respawn-delay-ms=${respawnDelayMs}`);
  args.push(`--port=${PORT}`);
  return args;
}
const SUPERVISOR_ARGS = buildSupervisorArgs();
/** 本机 node（watchdog 自身运行时）——不依赖 npm/pnpm 包装（pnpm 化后
 *  npm run 已不可靠；v4 曾用 npm run arena:supervisor，workspace 布局下
 *  无法解析）。 */
const NODE_EXE = process.execPath;

/** 相对脚本目录解析 worktree 根：arena-watchdog.mjs 与 vbs 同目录部署在
 *  <worktree>/scripts/（vbs v5 相对解析同款语义；晋升部署不跳回旧硬编码
 *  worktree）。解析出的根不存在 = 抛错退出——v4 曾用 MSYS 风格
 *  "/d/Code/..." 路径在 Windows node 下解析成不存在的 "D:\d\..." 而
 *  静默失效（stall 全跳过、lease 不生效、错误 data-root 重启）。 */
export function resolveWorktreeRoot(scriptsDir) {
  const root = resolve(scriptsDir, "..");
  if (!existsSync(root)) {
    throw new Error(`arena worktree not found at ${root} (scripts dir: ${scriptsDir})`);
  }
  return root;
}

let REPO;
try {
  REPO = resolveWorktreeRoot(SCRIPT_DIR);
} catch (error) {
  log(`watchdog fatal: worktree resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** 日志轮转阈值（16MB×4，与 supervisor.jsonl jsonl-writer 同款语义；
 *  2026-08-10：此前无限 append，长跑后历史不可查）。 */
const LOG_MAX_BYTES = 16 * 1024 * 1024;
const LOG_MAX_BACKUPS = 4;

/** 超限时轮转：LOG → LOG.1 → ... → LOG.4（旧日志截断丢弃）。 */
function rotateLog(path) {
  try {
    if (!existsSync(path) || statSync(path).size < LOG_MAX_BYTES) return;
    for (let i = LOG_MAX_BACKUPS; i >= 1; i -= 1) {
      const rotated = `${path}.${i}`;
      if (existsSync(rotated)) rmSync(rotated, { force: true });
    }
    for (let i = LOG_MAX_BACKUPS - 1; i >= 1; i -= 1) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
  } catch {
    // 轮转失败不阻塞看护（下轮重试）
  }
}

/** 文本日志行（历史格式保留；带轮转）。 */
function log(line) {
  rotateLog(LOG);
  appendFileSync(LOG, `${now()} ${line}\n`);
}

/** 结构化事件（JSONL，2026-08-10 增加）：供命令中心/审计工具直接消费。 */
function logEvent(type, fields = {}) {
  rotateLog(LOG);
  appendFileSync(LOG, `${JSON.stringify({ type, ts: new Date().toISOString(), ...fields })}\n`);
}

/** 实例互斥（2026-08-10：恢复流程 60-90s 跨分钟，计划任务实例重叠 → 后
 *  实例把前实例刚拉起的 supervisor 又优雅关停 → 无限重启循环。pid 锁：
 *  已有存活实例 = 直接退出；崩溃残留（pid 不存在）= 接管）。 */
function acquireWatchdogLock() {
  try {
    if (existsSync(WATCHDOG_LOCK)) {
      const pid = Number(readFileSync(WATCHDOG_LOCK, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        let alive = false;
        try {
          const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
            encoding: "utf8", shell: false, timeout: 5000,
          });
          alive = out.includes(`"${pid}"`);
        } catch {
          alive = false;
        }
        if (alive) return false;
      }
    }
    writeFileSync(WATCHDOG_LOCK, String(process.pid));
    return true;
  } catch {
    return true; // 锁不可用不阻塞看护（保守）
  }
}

function releaseWatchdogLock() {
  try {
    rmSync(WATCHDOG_LOCK, { force: true });
  } catch {
    // 清理失败不阻塞（残留由下次 acquire 的 pid 存活检查接管）
  }
}

/** 维护租约：第一行 = 过期 epoch；有效期内不拉起生产。 */
function leaseActive() {
  if (!existsSync(MAINTENANCE_LEASE)) return { active: false, reason: null };
  try {
    const lines = readFileSync(MAINTENANCE_LEASE, "utf8").split(/\r?\n/);
    const expires = Number(lines[0]);
    const reason = lines[2] || "unknown";
    if (Number.isFinite(expires) && Date.now() / 1000 < expires) {
      return { active: true, reason };
    }
    log(`maintenance lease expired/invalid (${reason}) -> auto-resume`);
    rmSync(MAINTENANCE_LEASE, { force: true });
    return { active: false, reason: null };
  } catch {
    return { active: false, reason: null };
  }
}

/** GET /ready，结构化解析（旧 curl + grep 的替换；失败 = null）。
 *  非 2xx（如单租户 dead 时的 503）也解析 body——503 响应携带 tenants
 *  详情，是"supervisor 活着但部分租户未 ready"与"supervisor 已死"的
 *  唯一区分依据（2026-08-10 修复：此前 503 直接返回 null，watchdog 把
 *  单租户故障误判为整体故障 → 四租户连带重启）。 */
async function fetchReady() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(READY_URL, { signal: controller.signal });
    clearTimeout(timer);
    const data = await response.json();
    return typeof data?.ready === "boolean" ? data : null;
  } catch {
    return null;
  }
}

/** 判定是否需要整体恢复（纯函数，便于单测）：
 *  - ready 且无 stall → false（健康）
 *  - ready=false 但 tenants 中存在 alive 租户 → false（supervisor 进程
 *    活着、内部 auto-respawn 自愈中；由 stall 检测兜底，避免单租户崩溃
 *    拖垮四租户）
 *  - ready=false 且无任何 alive 租户 / 无 tenants 信息 → true（整体故障）
 *  - ready=null（网络失败/无法解析）→ true（supervisor 可能已死）
 */
export function shouldFullRecover(ready) {
  if (ready === null) return true;
  if (ready.ready) return false;
  const tenants = ready.tenants ?? [];
  return !tenants.some((tenant) => tenant.alive === true);
}

/** 8120 是否仍被监听（旧 netstat 的 Windows 等价；失败 = true 保守，避免
 *  与运行中实例双写）。探测带 30s 超时（execFileSync timeout，与
 *  stalledTenant 的 bash 调用同款风格）；exec/timeoutMs 可注入便于单测。 */
export function probePort8120(exec = execFileSync, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  try {
    const out = exec(
      "powershell",
      ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`],
      { encoding: "utf8", shell: false, timeout: timeoutMs },
    );
    const count = Number(out.trim());
    return Number.isFinite(count) && count > 0;
  } catch {
    return true;
  }
}

/** 进程枚举（fail-closed：失败 = 返回 null，调用方保留锁不重启）。 */
function arenaPids() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO, "scripts", "arena-pids.ps1")],
      { encoding: "utf8", shell: false, timeout: PID_PROBE_TIMEOUT_MS },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  } catch {
    return null;
  }
}

/** 读 debug-token（watchdog 恢复操作认证用；缺失返回 null，调用方保持旧行为）。 */
function readDebugToken() {
  try {
    const token = readFileSync(join(RUNTIME_ROOT, "debug-token"), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** 单租户重启（2026-08-10：respawn 耗尽后只重启该租户，不再整体重启拖垮
 *  四租户）。POST /restart?tenant=<id>，带 debug-token。返回 true = 已发出。 */
async function restartTenant(tenantId) {
  const token = readDebugToken();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers = token !== null ? { "x-arena-token": token } : undefined;
    const response = await fetch(`${RESTART_URL}?tenant=${encodeURIComponent(tenantId)}`, {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    log(`tenant restart requested (${tenantId}) -> HTTP ${response.status}${token === null ? " (no token)" : ""}`);
    return true;
  } catch {
    log(`tenant restart request failed (${tenantId})`);
    return false;
  }
}

/** 优雅关停：POST /shutdown（带 debug-token 认证，2026-08-10：此前无 token
 *  必 401，恢复路径白等 8s 后 taskkill 强杀 → recorder/manifest 不落盘
 *  torn run）→ 等 GRACEFUL_WAIT_S → 仍监听则 taskkill 树。 */
async function gracefulShutdown() {
  const token = readDebugToken();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers = token !== null && token.length > 0 ? { "x-arena-token": token } : undefined;
    const response = await fetch(SHUTDOWN_URL, { method: "POST", headers, signal: controller.signal });
    log(`gracefulShutdown: POST /shutdown -> HTTP ${response.status}${token === null ? " (no token file)" : ""}`);
    clearTimeout(timer);
  } catch {
    log("gracefulShutdown: POST /shutdown failed (supervisor may be dead)");
  }
  await new Promise((resolve) => setTimeout(resolve, GRACEFUL_WAIT_S * 1000));
  if (probePort8120()) {
    const pids = arenaPids();
    if (pids !== null && pids.length > 0) {
      for (const pid of pids) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false });
        } catch {
          // 进程可能已退出
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

/** 清理残留：最多 3 轮 kill；最终进程门禁失败 = fail-closed 保留锁。 */
async function killStrays() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pids = arenaPids();
    if (pids === null) {
      log("ABORT recovery: process enumeration unavailable, locks preserved");
      return false;
    }
    if (pids.length === 0) return true;
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false });
      } catch {
        // 进程可能已退出
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const finalPids = arenaPids();
  if (finalPids !== null && finalPids.length > 0) {
    log(`ABORT recovery: live arena process(es) still present after kill attempts: ${finalPids.join(",")}; locks preserved`);
    return false;
  }
  return finalPids !== null;
}

/** 读 JSONL 尾部最多 maxRows 行（损坏行跳过；文件缺失/不可读 = []）。 */
function readJsonlTail(path, maxRows) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const rows = [];
    for (const line of lines.slice(-maxRows)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 损坏行跳过（与 bash grep 的容错一致）
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** 决策停摆（check-decision-stall.sh 的 Node 移植，2026-08-10：git bash 从
 *  watchdog 调用启动挂死（实测单次 >30s），8 次调用拖垮看护轮询 → 原生
 *  Node 判定，豁免规则逐条对齐 bash 版）。返回 true = 停摆。 */
export function decisionStall(dataRoot, tenant) {
  const rows = readJsonlTail(join(dataRoot, "runtime", tenant, "telemetry", "decision.jsonl"), 120);
  if (rows.length === 0) return false; // 无遥测 = 新 run 宽限
  const active = rows.some((row) => (row.agentActionCount ?? 0) > 0 || (row.moveCount ?? 0) > 0);
  if (active) return false;
  // 0 人口豁免：全租户无单位时 intentCounts 为空（{}），0 动作合法
  const intentRows = rows.filter((row) => "intentCounts" in row);
  if (intentRows.length > 0 && intentRows.every((row) => row.intentCounts !== null && typeof row.intentCounts === "object" && Object.keys(row.intentCounts).length === 0)) {
    return false;
  }
  // 低人口发育期豁免（worker<3 = 发育爬坡，重启无效）
  const outcomes = readJsonlTail(join(dataRoot, "runtime", tenant, "telemetry", "outcome.jsonl"), 5);
  const lastWorkers = outcomes.length > 0 ? outcomes[outcomes.length - 1].workerCount : null;
  if (typeof lastWorkers === "number" && lastWorkers < 3) return false;
  // 死区/贫矿探矿豁免：有探矿意图 + 视野 40 行全 0 可见资源 = 地理性停滞
  const hasGo = rows.some((row) => Number(row.intentCounts?.GO_RESOURCE) >= 1);
  const visRows = readJsonlTail(join(dataRoot, "runtime", tenant, "telemetry", "outcome.jsonl"), 40);
  if (hasGo && visRows.length > 0 && visRows.every((row) => row.visibleResourceCellCount === 0)) {
    return false;
  }
  return true;
}

/** 经济停摆（check-economy-stall.sh 的 Node 移植，2026-08-10，同上动机）：
 *  max(workersWithCargo)>=2 且 0 卸货且 delta==0 且无容量锁/迁移 = 满载冻结。
 *  返回 true = 停摆。 */
export function economyStall(dataRoot, tenant) {
  const rows = readJsonlTail(join(dataRoot, "runtime", tenant, "telemetry", "outcome.jsonl"), 60);
  if (rows.length === 0) return false;
  const maxCargo = rows.reduce((max, row) => Math.max(max, row.workersWithCargo ?? 0), 0);
  // 新 run 成熟度宽限：当前 processRunId 行数 <30 = 重启后恢复期，不判停摆
  const lastRunId = rows[rows.length - 1].processRunId ?? null;
  if (lastRunId !== null) {
    const runRows = rows.filter((row) => row.processRunId === lastRunId).length;
    if (runRows < 30) return false;
  }
  let deposits = 0;
  let locked = 0;
  let coreMoving = 0;
  let delta = 0;
  for (const row of rows) {
    const raw = JSON.stringify(row);
    if (raw.includes("DEPOSIT_SUCCEEDED")) deposits += 1;
    if (raw.includes('"reasonCode":"CORE_RESOURCE_FULL"') || raw.includes('"reasonCode":"CORE_MOVING"') || raw.includes('"reasonCode":"CORE_NOT_PRESENT"')) locked += 1;
    if (row.coreState === "MOVING") coreMoving += 1;
    delta += row.coreResourceDelta ?? 0;
  }
  return maxCargo >= 2 && deposits === 0 && delta === 0 && locked === 0 && coreMoving === 0;
}

/** stall 检查：outcome 超龄 / decision 停摆 / economy 停摆（Node 原生判定，
 *  bash 版脚本已退役——2026-08-10 git bash 启动挂死拖垮看护轮询）。 */
function stalledTenant() {
  for (const tenant of TENANTS) {
    const outcomePath = join(RUNTIME_ROOT, tenant, "telemetry", "outcome.jsonl");
    const lockDir = join(RUNTIME_ROOT, tenant, "locks");
    let lockPath = null;
    try {
      const locks = readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
      lockPath = locks.length > 0 ? join(lockDir, locks[0]) : null;
    } catch {
      // lockDir 缺失 = 该租户未运行，跳过
    }
    if (!existsSync(outcomePath)) continue;
    const outcomeAgeS = (Date.now() - statSync(outcomePath).mtimeMs) / 1000;
    if (outcomeAgeS > STALL_MAX_AGE_S) {
      // outcome 超龄：仅当锁很新（启动宽限内）才跳过；锁缺失/陈旧 = 判 stall
      if (lockPath !== null) {
        const lockAgeS = (Date.now() - statSync(lockPath).mtimeMs) / 1000;
        if (lockAgeS < LOCK_FRESH_S) continue;
      }
      return tenant;
    }

    if (decisionStall(DATA_ROOT, tenant) || economyStall(DATA_ROOT, tenant)) return tenant;
  }
  return null;
}

/** 重启 live supervisor（nohup 语义：detached、日志 append 到 SUPERVISOR_LOG）。
 *  直接 node + tsx 启动（v5 修复）：pnpm 布局下不依赖 npm 包装。 */
function restartSupervisor() {
  const out = openSync(SUPERVISOR_LOG, "a");
  const child = spawn(NODE_EXE, [TSX_CLI, "packages/arena-agent/src/cli/run-supervisor.ts", ...SUPERVISOR_ARGS], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", out, out],
    shell: false,
    // t1 台账依赖 SDK 遥测 env：不带则台账停更（2026-08-09 15:13 根因）。
    env: {
      ...process.env,
      ARENA_HERO_TELEMETRY_ENDPOINT: "http://127.0.0.1:8787/api/ingest/agents",
      ARENA_HERO_TENANT: "t1",
    },
  });
  child.unref();
  closeSync(out);
  log(`supervisor restarted (pid ${child.pid})`);
}

/** 主流程：lease → ready/stall → 恢复（优雅关停 → 清残留 → 清锁 → 重启）。
 *  2026-08-10 修复：单租户崩溃（/ready 503 + tenants 仍有 alive）不再触发
 *  整体重启——supervisor 内部 auto-respawn（10 次 + 指数退避）自愈，stall
 *  检测（outcome >600s / 决策停摆）作整体兜底。 */
async function main() {
  if (!acquireWatchdogLock()) {
    logEvent("watchdog_skipped", { reason: "another watchdog instance running (mutex)" });
    return;
  }
  try {
    await mainUnlocked();
  } finally {
    releaseWatchdogLock();
  }
}

async function mainUnlocked() {
  const lease = leaseActive();
  if (lease.active) return;

  const ready = await fetchReady();
  if (ready !== null && ready.ready) {
    const stalled = stalledTenant();
    if (stalled === null) {
      // 健康巡检（每分钟一次 JSONL 摘要；供命令中心/审计消费）
      logEvent("watchdog_tick", {
        ready: true,
        tenants: (ready.tenants ?? []).map((tenant) => ({
          id: tenant.tenantId,
          pid: tenant.pid,
          lifecycle: tenant.lifecycle,
          respawnCount: tenant.respawnCount ?? 0,
        })),
      });
      return;
    }
    log(`STALL detected (${stalled} outcome stale > ${STALL_MAX_AGE_S}s or decision inactive) -> recovering`);
    logEvent("stall_detected", { tenant: stalled, thresholdS: STALL_MAX_AGE_S });
  } else if (ready !== null && !ready.ready && !shouldFullRecover(ready)) {
    // supervisor 应答但未全 ready，且有租户存活 = 部分故障。优先检查 respawn
    // 已耗尽的死租户（2026-08-10：/ready 暴露 respawnCount + respawnLimit）：
    // 耗尽 = supervisor 内部自愈已放弃 → 调 /restart 单租户重启，绝不整体
    // 重启拖垮四租户；未耗尽 = 信任内部 auto-respawn；stall 检测作整体兜底。
    const exhausted = (ready.tenants ?? []).find(
      (tenant) => tenant.alive === false
        && typeof tenant.respawnCount === "number"
        && typeof ready.respawnLimit === "number"
        && tenant.respawnCount >= ready.respawnLimit,
    );
    if (exhausted !== undefined) {
      logEvent("tenant_exhausted", { tenant: exhausted.tenantId, respawnCount: exhausted.respawnCount, respawnLimit: ready.respawnLimit });
      await restartTenant(exhausted.tenantId);
      return;
    }
    const stalled = stalledTenant();
    if (stalled === null) {
      log("partial ready (some tenants down) -> supervisor self-recovering, full restart skipped");
      return;
    }
    log(`partial ready but STALL detected (${stalled}) -> recovering`);
    logEvent("stall_detected", { tenant: stalled, thresholdS: STALL_MAX_AGE_S, partial: true });
  } else {
    // 网络失败 / 无法解析 / 全租户 down = supervisor 可能已死 → 整体恢复。
    // 启动宽限：8120 有监听但未 ready → 等 BOOT_GRACE_MS 再查一次
    if (probePort8120()) {
      await new Promise((resolve) => setTimeout(resolve, BOOT_GRACE_MS));
      const ready2 = await fetchReady();
      if (ready2 !== null && ready2.ready) {
        log("supervisor booted within grace (first probe not ready) -> OK");
        return;
      }
    }
    log("NOT ready -> recovering");
    logEvent("recover_start", { reason: "not ready / unreachable" });
  }

  await gracefulShutdown();
  if (!(await killStrays())) return; // fail-closed：保留锁

  // 清死锁（双 writer 红线：只有进程门禁确认无 writer 后才允许）
  for (const tenant of TENANTS) {
    const lockDir = join(RUNTIME_ROOT, tenant, "locks");
    try {
      for (const file of readdirSync(lockDir)) {
        if (file.endsWith(".lock")) rmSync(join(lockDir, file), { force: true });
      }
    } catch {
      // 无 lockDir = 无需清理
    }
  }

  restartSupervisor();
  // 测绘库增量同步（幂等；供下次启动 seed + 面板 /api/survey）——直接
  // node + tsx（v5 修复：pnpm 布局下 npm run survey:sync 已不可用）。
  try {
    spawn(NODE_EXE, [TSX_CLI, "packages/arena-agent/scripts/run-survey-sync.mts", `--data-root=${DATA_ROOT}`, "--tenants=t1,t2,t3,t4", "--latest-only"], {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
    }).unref();
  } catch {
    // 同步失败不阻塞恢复
  }
}

// 仅直接执行时跑主流程；被测试 import 时不触发（避免单测拉起真实探测/重启）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log(`watchdog fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

