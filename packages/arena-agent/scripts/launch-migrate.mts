/** 参数化后台启动 core-migrate-driver v2（2026-08-08，t3/t4 通用）：
 *  从 arena-ts 根运行：npx tsx packages/arena-agent/scripts/launch-migrate.mts
 *  --tenant=t3 --target-x=-537 --target-y=165
 *  日志 → data/runtime/<tenant>/core-migrate-v2.log（追加）。 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

const get = (key: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit?.slice(`--${key}=`.length);
};
const tenant = get("tenant") ?? "t3";
const targetX = get("target-x") ?? "-537";
const targetY = get("target-y") ?? "165";
const root = "ARENA_REPO_ROOT/arena-ts";
const logPath = `ARENA_REPO_ROOT/data/runtime/${tenant}/core-migrate-v2.log`;
const errPath = `${logPath}.err`;
const log = openSync(logPath, "a");
const err = openSync(errPath, "a");
const child = spawn(
  process.execPath,
  [
    "--import", "tsx", "packages/arena-agent/scripts/core-migrate-driver.mts",
    `--tenant=${tenant}`, `--target-x=${targetX}`, `--target-y=${targetY}`,
    "--interval-ms=15000", "--max-steps=500", "--beacon-safe=60",
  ],
  { cwd: root, detached: true, stdio: ["ignore", log, err], windowsHide: true },
);
child.unref();
console.log(`PID=${child.pid} tenant=${tenant} target=(${targetX},${targetY}) log=${logPath}`);