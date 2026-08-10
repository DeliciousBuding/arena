#!/usr/bin/env node
/**
 * bench-run — arena-bench 评测编排器（2026-08-10 重构版）
 *
 * 定位：替代手工 --shard + 手动巡检的跑批方式。场次队列 + 并发池 +
 * 内存门控 + 断点续跑 + ETA + 结构化日志，全部自动化。
 *
 * 与 run-arena-report.mts 的关系：
 *   - 单场执行复用其 `--worker <scenario> <seed> --worker-out-dir <dir>`
 *     子进程模式（确定性单场产物 schema arena.bench.match.v1）
 *   - 汇总复用其 `--merge <runDir>`（读 results.s*.json 分片 → 聚合/榜单/报告）
 *   - runId / ShardFile 契约完全一致（本脚本写 results.s0.json 单分片）
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/bench-run.mts \
 *     [--scenarios ffa-std,ffa-dense] [--seeds 1..10] [--ticks 4000] [--players 10] \
 *     [--out arena-bench] [--data-root PATH] [--force] \
 *     [--concurrency N] [--max-memory-gb N] [--retries N] [--purge]
 *
 * 特性：
 *   - 断点续跑：重跑同参数命令自动跳过已完成场（runDir/matches/ 已有结果）
 *   - ETA：单场时长 EMA 滚动估计 × 剩余场次 / 有效并发，每次输出带本地时间
 *   - 内存门控：可用内存低于 --max-memory-gb 时暂停启动新场，防止换页地狱
 *   - 日志：控制台 + runDir/bench-run.log（同构行），全部本地时间戳
 *   - 进度：runDir/progress.json 每场/每 30s 刷新，供外部读取/监控
 *   - 失败重试：--retries N 自动重试，仍失败记入 errors（merge 汇总）
 *   - Ctrl+C：优雅退出（杀子进程、写进度，提示续跑命令）
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const RUN_REPORT = join(here, "run-arena-report.mts");
const SCENARIOS_PATH = join(here, "bench-scenarios.json");

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function intList(raw: string, flag: string): number[] {
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${flag} must be a comma-separated list of non-negative integers (got "${raw}")`);
  }
  return values;
}

function scenarioList(raw: string, flag: string): string[] {
  const registry = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as Record<string, unknown>;
  const names = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  for (const name of names) {
    if (!(name in registry)) {
      throw new Error(`${flag} 含未知场景 "${name}"（注册表：${Object.keys(registry).join(",")}）`);
    }
  }
  return names;
}

const TICKS = Number(argValue("--ticks") ?? 4000);
if (!Number.isSafeInteger(TICKS) || TICKS < 1) throw new Error(`--ticks must be a positive safe integer`);
const SEEDS = intList(argValue("--seeds") ?? "1,2,3,4,5", "--seeds");
const SCENARIOS = scenarioList(argValue("--scenarios") ?? Object.keys(JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as Record<string, unknown>).join(","), "--scenarios");
const PLAYERS = Number(argValue("--players") ?? 10);
if (!Number.isSafeInteger(PLAYERS) || PLAYERS < 2) throw new Error(`--players must be >= 2`);
const OUT_PREFIX = argValue("--out") ?? "arena-bench";

const CONCURRENCY = (() => {
  const raw = argValue("--concurrency");
  if (raw !== undefined) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--concurrency must be >= 1`);
    return value;
  }
  // 自动：CPU 甜点（每场 ~10 桥进程）+ 内存预算双下限。本机 28 核 → 3~4 场。
  const cpuOptimal = Math.max(1, Math.floor((totalmem() / (1024 ** 3)) / 8));
  return Math.min(cpuOptimal, 6);
})();

const MAX_FREE_GB = Number(argValue("--max-memory-gb") ?? 4);
if (!Number.isFinite(MAX_FREE_GB) || MAX_FREE_GB < 1) throw new Error(`--max-memory-gb must be >= 1`);
const RETRIES = Number(argValue("--retries") ?? 1);
if (!Number.isSafeInteger(RETRIES) || RETRIES < 0) throw new Error(`--retries must be >= 0`);
const FORCE = hasFlag("--force");
const PURGE = hasFlag("--purge");

const DATA_ROOT =
  argValue("--data-root") ??
  process.env.ARENA_DATA_ROOT ??
  (existsSync(resolve(PKG_ROOT, "..", "..", "..", "data")) ? resolve(PKG_ROOT, "..", "..", "..", "data") : undefined);
if (DATA_ROOT === undefined) throw new Error(`--data-root or ARENA_DATA_ROOT required`);

const ROSTER_SIZE = Math.min(PLAYERS, 10); // 与 run-arena-report rosterSize 一致（条目数上限）

/** CPU 甜点并发（自动模式下限基准）。 */
const CPU_OPTIMAL = Math.max(1, Math.floor((totalmem() / (1024 ** 3)) / 8));

/* ------------------------------------------------------------------ *
 * runId / 目录契约（与 run-arena-report 逐字一致）
 * ------------------------------------------------------------------ */

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const RUN_IDENTITY = { kind: "arena-bench-v3", scenarios: SCENARIOS, seeds: SEEDS, ticks: TICKS, players: ROSTER_SIZE };
const RUN_ID = `${OUT_PREFIX}-${sha256Json(RUN_IDENTITY).slice(0, 12)}`;
const RUN_DIR = resolve(DATA_ROOT, "runs", "sim", RUN_ID);
const MATCHES_DIR = join(RUN_DIR, "matches");
const LOG_PATH = join(RUN_DIR, "bench-run.log");
const PROGRESS_PATH = join(RUN_DIR, "progress.json");

/* ------------------------------------------------------------------ *
 * 本地时间戳 + 日志（全部本地时区，杜绝 UTC 误读）
 * ------------------------------------------------------------------ */

function localTime(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function logLine(level: "info" | "warn" | "error", message: string): string {
  return `[${localTime()}] [${level}] ${message}`;
}

function log(level: "info" | "warn" | "error", message: string): void {
  const line = logLine(level, message);
  console.log(line);
  try {
    writeFileSync(LOG_PATH, line + "\n", { flag: "a" });
  } catch {
    // 日志文件写失败不中断跑批
  }
}

/* ------------------------------------------------------------------ *
 * 进度状态
 * ------------------------------------------------------------------ */

interface MatchJob {
  readonly scenario: string;
  readonly seed: number;
  attempts: number;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  elapsedMs?: number;
}

function matchResultFile(scenario: string, seed: number): string {
  return join(MATCHES_DIR, `match-${scenario}-s${seed}.json`);
}

function matchErrorFile(scenario: string, seed: number): string {
  return join(MATCHES_DIR, `match-${scenario}-s${seed}.error.json`);
}

function freeMemoryGb(): number {
  return freemem() / 1024 ** 3;
}

/** 单场时长 EMA（秒）；预热不足时用最近完成场的均值。 */
class EtaEstimator {
  private readonly samples: number[] = [];
  private readonly alpha = 0.3;
  private ema: number | null = null;

  addSample(elapsedSeconds: number): void {
    this.samples.push(elapsedSeconds);
    this.ema = this.ema === null ? elapsedSeconds : this.alpha * elapsedSeconds + (1 - this.alpha) * this.ema;
  }

  estimateSeconds(): number {
    if (this.ema !== null) return this.ema;
    if (this.samples.length > 0) return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    return 120; // 无样本时的保守下限
  }
}

const estimator = new EtaEstimator();

/* ------------------------------------------------------------------ *
 * 单场执行（复用 run-arena-report --worker 子进程）
 * ------------------------------------------------------------------ */

/** 全部活跃子进程（Ctrl+C 时统一终止）。 */
const benchChildren = new Set<ChildProcess>();

function runMatch(job: MatchJob): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        RUN_REPORT,
        "--worker", job.scenario, String(job.seed),
        "--ticks", String(TICKS),
        "--players", String(PLAYERS),
        "--worker-out-dir", MATCHES_DIR,
      ],
      { cwd: PKG_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    benchChildren.add(child);
    let stderrTail = "";
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });
    child.on("error", (error) => {
      benchChildren.delete(child);
      rejectPromise(new Error(`spawn 失败：${error.message}`));
    });
    child.once("exit", (code) => {
      benchChildren.delete(child);
      if (code !== 0) {
        let detail = stderrTail.trim() || `exit ${code}`;
        try {
          const errorFile = JSON.parse(readFileSync(matchErrorFile(job.scenario, job.seed), "utf8")) as {
            message?: string;
          };
          if (typeof errorFile.message === "string" && errorFile.message.length > 0) detail = errorFile.message;
        } catch {
          // 错误文件缺失时退回 stderr 摘要
        }
        rejectPromise(new Error(detail));
        return;
      }
      if (!existsSync(matchResultFile(job.scenario, job.seed))) {
        rejectPromise(new Error("子进程退出 0 但结果文件缺失"));
        return;
      }
      resolvePromise();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 调度主循环
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  if (PURGE) {
    if (!existsSync(RUN_DIR)) {
      console.log(`[${localTime()}] [info] purge：${RUN_DIR} 不存在，无需清理`);
      return 0;
    }
    rmSync(RUN_DIR, { recursive: true, force: true });
    console.log(`[${localTime()}] [info] purge：已删除 ${RUN_DIR}`);
    return 0;
  }

  if (!FORCE && existsSync(RUN_DIR)) {
    // 续跑可接受：matches/ + 上次的日志/进度文件；其余产物（results.* 等）需 --force
    const existing = readdirSync(RUN_DIR).filter(
      (name) => name !== "matches" && name !== "bench-run.log" && name !== "progress.json",
    );
    if (existing.length > 0) {
      console.error(
        `[${localTime()}] [error] ${RUN_DIR} 已存在（含产物：${existing.join(", ")}）。` +
          `需要 --force 覆盖，或先 --purge，或本意是续跑（自动跳过已完成场次）。`,
      );
      return 1;
    }
  }

  mkdirSync(MATCHES_DIR, { recursive: true });
  log("info", `bench-run 启动：${SCENARIOS.length} 场景 × ${SEEDS.length} seeds × ${PLAYERS} 玩家，ticks=${TICKS}`);
  log("info", `runId=${RUN_ID} 并发=${CONCURRENCY} 内存门控=${MAX_FREE_GB}GB 重试=${RETRIES}`);
  log("info", `数据目录：${RUN_DIR}`);

  // 断点续跑：已有结果跳过；已有错误文件重试
  const jobs: MatchJob[] = [];
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      const job: MatchJob = { scenario, seed, attempts: 0, status: "pending" };
      if (existsSync(matchResultFile(scenario, seed))) {
        job.status = "done";
      } else if (existsSync(matchErrorFile(scenario, seed))) {
        job.attempts = 1; // 上次失败，从 1 次尝试开始
      }
      jobs.push(job);
    }
  }
  const resumed = jobs.filter((job) => job.status === "done").length;
  if (resumed > 0) log("info", `断点续跑：跳过已完成的 ${resumed}/${jobs.length} 场`);

  const total = jobs.length;
  let done = resumed;
  let failed = 0;
  let retried = 0;
  const running = new Set<MatchJob>();
  const queue: MatchJob[] = jobs.filter((job) => job.status !== "done");
  const startedAt = Date.now();
  let lastHeartbeat = 0;
  let lastFinishedAt: number | null = null;
  // 动态并发（设计 §3.1）：内存充裕升、连续门控降
  let targetConcurrency = CONCURRENCY;
  let gateHits = 0;

  const progress = () => {
    const finished = done + failed;
    const remaining = total - finished;
    const estimate = estimator.estimateSeconds();
    const effectiveConcurrency = Math.max(
      1,
      Math.min(targetConcurrency, Math.max(1, running.size + (queue.length > 0 ? 1 : 0))),
    );
    const etaSeconds = (remaining / effectiveConcurrency) * estimate;
    const eta = new Date(Date.now() + etaSeconds * 1000);
    const finishedAt = lastFinishedAt ?? startedAt;
    return {
      runId: RUN_ID,
      startedAt: localTime(new Date(startedAt)),
      updatedAt: localTime(),
      scenarioCount: SCENARIOS.length,
      seedCount: SEEDS.length,
      players: PLAYERS,
      ticks: TICKS,
      total,
      done,
      failed,
      retried,
      remaining,
      concurrency: CONCURRENCY,
      running: running.size,
      queue: queue.length,
      avgMatchSeconds: Math.round(estimate),
      etaAt: localTime(eta),
      etaSeconds: Math.round(etaSeconds),
      freeMemGb: Math.round(freeMemoryGb() * 10) / 10,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      lastFinishAt: finishedAt === startedAt ? null : localTime(new Date(finishedAt)),
    };
  };

  const writeProgress = () => {
    try {
      writeFileSync(PROGRESS_PATH, JSON.stringify(progress(), null, 2));
    } catch {
      // 进度文件写失败不中断
    }
  };

  const heartbeat = () => {
    const info = progress();
    log(
      "info",
      `进度 ${info.done}/${info.total} 场（失败 ${info.failed}，重试 ${info.retried}）` +
        `并发=${info.concurrency} 运行中=${info.running} 队列=${info.queue}` +
        `单场均时=${info.avgMatchSeconds}s 内存空闲=${info.freeMemGb}GB` +
        `ETA ${info.etaAt}（剩 ${Math.round(info.etaSeconds / 60)} 分钟）`,
    );
    writeProgress();
  };

  const children = new Set<ChildProcess>();

  const schedule = () => {
    while (running.size < targetConcurrency && queue.length > 0) {
      // 内存门控只拦截"有场在跑"时的追加并发（等场次完成释放内存）；
      // 场上全空时强制启动（否则无场可释放，永远死等）。
      if (freeMemoryGb() < MAX_FREE_GB && running.size > 0) {
        gateHits += 1;
        log("warn", `内存空闲 ${Math.round(freeMemoryGb() * 10) / 10}GB < ${MAX_FREE_GB}GB，暂缓启动新场（连续 ${gateHits} 次）`);
        if (gateHits >= 3 && targetConcurrency > 1) {
          targetConcurrency -= 1;
          gateHits = 0;
          log("warn", `动态并发：连续门控，降至 ${targetConcurrency}`);
        }
        return;
      }
      const job = queue.shift()!;
      running.add(job);
      job.status = "running";
      job.attempts += 1;
      const jobStartedAt = Date.now();
      runMatch(job)
        .then(() => {
          const elapsedSeconds = (Date.now() - jobStartedAt) / 1000;
          estimator.addSample(elapsedSeconds);
          done += 1;
          lastFinishedAt = Date.now();
          job.status = "done";
          job.elapsedMs = Math.round(elapsedSeconds * 1000);
          // 动态并发：内存充裕且场次满负荷时尝试升并发（上限 CPU 甜点）
          if (running.size >= targetConcurrency && targetConcurrency < CPU_OPTIMAL && freeMemoryGb() >= MAX_FREE_GB + 3) {
            targetConcurrency += 1;
            log("info", `动态并发：内存充裕（${Math.round(freeMemoryGb() * 10) / 10}GB），升至 ${targetConcurrency}`);
          }
          gateHits = 0;
          log(
            "info",
            `完成 ${job.scenario} seed=${job.seed}（${Math.round(elapsedSeconds)}s，第 ${job.attempts} 次尝试）` +
              `｜${done}/${total} 场`,
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (job.attempts <= RETRIES) {
            retried += 1;
            job.status = "pending";
            job.error = message;
            queue.push(job);
            log("warn", `失败 ${job.scenario} seed=${job.seed}：${message}（第 ${job.attempts} 次，重试）`);
          } else {
            failed += 1;
            job.status = "failed";
            job.error = message;
            log("error", `失败 ${job.scenario} seed=${job.seed}：${message}（重试 ${RETRIES} 次仍失败，记入 errors）`);
          }
        })
        .finally(() => {
          running.delete(job);
          writeProgress();
          heartbeat();
          schedule();
        });
    }
    if (running.size === 0 && queue.length === 0 && done + failed === total) {
      resolveFinish?.();
      void finish();
    }
  };

  let finished = false;
  let resolveFinish: (() => void) | null = null;
  const finishedPromise = new Promise<void>((resolvePromise) => {
    resolveFinish = resolvePromise;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    const elapsed = (Date.now() - startedAt) / 1000;
    log("info", `跑批结束：${done} 场完成，${failed} 场失败，${retried} 次重试，耗时 ${formatDuration(elapsed)}`);
    writeProgress();
    if (failed > 0) {
      log("warn", `存在失败场次（${failed}），merge 将带 errors 汇总`);
    }
    void mergeAndReport();
  };

  // Ctrl+C 优雅退出：杀全部子进程，已完成场次已落盘
  let interrupted = false;
  const handleInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    log("warn", "收到中断信号，正在停止…（已完成场次已落盘，重跑同命令可续跑）");
    writeProgress();
    for (const child of benchChildren) {
      child.kill();
    }
    process.exit(130);
  };
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleInterrupt);

  // 心跳定时器（无场次完成时也定期汇报）
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastHeartbeat > 30_000 && !finished) {
      lastHeartbeat = Date.now();
      heartbeat();
    }
  }, 15_000);

  schedule();
  log("info", `调度已启动：running=${running.size} queue=${queue.length}`);
  await finishedPromise;
  log("info", "全部场次结束，进入汇总");
  clearInterval(heartbeatTimer);
  return 0; // 失败场次已在 errors 中呈现，退出码统一 0
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  return `${hours}h ${minutes}m ${secs}s`;
}

/* ------------------------------------------------------------------ *
 * 汇总：写单分片 → 复用 run-arena-report --merge
 * ------------------------------------------------------------------ */

async function mergeAndReport(): Promise<void> {
  const rulesVersion = "v0.14";
  const rosterSize = Math.min(PLAYERS, 10);
  const matches = [];
  const errors = [];
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      const resultPath = matchResultFile(scenario, seed);
      if (existsSync(resultPath)) {
        matches.push(JSON.parse(readFileSync(resultPath, "utf8")) as unknown);
      } else {
        const errorPath = matchErrorFile(scenario, seed);
        let message = "结果缺失";
        if (existsSync(errorPath)) {
          try {
            message = (JSON.parse(readFileSync(errorPath, "utf8")) as { message?: string }).message ?? message;
          } catch {
            // 解析失败保留默认消息
          }
        }
        errors.push({ scenario, seed, message });
      }
    }
  }
  const shardFile = {
    schema: "arena.bench.shard.v1",
    shard: { index: 0, total: 1, by: "scenario" as const },
    params: { scenarios: SCENARIOS, seeds: SEEDS, ticks: TICKS, players: rosterSize, rulesVersion },
    matches,
    errors,
  };
  const shardPath = join(RUN_DIR, "results.s0.json");
  writeFileSync(shardPath, JSON.stringify(shardFile, null, 2));
  log("info", `分片文件已写：${shardPath}（${matches.length} 场，${errors.length} 失败）`);

  const outputBase = resolve(DATA_ROOT, "runs", "sim");
  const relativeRunDir = relative(outputBase, RUN_DIR);
  log("info", `调用 --merge ${relativeRunDir} 生成 results.json + report.html…`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", RUN_REPORT, "--merge", relativeRunDir, "--data-root", DATA_ROOT],
      { cwd: PKG_ROOT, stdio: "inherit", windowsHide: true },
    );
    child.on("error", rejectPromise);
    child.once("exit", (code) => {
      if (code !== 0) rejectPromise(new Error(`--merge 退出码 ${code}`));
      else resolvePromise();
    });
  });
  log("info", `汇总完成：${join(RUN_DIR, "results.json")} + report.html`);
}

/* ------------------------------------------------------------------ */

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${localTime()}] [error] ${message}`);
  process.exitCode = 1;
});
