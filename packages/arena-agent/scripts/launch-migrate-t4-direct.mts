/** t4 东迁朝 t3 汇合方向（2026-08-08）：第一阶段 (100,360)，走廊无敌核已验证。
 *  t4 原地贫矿（res=0），东迁找新矿/与 t3 新核(159,516) 汇合。弱核 3 worker 护核，
 *  分阶段小步走。 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
const root = process.cwd();
const logPath = "D:/Code/Projects/arena/data/runtime/t4/core-migrate-direct.log";
const errPath = logPath + ".err";
const log = openSync(logPath, "a");
const err = openSync(errPath, "a");
const child = spawn(
  process.execPath,
  ["--import", "tsx", "packages/arena-agent/scripts/core-migrate-driver.mts",
    "--tenant=t4", "--target-x=100", "--target-y=360", "--interval-ms=3000",
    "--max-steps=600", "--beacon-safe=60", "--force", "--no-survey-obstacles"],
  { cwd: root, detached: true, stdio: ["ignore", log, err], windowsHide: true },
);
child.unref();
console.log("PID=" + child.pid);
