/**
 * 后台启动 t1 直迁 driver（2026-08-08）：东移突围第一阶段 (-600,-145)。
 *
 * 背景：t1 资源枯竭（calibration 视野 0 RESOURCE 实证），核心被 20+ 敌核环形包围，
 * 东侧（朝 t3 汇合方向）障碍为 0、北侧敌核线在 25+ 格外——东移是最可行出口。
 * 用 --no-survey-obstacles 只用实时视野障碍（避免 survey 累积障碍误导绕障，
 * t1 长距离被带偏 NW 实证）；--force 放行军事审计（枯竭突围是有意识迁移，
 * 目标区新鲜资源 < 8 的"弃富投贫"判据不适用于原地已枯竭场景）。
 * 分阶段：第一阶段 (-600,-145)，抵达后人工确认再推进第二阶段。
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dataRoot = process.env.ARENA_DATA_ROOT ?? resolve(root, "../data");
const logPath = `${dataRoot}/runtime/t1/core-migrate-direct.log`;
const errPath = logPath + ".err";
const log = openSync(logPath, "a");
const err = openSync(errPath, "a");
const child = spawn(
  process.execPath,
  ["--import", "tsx", "packages/arena-agent/scripts/core-migrate-driver.mts",
    "--tenant=t1", "--target-x=-600", "--target-y=-145", "--interval-ms=3000",
    "--max-steps=400", "--beacon-safe=60", "--force", "--no-survey-obstacles"],
  { cwd: root, detached: true, stdio: ["ignore", log, err], windowsHide: true },
);
child.unref();
console.log("PID=" + child.pid);
