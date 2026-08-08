import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(pkgRoot, "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);

// Node's default process isolation creates one child per test file. On Windows the
// official-intel file is business-green in isolation but can hit a libuv handle-closing
// assertion when its child tears down concurrently with another file. Keep process
// isolation (avoids cross-file global-state leaks), bound the main batch to two children,
// and run the sensitive file alone. This also keeps commit/pagefile pressure predictable.
const serialNames = new Set(["test/official-intel.test.ts"]);
const batch = files.filter((file) => !serialNames.has(file));
const serial = files.filter((file) => serialNames.has(file));

function run(filesToRun, concurrency, forceExit) {
  if (filesToRun.length === 0) return;
  const args = ["--test"];
  if (forceExit) args.push("--test-force-exit");
  args.push(`--test-concurrency=${concurrency}`, ...filesToRun);
  const result = spawnSync(process.execPath, args, { cwd: pkgRoot, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// official-intel is fully synchronous and exits naturally. On Node 24/Windows, adding
// --test-force-exit reproducibly hits libuv UV_HANDLE_CLOSING after all 7 assertions pass.
for (const file of serial) run([file], 1, false);
run(batch, 2, true);
