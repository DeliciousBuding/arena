/**
 * run-tenant CLI（切片 4 阶段 6）：单租户运行入口。
 *
 * 用法：
 *   npx tsx src/cli/run-tenant.ts --config=runtime/configs/t1.json            # 按 config 默认（shadow）
 *   npx tsx src/cli/run-tenant.ts --config=... --live                        # 强制 live 提交
 *   npx tsx src/cli/run-tenant.ts --config=... --mode=agent-shadow           # 覆盖决策模式
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
      mode: { type: "string" },
      repoRoot: { type: "string" },
    },
  });

  if (values.config === undefined) {
    console.error("用法：run-tenant --config=<tenant.json> [--doctor] [--live] [--mode=safety|agent-shadow|hybrid]");
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

  const decisionMode = values.mode === undefined ? undefined : (values.mode as "safety" | "agent-shadow" | "hybrid");
  const result = await runTenant(configPath, repoRoot, {
    submissionMode: values.live ? "live" : undefined,
    decisionMode,
  });
  console.log(
    `run 结束：processRunId=${result.processRunId} tenant=${result.tenantId} ` +
      `decisionMode=${result.decisionMode} submissionMode=${result.submissionMode} ticks=${result.tickCount}`,
  );
  console.log(`manifest: ${result.manifestPath}`);
  console.log(`telemetry: ${result.telemetryPaths.runtime}`);
}

main().catch((error) => {
  console.error(`run-tenant 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
