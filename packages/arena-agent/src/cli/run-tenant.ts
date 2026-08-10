/**
 * run-tenant CLI（切片 4 阶段 6）：单租户运行入口。
 *
 * 用法：
 *   npx tsx src/cli/run-tenant.ts --config=../data/runtime/configs/t1.json    # 按 config 默认
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
import { runDoctor } from "./doctor.ts";
import { runTenant } from "../app/tenant-runtime.ts";
import { loadDotEnv } from "../app/dotenv.ts";
import { resolveArenaDataRoot, resolveArenaRuntimeRoot } from "../app/data-root.ts";
import { registerShutdownRequest } from "../app/process-shutdown.ts";
import { createTenantAllianceIpcBridge } from "../alliance/runtime/tenant-bridge.ts";

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
      "record-alliance-shadow": { type: "boolean" },
      "alliance-shadow-interval-ticks": { type: "string" },
      repoRoot: { type: "string" },
      "data-root": { type: "string" },
    },
  });

  if (values.config === undefined) {
    console.error("用法：run-tenant --config=<tenant.json> [--doctor] [--live] [--mode=safety|deterministic|agent-shadow|hybrid] [--live-ticks=N|--max-ticks=N] [--startup-sync-ticks=N] [--record-calibration] [--record-alliance-shadow] [--alliance-shadow-interval-ticks=N]");
    process.exitCode = 1;
    return;
  }
  const repoRoot = values.repoRoot ?? process.cwd();
  loadDotEnv(repoRoot); // 密钥只从 .env 进进程环境，不落盘不打印
  const dataRoot = resolveArenaDataRoot(repoRoot, values["data-root"], process.env.ARENA_DATA_ROOT);
  const configPath = values.config;

  if (values.doctor) {
    const result = runDoctor(configPath, repoRoot, resolveArenaRuntimeRoot(dataRoot));
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
  const allianceShadowIntervalRaw = values["alliance-shadow-interval-ticks"];
  const allianceShadowIntervalTicks = allianceShadowIntervalRaw === undefined ? undefined : Number(allianceShadowIntervalRaw);
  if (allianceShadowIntervalTicks !== undefined && (!Number.isInteger(allianceShadowIntervalTicks) || allianceShadowIntervalTicks < 1)) {
    throw new Error(`--alliance-shadow-interval-ticks 必须是正整数，实际=${allianceShadowIntervalRaw}`);
  }
  if (allianceShadowIntervalTicks !== undefined && values["record-alliance-shadow"] !== true) {
    throw new Error("--alliance-shadow-interval-ticks 只能与 --record-alliance-shadow 一起使用");
  }
  const decisionMode = values.mode === undefined
    ? undefined
    : (values.mode as "safety" | "deterministic" | "agent-shadow" | "hybrid");
  const allianceBridge = values["record-alliance-shadow"] === true && typeof process.send === "function"
    ? createTenantAllianceIpcBridge((message) => {
        if (process.connected && typeof process.send === "function") process.send(message);
      })
    : null;
  const onAllianceIpc = (message: unknown): void => allianceBridge?.onMessage(message);
  if (allianceBridge !== null) process.on("message", onAllianceIpc);
  const result = await (async () => {
    try {
      return await runTenant(configPath, repoRoot, {
        dataRoot,
        submissionMode: values.live ? "live" : values.shadow ? "disabled" : undefined,
        decisionMode,
        maxTicks,
        maxLiveTicks,
        startupSyncTurns,
        recordCalibration: values["record-calibration"] === true,
        recordAllianceShadow: values["record-alliance-shadow"] === true,
        allianceShadowIntervalTicks,
        onAllianceShadowFrame: allianceBridge === null ? undefined : (frame) => allianceBridge.onFrame(frame),
        onSignal: registerShutdownRequest,
      });
    } finally {
      if (allianceBridge !== null) process.off("message", onAllianceIpc);
    }
  })();
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

/**
 * 全局异常日志（2026-08-10 生产稳定性修复）：此前任何未捕获异常都会让
 * 租户进程无痕退出（exit code=1 且无 stderr 输出——supervisor 只能看到
 * "unexpected exit code=1"）。注册完整堆栈日志 + 区分退出码（2=未捕获
 * 异常，3=未处理 rejection），供 supervisor auto-respawn 循环取证。
 */
function installGlobalErrorLoggers(): void {
  process.on("uncaughtException", (error) => {
    console.error(
      `[run-tenant] uncaughtException (exit 2): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(2);
  });
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[run-tenant] unhandledRejection (exit 3): ${detail}`);
    process.exit(3);
  });
}

void (async () => {
  installGlobalErrorLoggers();
  await main();
})()
  .catch((error) => {
    console.error(`run-tenant 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) {
      try { process.disconnect(); } catch {}
    }
  });
