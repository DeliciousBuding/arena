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
import { join } from "node:path";
import { runDoctor } from "./doctor.ts";
import { runTenant } from "../app/tenant-runtime.ts";

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
