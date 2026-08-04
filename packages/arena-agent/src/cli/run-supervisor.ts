/** Four-tenant process supervisor CLI. Debug port is bound before any child spawn. */

import { parseArgs } from "node:util";
import { TenantSupervisor } from "../app/tenant-supervisor.ts";
import { DebugServer } from "../app/debug-server.ts";
import { loadDotEnv } from "../app/dotenv.ts";

const ENV_DEFAULTS = {
  "repo-root": "ARENA_REPO_ROOT",
  "config-dir": "ARENA_CONFIG_DIR",
  "runtime-dir": "ARENA_RUNTIME_DIR",
  configs: "ARENA_CONFIGS",
  "live-ticks": "ARENA_LIVE_TICKS",
  "max-ticks": "ARENA_MAX_TICKS",
  "startup-sync-ticks": "ARENA_STARTUP_SYNC_TICKS",
  "shutdown-timeout-ms": "ARENA_SHUTDOWN_TIMEOUT_MS",
  port: "ARENA_DEBUG_PORT",
  "debug-host": "ARENA_DEBUG_HOST",
} as const;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "repo-root": { type: "string" },
      "config-dir": { type: "string" },
      "runtime-dir": { type: "string" },
      configs: { type: "string" },
      live: { type: "boolean" },
      shadow: { type: "boolean" },
      mode: { type: "string" },
      "live-ticks": { type: "string" },
      "max-ticks": { type: "string" },
      "startup-sync-ticks": { type: "string" },
      "shutdown-timeout-ms": { type: "string" },
      port: { type: "string" },
      "debug-host": { type: "string" },
    },
  });

  // CLI 参数优先，其次 ARENA_* 环境变量（容器/服务器注入），最后内置默认。
  // 同一份代码同时服务本地开发与 Docker 部署，不再需要 bash 胶水层。
  // 空字符串 env（compose ${VAR:-} 缺省展开）视为未设置。
  const option = (key: keyof typeof ENV_DEFAULTS): string | undefined => {
    const raw = values[key] ?? process.env[ENV_DEFAULTS[key]];
    return raw === undefined || raw === "" ? undefined : raw;
  };

  if (values.live && values.shadow) throw new Error("--live and --shadow are mutually exclusive");
  const repoRoot = option("repo-root") ?? process.cwd();
  loadDotEnv(repoRoot);
  const configNames = (option("configs") ?? "t1,t2,t3,t4")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => name.endsWith(".json") ? name : `${name}.json`);

  const serviceMode = values.shadow ? "shadow" : values.live ? "live" : process.env.ARENA_SERVICE_MODE;
  const tenantArgs: string[] = [];
  if (serviceMode === "shadow") tenantArgs.push("--mode=deterministic", "--shadow");
  if (serviceMode === "live") tenantArgs.push("--mode=deterministic", "--live");
  if (values.mode !== undefined) tenantArgs.push(`--mode=${values.mode}`);
  for (const [key, flag] of [
    ["live-ticks", "--live-ticks"],
    ["max-ticks", "--max-ticks"],
    ["startup-sync-ticks", "--startup-sync-ticks"],
  ] as const) {
    const raw = option(key);
    if (raw !== undefined) {
      const number = Number(raw);
      const minimum = key === "startup-sync-ticks" ? 0 : 1;
      if (!Number.isInteger(number) || number < minimum) throw new Error(`${flag} has invalid value: ${raw}`);
      tenantArgs.push(`${flag}=${raw}`);
    }
  }

  const shutdownTimeoutMs = parseInteger(option("shutdown-timeout-ms"), 8000, 1, "--shutdown-timeout-ms");
  const port = parseInteger(option("port"), 8120, 0, "--port");
  const supervisor = new TenantSupervisor({
    repoRoot,
    ...(option("config-dir") !== undefined ? { configRoot: option("config-dir") } : {}),
    ...(option("runtime-dir") !== undefined ? { runtimeRoot: option("runtime-dir") } : {}),
    configs: configNames,
    tenantArgs,
    shutdownTimeoutMs,
    onEvent: (event) => {
      console.log(`[supervisor] ${event.at} ${event.type} ${event.tenantId}${event.detail ? `: ${event.detail}` : ""}`);
    },
  });
  const debugServer = new DebugServer({
    repoRoot,
    supervisor,
    port,
    ...(option("debug-host") !== undefined ? { host: option("debug-host") } : {}),
  });

  // Port conflicts must fail with zero spawned tenant processes.
  await debugServer.listen();
  const addr = debugServer.address();
  console.log(`[supervisor] debug API: http://${addr?.host ?? "127.0.0.1"}:${addr?.port ?? port}`);

  let signalResolve: ((signal: string) => void) | null = null;
  const signalPromise = new Promise<string>((resolve) => { signalResolve = resolve; });
  const onSigint = (): void => signalResolve?.("SIGINT");
  const onSigterm = (): void => signalResolve?.("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await supervisor.start();
    const outcome = await Promise.race([
      supervisor.waitForAllExited().then(() => "children_exited" as const),
      signalPromise,
    ]);
    if (outcome !== "children_exited") {
      console.log(`[supervisor] received ${outcome}, shutting down all tenants`);
      await supervisor.shutdown();
    }
    const failed = supervisor.status().some((status) => status.lifecycle === "failed" || status.exitCode !== 0);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    await supervisor.shutdown().catch(() => {});
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await debugServer.close().catch(() => {});
  }
}

function parseInteger(raw: string | undefined, fallback: number, minimum: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} has invalid value: ${raw}`);
  return value;
}

void main().catch((error) => {
  console.error(`run-supervisor 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
