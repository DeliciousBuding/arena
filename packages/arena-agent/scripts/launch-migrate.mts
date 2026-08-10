/** 参数化后台启动 core-migrate-driver v2（2026-08-08，t3/t4 通用）：
 *  从 arena-ts 根运行：npx tsx packages/arena-agent/scripts/launch-migrate.mts
 *  --tenant=t3 --target-x=-537 --target-y=165
 *  日志 → data/runtime/<tenant>/core-migrate-v2.log（追加）。 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";

const get = (key: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit?.slice(`--${key}=`.length);
};
const tenant = get("tenant") ?? "t3";
const targetX = get("target-x") ?? "-537";
const targetY = get("target-y") ?? "165";
// max-steps 默认 2000（~100 格距离 + 绕障 2-3 倍路径足够；固定 500 步会让
// t4 这类远距离迁移在半路退出清命令）。可用 --max-steps= 覆盖。
const root = resolve(import.meta.dirname, "../../..");
const dataRoot = process.env.ARENA_DATA_ROOT ?? resolve(import.meta.dirname, "../../../..");
const logPath = `${dataRoot}/runtime/${tenant}/core-migrate-v2.log`;
const errPath = `${logPath}.err`;
const log = openSync(logPath, "a");
const err = openSync(errPath, "a");
const child = spawn(
  process.execPath,
  [
    "--import", "tsx", "packages/arena-agent/scripts/core-migrate-driver.mts",
    `--tenant=${tenant}`, `--target-x=${targetX}`, `--target-y=${targetY}`,
    "--interval-ms=15000", "--max-steps=2000", "--beacon-safe=60",
  ],
  { cwd: root, detached: true, stdio: ["ignore", log, err], windowsHide: true },
);
child.unref();
console.log(`PID=${child.pid} tenant=${tenant} target=(${targetX},${targetY}) log=${logPath}`);