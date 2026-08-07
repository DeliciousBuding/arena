/** 后台启动 core-migrate-driver v2：node --import tsx 运行（与 supervisor 同款）。 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

const root = process.cwd();
const logPath = "ARENA_REPO_ROOT/data/runtime/t4/core-migrate-v2.log";
const errPath = logPath + ".err";
const log = openSync(logPath, "a");
const err = openSync(errPath, "a");
const child = spawn(
  process.execPath,
  ["--import", "tsx", "packages/arena-agent/scripts/core-migrate-driver.mts",
    "--tenant=t4", "--target-x=300", "--target-y=-150", "--interval-ms=15000", "--max-steps=500", "--beacon-safe=60"],
  { cwd: root, detached: true, stdio: ["ignore", log, err], windowsHide: true },
);
child.unref();
console.log("PID=" + child.pid);
