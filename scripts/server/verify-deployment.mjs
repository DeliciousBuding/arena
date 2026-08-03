#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
const wrapperPath = join(root, "scripts", "server", "run-supervisor.sh");
const wrapper = readFileSync(wrapperPath, "utf-8");
const envExample = read("arena.env.example");

mustContain(shadowUnit, "Restart=on-failure", "shadow service must auto-recover bounded failures");
mustContain(shadowUnit, "RestartPreventExitStatus=64 78", "shadow wrapper errors must not restart-loop");
mustContain(liveUnit, "Restart=no", "live service must not auto-restart before durable idempotency");
mustNotContain(liveUnit, "Restart=on-failure", "live service must not inherit shadow restart policy");
for (const [name, unit] of [["shadow", shadowUnit], ["live", liveUnit]]) {
  mustContain(unit, "KillMode=control-group", `${name} service must own the full process tree`);
  mustContain(unit, "ProtectSystem=strict", `${name} service must keep the release immutable`);
  mustContain(unit, "EnvironmentFile=/etc/arena/arena.env", `${name} service must use external secrets`);
}
mustContain(shadowHealth, "OnFailure=arena-shadow-recover.service", "shadow readiness failures must recover");
mustContain(liveHealth, "OnFailure=arena-live-alert.service", "live readiness failures must alert only");
mustContain(shadowHealth, "--systemd-unit=arena-supervisor-shadow.service", "shadow timer must skip inactive service");
mustContain(liveHealth, "--systemd-unit=arena-supervisor-live.service", "live timer must skip inactive service");
mustNotContain(shadowHealth, "EnvironmentFile=/etc/arena/arena.env", "shadow health must not receive tenant secrets");
mustNotContain(liveHealth, "EnvironmentFile=/etc/arena/arena.env", "live health must not receive tenant secrets");
mustContain(shadowHealth, "EnvironmentFile=-/etc/arena/health.env", "shadow health must read non-secret settings");
mustContain(liveHealth, "EnvironmentFile=-/etc/arena/health.env", "live health must read non-secret settings");
mustContain(shadowUnit, "EnvironmentFile=/etc/arena/arena.env", "shadow supervisor must receive secrets");
mustContain(shadowUnit, "EnvironmentFile=-/etc/arena/health.env", "shadow supervisor must share health settings");
mustContain(liveUnit, "EnvironmentFile=/etc/arena/arena.env", "live supervisor must receive secrets");
mustContain(liveUnit, "EnvironmentFile=-/etc/arena/health.env", "live supervisor must share health settings");
mustContain(wrapper, '"--config-dir=$config_dir"', "wrapper must use external configs");
mustContain(wrapper, '"--runtime-dir=$runtime_dir"', "wrapper must use external runtime state");
mustContain(wrapper, 'args+=("--mode=deterministic" "--live")', "live wrapper must pin deterministic mode");
mustContain(wrapper, 'exec "$tsx_bin" packages/arena-agent/src/cli/run-supervisor.ts', "wrapper must exec the native TS entry directly");
mustNotContain(wrapper, "npm run arena:supervisor", "server wrapper must not add an npm process layer");
if (/^ARENA_HERO_API_KEY_\d+=\S+/m.test(envExample)) {
  throw new Error("arena.env.example must not contain tenant secret values");
}

if (process.platform !== "win32") {
  const syntax = spawnSync("bash", ["-n", wrapperPath], { encoding: "utf-8" });
  if (syntax.status !== 0) throw new Error(`run-supervisor.sh syntax invalid: ${syntax.stderr}`);
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
  const unready = await runHealth(url, runtimeDir, "0");
  if (unready.code === 0 || !unready.stderr.includes("HTTP 503")) {
    throw new Error(`unready probe did not fail closed: ${unready.stderr}`);
  }

  ready = true;
  const lowDisk = await runHealth(url, runtimeDir, String(Number.MAX_SAFE_INTEGER));
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

function runHealth(url, runtimeDir, minFreeBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      join(root, "scripts", "server", "healthcheck.mjs"),
      `--url=${url}`,
      "--timeout-ms=2000",
      `--runtime-dir=${runtimeDir}`,
      `--min-free-bytes=${minFreeBytes}`,
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
