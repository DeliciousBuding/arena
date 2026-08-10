/** Multi-tenant process supervisor CLI. Debug port is bound before any child spawn. */

import { parseArgs } from "node:util";
import { TenantSupervisor } from "../app/tenant-supervisor.ts";
import { DebugServer } from "../app/debug-server.ts";
import { loadDotEnv } from "../app/dotenv.ts";
import { resolveArenaDataRoot } from "../app/data-root.ts";
import { createCentralAllianceShadowRuntime, type CentralAllianceShadowRuntime } from "../alliance/runtime/central-shadow-runtime.ts";
import { ALLIANCE_ROSTER_SCHEMA, writeAllianceRosterFile } from "../alliance/roster-file.ts";

const ENV_DEFAULTS = {
  "repo-root": "ARENA_REPO_ROOT",
  "data-root": "ARENA_DATA_ROOT",
  "config-dir": "ARENA_CONFIG_DIR",
  "runtime-dir": "ARENA_RUNTIME_DIR",
  configs: "ARENA_CONFIGS",
  "live-ticks": "ARENA_LIVE_TICKS",
  "max-ticks": "ARENA_MAX_TICKS",
  "startup-sync-ticks": "ARENA_STARTUP_SYNC_TICKS",
  "alliance-shadow-interval-ticks": "ARENA_ALLIANCE_SHADOW_INTERVAL_TICKS",
  "alliance-director-period-ticks": "ARENA_ALLIANCE_DIRECTOR_PERIOD_TICKS",
  "alliance-director-max-skew-ticks": "ARENA_ALLIANCE_DIRECTOR_MAX_SKEW_TICKS",
  "alliance-strategy-profile": "ARENA_ALLIANCE_STRATEGY_PROFILE",
  "shutdown-timeout-ms": "ARENA_SHUTDOWN_TIMEOUT_MS",
  port: "ARENA_DEBUG_PORT",
  "debug-host": "ARENA_DEBUG_HOST",
  "respawn-limit": "ARENA_RESPAWN_LIMIT",
  "respawn-delay-ms": "ARENA_RESPAWN_DELAY_MS",
} as const;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "repo-root": { type: "string" },
      "data-root": { type: "string" },
      "config-dir": { type: "string" },
      "runtime-dir": { type: "string" },
      configs: { type: "string" },
      live: { type: "boolean" },
      shadow: { type: "boolean" },
      mode: { type: "string" },
      "live-ticks": { type: "string" },
      "max-ticks": { type: "string" },
      "startup-sync-ticks": { type: "string" },
      "record-calibration": { type: "boolean" },
      "record-alliance-shadow": { type: "boolean" },
      "alliance-shadow-interval-ticks": { type: "string" },
      "alliance-director-shadow": { type: "boolean" },
      "alliance-director-period-ticks": { type: "string" },
      "alliance-director-max-skew-ticks": { type: "string" },
      "alliance-strategy-profile": { type: "string" },
      "shutdown-timeout-ms": { type: "string" },
      port: { type: "string" },
      "debug-host": { type: "string" },
      "respawn-limit": { type: "string" },
      "respawn-delay-ms": { type: "string" },
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
  const dataRoot = resolveArenaDataRoot(repoRoot, values["data-root"], process.env.ARENA_DATA_ROOT);
  const configNames = (option("configs") ?? "t1,t2,t3,t4")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => name.endsWith(".json") ? name : `${name}.json`);

  const serviceMode = values.shadow ? "shadow" : values.live ? "live" : process.env.ARENA_SERVICE_MODE;
  const tenantArgs: string[] = [];
  // 决策模式：显式 CLI --mode 优先；其次 ARENA_DECISION_MODE env（生产切
  // Pi agent 用）；否则 live/shadow 沿用确定性兜底（历史行为，向后兼容）。
  const decisionMode = values.mode ?? process.env.ARENA_DECISION_MODE ?? "deterministic";
  if (serviceMode === "shadow") tenantArgs.push(`--mode=${decisionMode}`, "--shadow");
  if (serviceMode === "live") tenantArgs.push(`--mode=${decisionMode}`, "--live");
  // S8b 旁路 Runtime-Golden：仅 live 有效（run-tenant 门禁），透传给每个 child
  if (values["record-calibration"] === true) tenantArgs.push("--record-calibration");
  // Alliance observation shadow: default-off, read-only, no action ownership.
  const allianceShadowEnabled = values["record-alliance-shadow"] === true
    || /^(1|true)$/i.test(process.env.ARENA_RECORD_ALLIANCE_SHADOW ?? "");
  if (allianceShadowEnabled) tenantArgs.push("--record-alliance-shadow");
  const allianceShadowInterval = option("alliance-shadow-interval-ticks");
  if (allianceShadowInterval !== undefined) {
    const value = Number(allianceShadowInterval);
    if (!Number.isInteger(value) || value < 1) throw new Error(`--alliance-shadow-interval-ticks has invalid value: ${allianceShadowInterval}`);
    if (!allianceShadowEnabled) throw new Error("--alliance-shadow-interval-ticks requires --record-alliance-shadow");
    tenantArgs.push(`--alliance-shadow-interval-ticks=${allianceShadowInterval}`);
  }
  // Central Alliance Director v3 remains observation/ASSIST-only. It requires full shadow frames.
  const allianceDirectorEnabled = values["alliance-director-shadow"] === true
    || /^(1|true)$/i.test(process.env.ARENA_ALLIANCE_DIRECTOR_SHADOW ?? "");
  if (allianceDirectorEnabled && !allianceShadowEnabled) {
    throw new Error("--alliance-director-shadow requires --record-alliance-shadow");
  }
  const directorPeriodRaw = option("alliance-director-period-ticks");
  const directorSkewRaw = option("alliance-director-max-skew-ticks");
  const allianceStrategyProfile = option("alliance-strategy-profile");
  if (!allianceDirectorEnabled && (directorPeriodRaw !== undefined || directorSkewRaw !== undefined)) {
    throw new Error("Alliance Director timing options require --alliance-director-shadow");
  }
  if (!allianceDirectorEnabled && allianceStrategyProfile !== undefined) {
    throw new Error("Alliance strategy profile requires --alliance-director-shadow");
  }
  const allianceDirectorPeriodTicks = parseInteger(directorPeriodRaw, 4, 1, "--alliance-director-period-ticks");
  const allianceDirectorMaxSkewTicks = parseInteger(directorSkewRaw, 4, 0, "--alliance-director-max-skew-ticks");
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
  const respawnLimit = parseInteger(option("respawn-limit"), 10, 1, "--respawn-limit");
  const respawnDelayMs = parseInteger(option("respawn-delay-ms"), 5000, 100, "--respawn-delay-ms");
  let centralAlliance: CentralAllianceShadowRuntime | null = null;
  const supervisor = new TenantSupervisor({
    repoRoot,
    dataRoot,
    ...(option("config-dir") !== undefined ? { configRoot: option("config-dir") } : {}),
    ...(option("runtime-dir") !== undefined ? { runtimeRoot: option("runtime-dir") } : {}),
    configs: configNames,
    tenantArgs,
    shutdownTimeoutMs,
    respawnLimit,
    respawnDelayMs,
    onChildMessage: (tenantId, message) => centralAlliance?.onChildMessage(tenantId, message),
    onEvent: (event) => {
      console.log(`[supervisor] ${event.at} ${event.type} ${event.tenantId}${event.detail ? `: ${event.detail}` : ""}`);
    },
  });
  const unavailableStrategyResult = () => ({
    accepted: false as const,
    error: "Alliance strategic runtime is not initialized",
    strategy: { available: false, mode: "ASSIST_ONLY", actionOwnership: "none" },
  });
  const debugServer = new DebugServer({
    repoRoot,
    supervisor,
    allianceDirectorView: () => centralAlliance?.view() ?? {
      enabled: false, mode: "ASSIST_ONLY", actionOwnership: "none", available: false,
    },
    ...(allianceDirectorEnabled ? {
      allianceStrategyControl: {
        view: () => centralAlliance?.view().strategy ?? { available: false, mode: "ASSIST_ONLY", actionOwnership: "none" },
        requestProfile: (name: string) => centralAlliance?.requestStrategicProfile(name) ?? unavailableStrategyResult(),
        requestRollback: () => centralAlliance?.requestStrategicRollback() ?? unavailableStrategyResult(),
        markLastGood: () => centralAlliance?.markStrategicLastGood() ?? unavailableStrategyResult(),
      },
    } : {}),
    port,
    ...(option("debug-host") !== undefined ? { host: option("debug-host") } : {}),
  });

  // Port conflicts must fail with zero spawned tenant processes.
  await debugServer.listen();
  const addr = debugServer.address();
  console.log(`[supervisor] debug API: http://${addr?.host ?? "127.0.0.1"}:${addr?.port ?? port}`);

  if (allianceDirectorEnabled) {
    // Preflight happens only after the debug port is bound, preserving the existing zero-child
    // behavior on port conflict. The Director itself has no Arena credentials or writer path.
    const expectedTenants = supervisor.preflight().map((spec) => spec.tenantId);
    centralAlliance = createCentralAllianceShadowRuntime({
      enabled: true,
      expectedTenants,
      periodTicks: allianceDirectorPeriodTicks,
      maxSkewTicks: allianceDirectorMaxSkewTicks,
      ...(allianceStrategyProfile !== undefined ? { initialStrategicProfile: allianceStrategyProfile } : {}),
      send: (tenantId, message) => supervisor.sendToTenant(tenantId, message),
    });
    console.log(`[supervisor] Alliance Director shadow enabled: tenants=${expectedTenants.join(",")} period=${allianceDirectorPeriodTicks} skew<=${allianceDirectorMaxSkewTicks} strategy=${allianceStrategyProfile ?? "balanced"} actionOwnership=none`);
  }

  // 联盟 no-fire roster 落盘（2026-08-08，alliance-no-fire-v1）：每次 director
  // 快照 revision 变化即原子写 <dataRoot>/runtime/alliance/roster.json，供各
  // 租户进程读取做 no-fire 过滤。ASSIST_ONLY（actionOwnership=none）不改变任何
  // 租户动作，只是把"已知联盟受控实体 id"共享给执行面。5s 轮询足够（director
  // 周期 4 tick ≈ 40-60s；轮询仅比较 revision，零 I/O 压力）。
  let lastWrittenRosterRevision = -1;
  const rosterWriteTimer = setInterval(() => {
    const snap = centralAlliance?.view().snapshot ?? null;
    if (snap === null || snap.revision === lastWrittenRosterRevision) return;
    lastWrittenRosterRevision = snap.revision;
    try {
      writeAllianceRosterFile(dataRoot, {
        schema: ALLIANCE_ROSTER_SCHEMA,
        revision: snap.revision,
        updatedAtMs: Date.now(),
        allyEntityIds: snap.allyEntityIds,
      });
      console.log(`[supervisor] alliance roster written revision=${snap.revision} ids=${snap.allyEntityIds.length}`);
    } catch (error) {
      console.error(`[supervisor] alliance roster write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 5000);

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
