#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const systemdDir = join(root, "deploy", "systemd");
const shadowUnit = read("arena-supervisor-shadow.service");
const liveUnit = read("arena-supervisor-live.service");
const shadowHealth = read("arena-shadow-health.service");
const liveHealth = read("arena-live-health.service");
const diskHealth = read("arena-disk-health.service");
const envExample = read("arena.env.example");
const supervisorCli = readFileSync(
  join(root, "packages", "arena-agent", "src", "cli", "run-supervisor.ts"),
  "utf-8",
);
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf-8"));
const piUndiciVersion = packageLock.packages?.[
  "node_modules/@earendil-works/pi-coding-agent/node_modules/undici"
]?.version;

mustContain(shadowUnit, "Restart=on-failure", "shadow service must auto-recover bounded failures");
mustContain(shadowUnit, "RestartPreventExitStatus=64 78", "shadow wrapper errors must not restart-loop");
mustContain(liveUnit, "Restart=no", "live service must not auto-restart before durable idempotency");
mustNotContain(liveUnit, "Restart=on-failure", "live service must not inherit shadow restart policy");
for (const [name, unit] of [["shadow", shadowUnit], ["live", liveUnit]]) {
  mustContain(unit, "docker compose -f /opt/arena/current/deploy/docker/arena-compose.yml up --abort-on-container-exit --exit-code-from", `${name} service must propagate container exit codes to systemd`);
  mustContain(unit, "docker compose -f /opt/arena/current/deploy/docker/arena-compose.yml down", `${name} service must stop the Docker container`);
  mustContain(unit, "EnvironmentFile=/etc/arena/arena.env", `${name} service must use external secrets`);
}
mustContain(shadowHealth, "OnFailure=arena-shadow-recover.service", "shadow readiness failures must recover");
mustContain(liveHealth, "OnFailure=arena-live-alert.service", "live readiness failures must alert only");
mustContain(shadowHealth, "check-readiness.sh arena-supervisor-shadow.service shadow", "shadow timer must probe the shadow container");
mustContain(liveHealth, "check-readiness.sh arena-supervisor-live.service live", "live timer must probe the live container");
mustNotContain(shadowHealth, "EnvironmentFile=/etc/arena/arena.env", "shadow health must not receive tenant secrets");
mustNotContain(liveHealth, "EnvironmentFile=/etc/arena/arena.env", "live health must not receive tenant secrets");
mustContain(shadowHealth, "EnvironmentFile=-/etc/arena/health.env", "shadow health must read non-secret settings");
mustContain(liveHealth, "EnvironmentFile=-/etc/arena/health.env", "live health must read non-secret settings");
mustContain(diskHealth, "OnFailure=arena-disk-alert.service", "disk pressure must alert without restarting writers");
mustContain(diskHealth, "check-disk.sh", "disk health must run the host-side disk gate");
mustContain(diskHealth, "EnvironmentFile=-/etc/arena/health.env", "disk health must use non-secret settings");
mustNotContain(diskHealth, "--systemd-unit", "disk health must run even when supervisors are inactive");
mustNotContain(diskHealth, "/etc/arena/arena.env", "disk health must not inherit tenant secrets");
mustContain(shadowUnit, "EnvironmentFile=/etc/arena/arena.env", "shadow supervisor must receive secrets");
mustContain(shadowUnit, "EnvironmentFile=-/etc/arena/health.env", "shadow supervisor must share health settings");
mustContain(liveUnit, "EnvironmentFile=/etc/arena/arena.env", "live supervisor must receive secrets");
mustContain(liveUnit, "EnvironmentFile=-/etc/arena/health.env", "live supervisor must share health settings");
// Native supervisor CLI contract (packages/arena-agent/src/cli/run-supervisor.ts).
// No bash wrapper: the container entrypoint and local dev both run this file, and
// server settings flow through ARENA_* env vars (CLI args override env when given).
mustContain(supervisorCli, "ARENA_SERVICE_MODE", "supervisor CLI must accept the service-mode env var");
mustContain(supervisorCli, 'process.env[ENV_DEFAULTS[key]]', "supervisor CLI must read ARENA_* env vars");
mustContain(supervisorCli, '"--mode=deterministic"', "server supervisor must stay deterministic");
mustContain(supervisorCli, '"--shadow"', "shadow mode must be explicit");
mustContain(supervisorCli, '"--live"', "live mode must be explicit");
mustContain(supervisorCli, "ARENA_LIVE_TICKS", "canary window must be env-driven");
mustContain(supervisorCli, "ARENA_MAX_TICKS", "max ticks must be env-driven");
mustNotContain(supervisorCli, "run-supervisor.sh", "CLI must not depend on a bash wrapper");
mustNotContain(supervisorCli, "npm run arena:supervisor", "CLI must not add an npm process layer");

// Docker deployment contract (deploy/docker). The image must not carry secrets;
// the compose file must keep shadow auto-recoverable and live manual-only.
const dockerDir = join(root, "deploy", "docker");
const dockerfile = readFileSync(join(dockerDir, "Dockerfile"), "utf-8");
const compose = readFileSync(join(dockerDir, "arena-compose.yml"), "utf-8");
const arenaEnvExample = readFileSync(join(systemdDir, "arena.env.example"), "utf-8");

mustContain(dockerfile, "FROM node:24-slim", "image must pin Node 24 LTS");
mustContain(dockerfile, "USER arena:arena", "image must not run as root");
mustContain(dockerfile, "ENTRYPOINT", "image must use the native TS supervisor entrypoint");
mustNotContain(dockerfile, "ARENA_HERO_API_KEY", "image must not embed tenant secrets");
mustContain(compose, 'env_file:\n      - /etc/arena/arena.env', "compose must inject secrets from host file only");
mustContain(compose, "read_only: true", "compose must keep the root filesystem read-only");
mustContain(compose, "cap_drop:\n      - ALL", "compose must drop all capabilities");
mustContain(compose, "no-new-privileges:true", "compose must block privilege escalation");
mustContain(compose, "restart: \"no\"", "compose must defer restart policy to systemd units");
mustContain(compose, "user: \"1001:1001\"", "container must run as the arena uid");
mustContain(compose, "ARENA_DEBUG_HOST", "compose must allow loopback-exposed debug host inside container");
mustContain(compose, "127.0.0.1:8120:8120", "debug API must bind loopback only");
mustContain(compose, "--skip-disk", "container healthcheck must not own the disk gate");
mustNotContain(compose, "ARENA_HERO_API_KEY", "compose must not inline tenant secrets");

// Rollback helper contract (deploy/docker/rollback.sh): dry-run default, GHCR
// tag verification, compose backup, and post-restart image verification.
const rollbackScript = readFileSync(join(dockerDir, "rollback.sh"), "utf-8");
mustContain(rollbackScript, "--apply", "rollback must refuse to mutate without --apply");
mustContain(rollbackScript, "docker manifest inspect", "rollback must verify the tag exists in GHCR before mutating");
mustContain(rollbackScript, "cp -p \"$compose\" \"$backup\"", "rollback must back up the compose file before editing");
mustContain(rollbackScript, "docker inspect --format", "rollback must verify the container image after restart");
if (typeof piUndiciVersion !== "string") {
  throw new Error("cannot resolve pi-coding-agent nested undici version from package-lock.json");
}
if (compareVersions(piUndiciVersion, "8.9.0") < 0) {
  mustNotContain(supervisorCli, "--mode=agent-shadow", "vulnerable Pi HTTP stack must not be enabled by server units");
  mustNotContain(supervisorCli, "--mode=hybrid", "vulnerable Pi HTTP stack must not be enabled by server units");
  mustNotContain(compose, "agent-shadow", "vulnerable Pi HTTP stack must not be enabled by compose");
  mustNotContain(compose, "hybrid", "vulnerable Pi HTTP stack must not be enabled by compose");
}
if (/^ARENA_HERO_API_KEY_\d+=\S+/m.test(envExample)) {
  throw new Error("arena.env.example must not contain tenant secret values");
}

const runtimeDir = mkdtempSync(join(tmpdir(), "arena-health-"));
let ready = true;
const server = createServer((_req, res) => {
  res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ready }));
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("health test server did not bind TCP");
const url = `http://127.0.0.1:${address.port}/ready`;

try {
  const healthy = await runHealth(url, runtimeDir, "0");
  if (healthy.code !== 0) throw new Error(`healthy probe failed: ${healthy.stderr}`);
  const parsed = JSON.parse(healthy.stdout.trim());
  if (parsed.ok !== true || parsed.freeBytes < 0) throw new Error("healthy probe returned invalid JSON");

  ready = false;
  const unready = await runHealth(url, runtimeDir, "0", ["--skip-disk"]);
  if (unready.code === 0 || !unready.stderr.includes("HTTP 503")) {
    throw new Error(`unready probe did not fail closed: ${unready.stderr}`);
  }

  ready = true;
  const lowDisk = await runHealth(url, runtimeDir, String(Number.MAX_SAFE_INTEGER), ["--disk-only"]);
  if (lowDisk.code === 0 || !lowDisk.stderr.includes("below minimum")) {
    throw new Error(`disk budget probe did not fail closed: ${lowDisk.stderr}`);
  }
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(runtimeDir, { recursive: true, force: true });
}

console.log("server deployment checks passed");

function read(name) {
  return readFileSync(join(systemdDir, name), "utf-8");
}

function mustContain(text, expected, message) {
  if (!text.includes(expected)) throw new Error(`${message}: missing ${expected}`);
}

function mustNotContain(text, unexpected, message) {
  if (text.includes(unexpected)) throw new Error(`${message}: found ${unexpected}`);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  if ([...leftParts, ...rightParts].some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error(`invalid numeric version comparison: ${left} vs ${right}`);
  }
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function runHealth(url, runtimeDir, minFreeBytes, extraArgs = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      join(root, "scripts", "server", "healthcheck.mjs"),
      `--url=${url}`,
      "--timeout-ms=2000",
      `--runtime-dir=${runtimeDir}`,
      `--min-free-bytes=${minFreeBytes}`,
      ...extraArgs,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}
