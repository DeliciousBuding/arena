#!/usr/bin/env node
/**
 * Arena 本地看护（Node 版，2026-08-08 从 bash 迁移）：
 * 每分钟由计划任务调用一次；检查本地 supervisor /ready；异常则确认旧进程
 * 死透 → 清理死锁 → 重启 live supervisor（t1-t4 全 TS 线）。
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
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const LOG = join(HOME, "arena-watchdog.log");
const SUPERVISOR_LOG = join(HOME, "arena-supervisor.log");
// 注意：必须用 Windows 风格路径（正斜杠可）。MSYS 风格 "/d/Code/..." 在
// Windows node 的 fs 操作里解析为 "D:\d\Code\..."（不存在）——v4 曾因此
// 静默失效：stall 检测全跳过、lease 永不生效、重启以错误 data-root 启动。
const REPO = "ARENA_REPO_ROOT/arena-ts/.worktrees/production-runtime-v3";
const DATA_ROOT = "ARENA_REPO_ROOT/data";
const RUNTIME_ROOT = join(DATA_ROOT, "runtime");
const READY_URL = "http://127.0.0.1:8120/ready";
const SHUTDOWN_URL = "http://127.0.0.1:8120/shutdown";
const MAINTENANCE_LEASE = join(RUNTIME_ROOT, "maintenance.lease");
const TENANTS = ["t1", "t2", "t3", "t4"];
/** outcome JSONL 超过该秒数未更新 = stall（与旧版一致）。 */
const STALL_MAX_AGE_S = 600;
/** 启动宽限：8120 有监听但 /ready 未 true 时再等该毫秒复查（防慢启动被误杀）。 */
const BOOT_GRACE_MS = 30_000;
/** 优雅关停后等待秒数，仍监听则 taskkill 兜底（与旧版一致）。 */
const GRACEFUL_WAIT_S = 8;
const SUPERVISOR_ARGS = [
  `--data-root=${DATA_ROOT}`,
  "--configs=t1,t2,t3,t4",
  "--mode=deterministic",
  "--live",
  "--record-calibration",
  "--record-alliance-shadow",
  "--alliance-shadow-interval-ticks=3",
  "--alliance-director-shadow",
  "--alliance-director-period-ticks=4",
  "--alliance-director-max-skew-ticks=2",
  "--port=8120",
];
/** 本机 node（watchdog 自身运行时）——不依赖 npm/pnpm 包装（pnpm 化后
 *  npm run 已不可靠；v4 曾用 npm run arena:supervisor，workspace 布局下
 *  无法解析）。 */
const NODE_EXE = process.execPath;
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(line) {
  appendFileSync(LOG, `${now()} ${line}\n`);
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

/** GET /ready，结构化解析（旧 curl + grep 的替换；失败 = null）。 */
async function fetchReady() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(READY_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.ready === "boolean" ? data : null;
  } catch {
    return null;
  }
}

/** 8120 是否仍被监听（旧 netstat 的 Windows 等价；失败 = true 保守）。 */
function port8120Listening() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort 8120 -State Listen -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"],
      { encoding: "utf8", shell: false },
    );
    const count = Number(out.trim());
    return Number.isFinite(count) && count > 0;
  } catch {
    return true; // 探测失败保守视为监听中（避免与运行中实例双写）
  }
}

/** 进程枚举（fail-closed：失败 = 返回 null，调用方保留锁不重启）。 */
function arenaPids() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO, "scripts", "arena-pids.ps1")],
      { encoding: "utf8", shell: false },
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

/** 优雅关停：POST /shutdown → 等 GRACEFUL_WAIT_S → 仍监听则 taskkill 树。 */
async function gracefulShutdown() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(SHUTDOWN_URL, { method: "POST", signal: controller.signal });
    clearTimeout(timer);
  } catch {
    // 无 8120 服务（可能已死）→ 直接走进程清理
  }
  await new Promise((resolve) => setTimeout(resolve, GRACEFUL_WAIT_S * 1000));
  if (port8120Listening()) {
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

/** stall 检查：outcome 超龄 / decision 停摆 / economy 停摆（独立脚本判定）。 */
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
    if (!existsSync(outcomePath) || lockPath === null) continue;
    const outcomeMtime = statSync(outcomePath).mtimeMs;
    const lockMtime = statSync(lockPath).mtimeMs;
    // 启动宽限：lock 新于 outcome = 本轮尚未产出首个 outcome，不判 stall
    if (outcomeMtime < lockMtime) continue;
    const ageS = (Date.now() - outcomeMtime) / 1000;
    if (ageS > STALL_MAX_AGE_S) return tenant;

    // 决策停摆（0 动作）与经济停摆（满载不卸货）用既有脚本判定（保持同一套阈值）
    for (const script of ["check-decision-stall.sh", "check-economy-stall.sh"]) {
      try {
        const out = execFileSync("bash", [join(REPO, "scripts", script), DATA_ROOT, tenant], {
          encoding: "utf8",
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 15_000,
        }).trim();
        if (out.startsWith("STALL:")) return tenant;
      } catch {
        // 脚本不可用 = 跳过该检查（与旧版 2>/dev/null 一致）
      }
    }
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
  });
  child.unref();
  closeSync(out);
  log(`supervisor restarted (pid ${child.pid})`);
}

/** 主流程：lease → ready/stall → 恢复（优雅关停 → 清残留 → 清锁 → 重启）。 */
async function main() {
  const lease = leaseActive();
  if (lease.active) return;

  const ready = await fetchReady();
  if (ready !== null && ready.ready) {
    const stalled = stalledTenant();
    if (stalled === null) return;
    log(`STALL detected (${stalled} outcome stale > ${STALL_MAX_AGE_S}s or decision inactive) -> recovering`);
  } else {
    // 启动宽限：8120 有监听但未 ready → 等 BOOT_GRACE_MS 再查一次
    if (port8120Listening()) {
      await new Promise((resolve) => setTimeout(resolve, BOOT_GRACE_MS));
      const ready2 = await fetchReady();
      if (ready2 !== null && ready2.ready) {
        log("supervisor booted within grace (first probe not ready) -> OK");
        return;
      }
    }
    log("NOT ready -> recovering");
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

main().catch((error) => {
  log(`watchdog fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
