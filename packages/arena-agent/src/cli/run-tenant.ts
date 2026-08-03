/**
 * run-tenant CLI（切片 4 阶段 6）：单租户运行入口。
 *
 * 用法：
 *   npx tsx src/cli/run-tenant.ts --config=runtime/configs/t1.json            # 按 config 默认
 *   npx tsx src/cli/run-tenant.ts --config=... --shadow                      # 强制只观察（不提交）
 *   npx tsx src/cli/run-tenant.ts --config=... --live                        # 强制 live 提交
 *   npx tsx src/cli/run-tenant.ts --config=... --mode=agent-shadow           # 覆盖决策模式
 *   npx tsx src/cli/run-tenant.ts --config=... --live --live-ticks=100        # 100 submit + 1 outcome drain
 *   npx tsx src/cli/run-tenant.ts --config=... --live --record-calibration     # S8b 旁路 Runtime-Golden
 *   npx tsx src/cli/run-tenant.ts --config=... --live --max-ticks=100         # 兼容：按观察 Turn 数停止
 *   # --live 缺省先观察 1 Tick；可用 --startup-sync-ticks=0 显式关闭
 *   npx tsx src/cli/run-tenant.ts --doctor --config=...                      # 只跑 doctor（只读）
 *
 * 安全：密钥只从 env 读（config.arenaTokenEnv）；SIGINT/SIGTERM 优雅关闭。
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDoctor } from "./doctor.ts";
import { runTenant } from "../app/tenant-runtime.ts";

/** 加载 <repoRoot>/.env（KEY=VALUE 行，忽略 # 注释；不覆盖已存在的 env；绝不打印值）。 */
function loadDotEnv(repoRoot: string): void {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(eq + 1);
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      doctor: { type: "boolean", short: "d" },
      live: { type: "boolean", short: "l" },
      shadow: { type: "boolean", short: "s" },
      mode: { type: "string" },
      "max-ticks": { type: "string" },
      "live-ticks": { type: "string" },
      "startup-sync-ticks": { type: "string" },
      "record-calibration": { type: "boolean" },
      repoRoot: { type: "string" },
    },
  });

  if (values.config === undefined) {
    console.error("用法：run-tenant --config=<tenant.json> [--doctor] [--live] [--mode=safety|deterministic|agent-shadow|hybrid] [--live-ticks=N|--max-ticks=N] [--startup-sync-ticks=N] [--record-calibration]");
    process.exitCode = 1;
    return;
  }
  const repoRoot = values.repoRoot ?? process.cwd();
  loadDotEnv(repoRoot); // 密钥只从 .env 进进程环境，不落盘不打印
  const configDir = join(repoRoot, "runtime", "configs");
  const configPath = values.config;

  if (values.doctor) {
    const result = runDoctor(configPath, repoRoot, join(repoRoot, "runtime"));
    for (const check of result.checks) {
      console.log(`[${check.pass ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
    }
    process.exitCode = result.allPass ? 0 : 1;
    return;
  }

  const maxTicksRaw = values["max-ticks"];
  const maxTicks = maxTicksRaw === undefined ? undefined : Number(maxTicksRaw);
  if (maxTicks !== undefined && (!Number.isInteger(maxTicks) || maxTicks < 1)) {
    throw new Error(`--max-ticks 必须是正整数，实际=${maxTicksRaw}`);
  }
  const liveTicksRaw = values["live-ticks"];
  const maxLiveTicks = liveTicksRaw === undefined ? undefined : Number(liveTicksRaw);
  if (maxLiveTicks !== undefined && (!Number.isInteger(maxLiveTicks) || maxLiveTicks < 1)) {
    throw new Error(`--live-ticks 必须是正整数，实际=${liveTicksRaw}`);
  }
  if (maxTicks !== undefined && maxLiveTicks !== undefined) {
    throw new Error("--max-ticks 与 --live-ticks 不能同时设置");
  }
  if (maxLiveTicks !== undefined && !values.live) {
    throw new Error("--live-ticks 只能与 --live 一起使用");
  }
  if (values.live && values.shadow) {
    throw new Error("--live 与 --shadow 互斥");
  }
  if (values["record-calibration"] === true && !values.live) {
    throw new Error("--record-calibration 只能与 --live 一起使用");
  }
  const startupSyncRaw = values["startup-sync-ticks"];
  const startupSyncTurns = startupSyncRaw === undefined
    ? values.live ? 1 : 0
    : Number(startupSyncRaw);
  if (!Number.isInteger(startupSyncTurns) || startupSyncTurns < 0) {
    throw new Error(`--startup-sync-ticks 必须是非负整数，实际=${startupSyncRaw}`);
  }
  const decisionMode = values.mode === undefined
    ? undefined
    : (values.mode as "safety" | "deterministic" | "agent-shadow" | "hybrid");
  const result = await runTenant(configPath, repoRoot, {
    submissionMode: values.live ? "live" : values.shadow ? "disabled" : undefined,
    decisionMode,
    maxTicks,
    maxLiveTicks,
    startupSyncTurns,
    recordCalibration: values["record-calibration"] === true,
  });
  console.log(
    `run 结束：processRunId=${result.processRunId} tenant=${result.tenantId} ` +
      `decisionMode=${result.decisionMode} submissionMode=${result.submissionMode} ` +
      `processedTicks=${result.processedTickCount} liveSubmits=${result.liveSubmitCount} ` +
      `lastTick=${String(result.lastTick)}`,
  );
  console.log(`manifest: ${result.manifestPath}`);
  console.log(`telemetry: ${result.telemetryPaths.runtime}`);
  if (result.calibration !== undefined) {
    console.log(
      `calibration: ${result.calibration.manifestPath} cases=${result.calibration.caseCount} ` +
        `errors=${result.calibration.errorCount}`,
    );
  }
}

main().catch((error) => {
  console.error(`run-tenant 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
