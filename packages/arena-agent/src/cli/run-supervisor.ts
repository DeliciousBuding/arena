/**
 * run-supervisor CLI（切片 5）：四租户进程管家。
 *
 * 用法：
 *   npx tsx src/cli/run-supervisor.ts --repoRoot=CODE_ROOT/Projects/arena          # t1-t4，按 config 默认
 *   npx tsx src/cli/run-supervisor.ts --configs=t1,t2 --live --live-ticks=100    # 只跑 t1/t2 live
 *   npx tsx src/cli/run-supervisor.ts --mode=agent-shadow --shadow               # 全租户 LLM shadow
 *
 * 事件落盘 <repoRoot>/runtime/supervisor.jsonl；SIGINT/SIGTERM 优雅关闭全部子进程。
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { TenantSupervisor } from "../app/tenant-supervisor.ts";
import { DebugServer } from "../app/debug-server.ts";
import { loadDotEnv } from "../app/dotenv.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "repo-root": { type: "string" },
      configs: { type: "string" },
      live: { type: "boolean" },
      shadow: { type: "boolean" },
      mode: { type: "string" },
      "live-ticks": { type: "string" },
      "max-ticks": { type: "string" },
      "startup-sync-ticks": { type: "string" },
      "shutdown-timeout-ms": { type: "string" },
      port: { type: "string" },
    },
  });

  const repoRoot = values["repo-root"] ?? process.cwd();
  loadDotEnv(repoRoot);

  const configNames = (values.configs ?? "t1,t2,t3,t4")
    .split(",")
    .map((name) => (name.endsWith(".json") ? name : `${name}.json`));

  const tenantArgs: string[] = [];
  if (values.live) {
    tenantArgs.push("--live");
  }
  if (values.shadow) {
    tenantArgs.push("--shadow");
  }
  if (values.mode !== undefined) {
    tenantArgs.push(`--mode=${values.mode}`);
  }
  if (values["live-ticks"] !== undefined) {
    tenantArgs.push(`--live-ticks=${values["live-ticks"]}`);
  }
  if (values["max-ticks"] !== undefined) {
    tenantArgs.push(`--max-ticks=${values["max-ticks"]}`);
  }
  if (values["startup-sync-ticks"] !== undefined) {
    tenantArgs.push(`--startup-sync-ticks=${values["startup-sync-ticks"]}`);
  }

  const shutdownTimeoutMs = values["shutdown-timeout-ms"] === undefined
    ? undefined
    : Number(values["shutdown-timeout-ms"]);

  const supervisor = new TenantSupervisor({
    repoRoot,
    configs: configNames,
    tenantArgs,
    ...(shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs } : {}),
    onEvent: (event) => {
      console.log(`[supervisor] ${event.at} ${event.type} ${event.tenantId}${event.detail ? `: ${event.detail}` : ""}`);
    },
  });

  const results = supervisor.start();
  let failed = false;
  for (const [tenantId, ok] of results) {
    console.log(`[supervisor] ${ok ? "started" : "FAILED to start"} ${tenantId}`);
    failed = failed || !ok;
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }

  // 可观测性：debug API（--port 缺省 8120；只读 /health /state /events /tenants）
  let debugServer: DebugServer | null = null;
  const portRaw = values.port;
  if (portRaw !== undefined) {
    debugServer = new DebugServer({
      repoRoot,
      supervisor,
      port: Number(portRaw),
    });
    await debugServer.listen();
    const addr = debugServer.address();
    console.log(`[supervisor] debug API: http://${addr?.host ?? "127.0.0.1"}:${addr?.port ?? portRaw}`);
  }

  const onSignal = (signal: string): void => {
    console.log(`[supervisor] received ${signal}, shutting down all tenants`);
    void supervisor.shutdown().then(async () => {
      if (debugServer !== null) {
        await debugServer.close();
      }
      console.log("[supervisor] all tenants exited cleanly");
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  // 子进程全部退出（非关闭路径）→ supervisor 跟随退出
  const waitPoll = setInterval(() => {
    if (supervisor.allExited()) {
      clearInterval(waitPoll);
      console.log("[supervisor] all tenants exited");
      process.exitCode = [...supervisor.status()].some((s) => s.exitCode !== 0) ? 1 : 0;
    }
  }, 200);
}

main().catch((error) => {
  console.error(`run-supervisor 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
