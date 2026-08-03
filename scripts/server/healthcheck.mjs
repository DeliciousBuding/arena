#!/usr/bin/env node

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { statfsSync } from "node:fs";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8120/ready" },
    "timeout-ms": { type: "string", default: "5000" },
    "runtime-dir": { type: "string", default: "/var/lib/arena" },
    "min-free-bytes": { type: "string", default: "1073741824" },
    "systemd-unit": { type: "string" },
  },
});

const timeoutMs = parsePositiveInteger(values["timeout-ms"], "--timeout-ms");
const minFreeBytes = parseNonNegativeInteger(values["min-free-bytes"], "--min-free-bytes");
const runtimeDir = resolve(values["runtime-dir"]);
const startedAt = Date.now();

try {
  if (values["systemd-unit"] !== undefined) {
    const active = spawnSync(
      "systemctl",
      ["is-active", "--quiet", values["systemd-unit"]],
      { stdio: "ignore" },
    );
    if (active.error !== undefined) {
      throw new Error(`cannot inspect systemd unit ${values["systemd-unit"]}: ${active.error.message}`);
    }
    if (active.status !== 0) {
      console.log(JSON.stringify({
        ok: true,
        skipped: true,
        reason: "systemd_unit_inactive",
        systemdUnit: values["systemd-unit"],
      }));
      process.exit(0);
    }
  }

  const response = await fetch(values.url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 512) };
  }

  if (!response.ok) {
    throw new Error(`endpoint returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  if (values.url.endsWith("/ready") && body?.ready !== true) {
    throw new Error(`readiness body is not ready=true: ${JSON.stringify(body)}`);
  }

  const stat = statfsSync(runtimeDir);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < minFreeBytes) {
    throw new Error(`runtime filesystem free bytes ${freeBytes} below minimum ${minFreeBytes}`);
  }

  console.log(JSON.stringify({
    ok: true,
    url: values.url,
    latencyMs: Date.now() - startedAt,
    runtimeDir,
    freeBytes,
    minFreeBytes,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    url: values.url,
    latencyMs: Date.now() - startedAt,
    runtimeDir,
    minFreeBytes,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}

function parsePositiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a safe integer >= 1; actual=${raw}`);
  }
  return value;
}

function parseNonNegativeInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe integer >= 0; actual=${raw}`);
  }
  return value;
}
