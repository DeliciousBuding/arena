/**
 * Arena 指挥面板启动器（start-cc.mjs）— 随用随起，无计划任务/管理员。
 *
 * 用法（在 packages/command-center 下）：
 *   node scripts/start-cc.mjs            前台启动：当前终端可见日志，同时落 logs/cc-server.log
 *   node scripts/start-cc.mjs --hidden   后台启动：无终端窗口，日志落 logs/cc-server.log（写 pid）
 *   node scripts/start-cc.mjs --stop     停止上次 --hidden 启动的实例（读 pid 文件）
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CC = resolve(HERE, "..");
const LOGS = join(CC, "logs");
mkdirSync(LOGS, { recursive: true });
const SERVER = join(CC, "server.mjs");
const LOG = join(LOGS, "cc-server.log");
const PID = join(LOGS, "cc-server.pid");
const PORT = process.env.COMMAND_CENTER_PORT ?? "8787";

const hidden = process.argv.includes("--hidden");
const stop = process.argv.includes("--stop");

function stamp() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

/** 端口占用预检：GET /api/overview 200 即认为已有实例在服务。 */
async function portBusy(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 600);
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

if (stop) {
  if (existsSync(PID)) {
    const pid = Number(String(readFileSync(PID, "utf8")).trim());
    try { process.kill(pid); console.log(`已停止指挥面板服务 (pid ${pid})`); }
    catch { console.log("该进程已不在运行"); }
    try { rmSync(PID); } catch { /* 忽略 */ }
  } else {
    console.log("没有正在运行的 --hidden 实例（无 pid 文件）。前台实例请直接 Ctrl+C。");
  }
  process.exit(0);
}

const env = { ...process.env, COMMAND_CENTER_PORT: PORT };

if (hidden) {
  if (await portBusy(PORT)) {
    console.error(`端口 ${PORT} 已有指挥面板实例在服务——拒绝双开（防双写/pid 混乱）。`);
    console.error(`  停止旧实例：node scripts/start-cc.mjs --stop；若 pid 文件陈旧，先删 logs/cc-server.pid 再启动。`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [SERVER], {
    cwd: CC, env, stdio: "ignore", detached: true, windowsHide: true,
  });
  child.unref();
  try { writeFileSync(PID, String(child.pid)); } catch { /* 忽略 */ }
  // 启动自检：800ms 后确认子进程存活且端口响应；失败则清 pid 并提示（避免陈旧 pid）
  setTimeout(async () => {
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    const ok = alive && (await portBusy(PORT));
    if (!ok) {
      console.error(`⚠ 启动自检失败：进程${alive ? '存活但端口未响应' : '已退出'}——见日志 ${LOG}；已清除 pid 文件。`);
      try { rmSync(PID); } catch { /* 忽略 */ }
    }
  }, 800);
  console.log(`指挥面板后台启动（无终端窗口）pid=${child.pid}`);
  console.log(`  访问：http://127.0.0.1:${PORT}`);
  console.log(`  日志：${LOG}`);
  console.log(`  停止：node scripts/start-cc.mjs --stop`);
} else {
  console.log(`指挥面板前台启动（Ctrl+C 停止）· 日志同时写入 ${LOG}`);
  const child = spawn(process.execPath, [SERVER], {
    cwd: CC, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false,
  });
  const tee = (stream, sink) => stream.on("data", (d) => {
    try { sink.write(d); appendFileSync(LOG, `[${stamp()}] ${d}`); } catch { /* 忽略 */ }
  });
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);
  child.on("exit", (code) => { console.log(`服务已退出 code=${code}`); process.exit(code ?? 0); });
  process.on("SIGINT", () => child.kill());
  process.on("SIGTERM", () => child.kill());
}