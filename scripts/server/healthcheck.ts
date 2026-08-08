#!/usr/bin/env node

import { statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

void main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "http://127.0.0.1:8120/ready" },
      "timeout-ms": { type: "string", default: "5000" },
      "runtime-dir": { type: "string", default: "/var/lib/arena" },
      "min-free-bytes": { type: "string", default: "1073741824" },
      "systemd-unit": { type: "string" },
      "disk-only": { type: "boolean", default: false },
      "skip-disk": { type: "boolean", default: false },
    },
  });

  if (values["disk-only"] && values["skip-disk"]) {
    throw new Error("--disk-only and --skip-disk are mutually exclusive");
  }

  const startedAt = Date.now();
  const timeoutMs = parsePositiveInteger(values["timeout-ms"], "--timeout-ms");
  const minFreeBytes = parseNonNegativeInteger(values["min-free-bytes"], "--min-free-bytes");
  const runtimeDir = resolve(values["runtime-dir"]);
  let endpointBody = null;

  if (!values["disk-only"]) {
    if (values["systemd-unit"] !== undefined) {
      const active = spawnSync(
        "systemctl",
        ["is-active", "--quiet", values["systemd-unit"]],
        { stdio: "ignore" },
      );
      if (active.error !== undefined) {
        throw new Error(`cannot inspect systemd unit ${values["systemd-unit"]}: ${active.error.message}`);
      }
      if (active.signal !== null) {
        throw new Error(`systemctl was terminated by ${active.signal}`);
      }
      if (active.status !== 0) {
        console.log(JSON.stringify({
          ok: true,
          skipped: true,
          reason: "systemd_unit_inactive",
          systemdUnit: values["systemd-unit"],
        }));
        return;
      }
    }

    const response = await fetch(values.url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    try {
      endpointBody = text.length === 0 ? null : JSON.parse(text);
    } catch {
      endpointBody = { raw: text.slice(0, 512) };
    }

    if (!response.ok) {
      throw new Error(`endpoint returned HTTP ${response.status}: ${JSON.stringify(endpointBody)}`);
    }
    if (values.url.endsWith("/ready") && endpointBody?.ready !== true) {
      throw new Error(`readiness body is not ready=true: ${JSON.stringify(endpointBody)}`);
    }
  }

  let freeBytes = null;
  if (!values["skip-disk"]) {
    const stat = statfsSync(runtimeDir);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isSafeInteger(freeBytes) || freeBytes < minFreeBytes) {
      throw new Error(`runtime filesystem free bytes ${freeBytes} below minimum ${minFreeBytes}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    mode: values["disk-only"] ? "disk" : values["skip-disk"] ? "endpoint" : "combined",
    latencyMs: Date.now() - startedAt,
    ...(!values["disk-only"] ? { url: values.url, body: endpointBody } : {}),
    ...(!values["skip-disk"] ? { runtimeDir, freeBytes, minFreeBytes } : {}),
  }));
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
