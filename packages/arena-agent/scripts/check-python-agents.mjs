#!/usr/bin/env node
/**
 * python-agents.json 契约校验（只读，2026-08-10）。
 *
 * 校验每个注册条目声明的最小契约（opponent-bridge.py 的解析语义）：
 *  1. repo   目录存在（reference/third-party/ 或 official/，兼容旧平铺）；
 *  2. module 可导入（python -c 子进程，PYTHONPATH 按桥接同序注入 SDK src >
 *     SDK root > 对手 src > 对手 root；arena-ts scripts 目录兜底——arena-evolve
 *     的 adapter 是 TS 侧本地文件）；
 *  3. construct.kwargs 为构造函数可接受的关键字参数（inspect.signature，
 *     空 kwargs 不检查；签名不可内省 → WARN）；
 *  4. decide 可调用（construct 条目 → 实例方法；否则模块级函数）；
 *  5. slot 语义合法（pickle/json/process-memory）；
 *  6. desc 非空。
 *
 * 失败输出逐条明细（agent / 字段 / 期望 vs 实际）并以非 0 退出；python 不可用
 * 时降级静态校验（模块文件存在 + decide 名 grep）并输出 WARN。
 *
 * 用法：node scripts/check-python-agents.mjs [--python <path>] [--quiet]
 *   --python <path>    指定 python 解释器（或 env ARENA_CHECK_PYTHON）
 *   --quiet            仅输出失败明细（供 vs-arena 等集成方使用）
 * 退出码：0 = 全部通过（含 WARN）；1 = 存在硬性失败。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");

/** 协调根：从本文件向上找含 reference/official/arena-hero-python 的目录
 *  （主工作树与 .worktrees/<分支> 层级不同，硬编码层级会落空——与
 *  src/sim/opponent/registry.ts 的 findCoordinationRoot 同判据）。 */
function findCoordinationRoot(from) {
  let dir = from;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "reference", "official", "arena-hero-python"))) return dir;
    if (existsSync(join(dir, "reference", "arena-hero-python"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const COORDINATION_ROOT = findCoordinationRoot(PKG_ROOT);
if (COORDINATION_ROOT === null) {
  console.error("check-python-agents: coordination root (reference/[official/]arena-hero-python) not found");
  process.exit(1);
}

const REGISTRY_PATH = join(HERE, "python-agents.json");
const ALLOWED_SLOTS = new Set(["pickle", "json", "process-memory"]);

/** 与 opponent-bridge.py _resolve_reference_repo 同序：third-party → official → 旧平铺。 */
function resolveRepoDir(repoName) {
  for (const subdir of ["third-party", "official"]) {
    const candidate = join(COORDINATION_ROOT, "reference", subdir, repoName);
    if (existsSync(candidate)) return candidate;
  }
  const legacy = join(COORDINATION_ROOT, "reference", repoName);
  return existsSync(legacy) ? legacy : null;
}

/** 静态定位模块文件（python 不可用时的降级校验用）。
 *  按 dotted 全路径解析（bot.strategy → bot/strategy.py），优先对手仓
 *  （根/src），再查 arena-ts scripts 目录——arena-evolve 的 adapter 是 TS
 *  侧本地文件（桥接脚本同目录，sys.path[0] 兜底）。只认文件，目录跳过。 */
function resolveModuleFile(repoDir, moduleName) {
  const segments = moduleName.split(".");
  const leaf = segments.at(-1);
  const dotted = join(repoDir, ...segments);
  const candidates = [
    `${dotted}.py`,
    join(repoDir, `${leaf}.py`),
    join(repoDir, "src", ...segments) + ".py",
    join(repoDir, "src", `${leaf}.py`),
    join(HERE, `${leaf}.py`),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/**
 * Python 侧契约校验程序（stdin 读 specs JSON，stdout 写 results JSON）。
 * 与 opponent-bridge.py _build_agent 的解析语义对齐：
 *  - importlib.import_module 取精确模块（dotted 名如 bot.strategy）；
 *  - construct 条目：类存在 + kwargs ⊆ 构造函数签名（**kwargs 豁免）+ decide
 *    是实例方法（类属性可调用）；
 *  - 无 construct 条目：decide 是模块级函数（dotted 名先查精确模块，再查
 *    顶层包——bot/__init__.py 会 re-export decide，与桥的 __import__ 行为一致）。
 */
const PYTHON_CHECK_PROGRAM = String.raw`
import importlib, inspect, json, sys

specs = json.load(sys.stdin)
results = []
for spec in specs:
    result = {"agent": spec["agent"]}
    try:
        module = importlib.import_module(spec["module"])
    except Exception as exc:
        result["module_error"] = f"{type(exc).__name__}: {exc}"
        results.append(result)
        continue
    result["module_ok"] = True
    construct = spec.get("construct")
    if construct is not None:
        cls = getattr(module, construct["fn"], None)
        if cls is None:
            result["construct_error"] = f"class {construct['fn']} not found in module {spec['module']}"
        else:
            result["construct_ok"] = True
            kwargs = construct.get("kwargs") or []
            if kwargs:
                try:
                    sig = inspect.signature(cls)
                    accepts_var_kw = any(
                        p.kind is inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
                    )
                    missing = [
                        k for k in kwargs
                        if k not in sig.parameters and not accepts_var_kw
                    ]
                    if missing:
                        result["kwargs_error"] = (
                            f"kwargs {missing} not accepted by {construct['fn']} "
                            f"(constructor params: {list(sig.parameters)})"
                        )
                    else:
                        result["kwargs_ok"] = True
                except (ValueError, TypeError) as exc:
                    result["kwargs_warn"] = (
                        f"cannot introspect {construct['fn']} constructor signature "
                        f"({type(exc).__name__}) - kwargs not verified"
                    )
            if cls is not None:
                decide_target = getattr(cls, spec["decide"], None)
                if not callable(decide_target):
                    result["decide_error"] = (
                        f"instance method {spec['decide']} not found on class {construct['fn']}"
                    )
                else:
                    result["decide_ok"] = True
    else:
        exact_module = module
        decide_target = getattr(exact_module, spec["decide"], None)
        if not callable(decide_target):
            top_level = importlib.import_module(spec["module"].split(".")[0])
            decide_target = getattr(top_level, spec["decide"], None)
        if not callable(decide_target):
            result["decide_error"] = (
                f"module-level {spec['decide']} not found in module {spec['module']} "
                f"(checked exact module and top-level package)"
            )
        else:
            result["decide_ok"] = True
    results.append(result)

print(json.dumps(results))
`;

/** 收集一个条目的静态校验结果（repo/slot/desc/module 文件——不依赖 python）。 */
function staticChecks(agentName, entry) {
  const errors = [];
  const warns = [];

  const repoDir = resolveRepoDir(entry.repo);
  if (repoDir === null) {
    errors.push(
      `${agentName}: repo 目录不存在（期望 reference/third-party/${entry.repo} 或 official/，实际未找到）`,
    );
    return { errors, warns, repoDir: null, moduleFile: null };
  }

  if (typeof entry.module !== "string" || entry.module.trim() === "") {
    errors.push(`${agentName}: module 为空（期望非空模块名，实际 ${JSON.stringify(entry.module)}）`);
  }
  if (typeof entry.decide !== "string" || entry.decide.trim() === "") {
    errors.push(`${agentName}: decide 为空（期望非空函数/方法名，实际 ${JSON.stringify(entry.decide)}）`);
  }
  if (!ALLOWED_SLOTS.has(entry.slot)) {
    errors.push(
      `${agentName}: slot 语义非法（期望 pickle/json/process-memory 之一，实际 ${JSON.stringify(entry.slot)}）`,
    );
  }
  if (typeof entry.desc !== "string" || entry.desc.trim() === "") {
    errors.push(`${agentName}: desc 为空（期望非空说明）`);
  }

  const moduleFile = typeof entry.module === "string" ? resolveModuleFile(repoDir, entry.module) : null;
  if (entry.module && moduleFile === null) {
    warns.push(
      `${agentName}: module 文件静态定位失败（${entry.module} 不在 ${entry.repo} 根/src——python 可用时以真实 import 为准）`,
    );
  }
  return { errors, warns, repoDir, moduleFile };
}

/** python 可用性探测 + 全量动态校验（一次子进程跑 5 个条目）。 */
function dynamicChecks(agents, pythonCandidates) {
  const python = pythonCandidates.find((candidate) => {
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version.split()[0])"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return probe.status === 0;
  });
  if (python === undefined) {
    return { python: null, entries: new Map() };
  }

  const specs = [];
  for (const [agentName, entry] of Object.entries(agents)) {
    specs.push({
      agent: agentName,
      module: entry.module,
      decide: entry.decide,
      construct: entry.construct ?? null,
    });
  }

  // PYTHONPATH 按桥接 _load_repos 同序：SDK src > SDK root > 对手 src > 对手
  // root；arena-ts scripts 目录（cwd）垫底兜底 arena_evolve_adapter。
  const sdkRepo = resolveRepoDir("arena-hero-python");
  const pythonPathParts = [];
  const sdkSrc = join(sdkRepo, "src");
  if (existsSync(sdkSrc)) pythonPathParts.push(sdkSrc);
  pythonPathParts.push(sdkRepo);
  for (const entry of Object.values(agents)) {
    const repoDir = resolveRepoDir(entry.repo);
    if (repoDir === null) continue;
    const repoSrc = join(repoDir, "src");
    if (existsSync(repoSrc)) pythonPathParts.push(repoSrc);
    pythonPathParts.push(repoDir);
  }

  const run = spawnSync(python, ["-c", PYTHON_CHECK_PROGRAM], {
    input: JSON.stringify(specs),
    encoding: "utf8",
    cwd: HERE,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: pythonPathParts.join(process.platform === "win32" ? ";" : ":") },
  });

  const entries = new Map();
  if (run.status !== 0) {
    const stderr = (run.stderr ?? "").trim() || (run.error?.message ?? "unknown error");
    for (const [agentName] of Object.entries(agents)) {
      entries.set(agentName, { error: `python 校验子进程失败（exit ${run.status}）：${stderr}` });
    }
    return { python, entries };
  }

  let results;
  try {
    results = JSON.parse(run.stdout);
  } catch {
    for (const [agentName] of Object.entries(agents)) {
      entries.set(agentName, { error: `python 校验输出解析失败：${run.stdout.slice(0, 200)}` });
    }
    return { python, entries };
  }
  for (const result of results) {
    entries.set(result.agent, result);
  }
  return { python, entries };
}

/** 静态降级校验：module 文件存在 + decide 名 grep（python 不可用时）。 */
function staticFallbackChecks(agentName, entry, repoDir, moduleFile) {
  const warns = [`${agentName}: python 不可用，降级静态校验（模块文件 + decide 名 grep）`];
  if (moduleFile === null) return { warns, errors: [] };
  const text = readFileSync(moduleFile, "utf8");
  const decidePattern = new RegExp(`\\b${entry.decide}\\b`);
  if (!decidePattern.test(text)) {
    return {
      warns,
      errors: [
        `${agentName}: decide 名 ${entry.decide} 未在 ${entry.module} 模块文件中找到（期望可调用函数/方法名，实际 grep 无命中）`,
      ],
    };
  }
  return { warns, errors: [] };
}

export function validatePythonAgents(options = {}) {
  const quiet = options.quiet ?? false;
  const pythonCandidates = [
    options.python ?? process.env.ARENA_CHECK_PYTHON ?? "python",
    "python3",
  ].filter(Boolean);

  let agents;
  try {
    agents = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")).agents;
  } catch (error) {
    return { ok: false, errors: [`python-agents.json 读取失败：${String(error)}`], warns: [], summary: "registry unreadable" };
  }

  const errors = [];
  const warns = [];

  // 静态层（不依赖 python）：repo 存在 / slot / desc / module 文件
  const staticByAgent = new Map();
  for (const [agentName, entry] of Object.entries(agents)) {
    const result = staticChecks(agentName, entry);
    staticByAgent.set(agentName, result);
    errors.push(...result.errors);
    warns.push(...result.warns);
  }

  // 动态层（python import + inspect）；python 不可用 → 静态降级 + WARN
  const { python, entries: dynamicByAgent } = dynamicChecks(agents, pythonCandidates);
  if (python === null) {
    for (const [agentName, entry] of Object.entries(agents)) {
      const { repoDir, moduleFile } = staticByAgent.get(agentName);
      if (repoDir === null) continue;
      const fallback = staticFallbackChecks(agentName, entry, repoDir, moduleFile);
      errors.push(...fallback.errors);
      warns.push(...fallback.warns);
    }
  } else {
    for (const [agentName, entry] of Object.entries(agents)) {
      const dynamic = dynamicByAgent.get(agentName) ?? {};
      if (dynamic.error !== undefined) {
        errors.push(`${agentName}: ${dynamic.error}`);
        continue;
      }
      if (dynamic.module_error !== undefined) {
        errors.push(
          `${agentName}: module 不可导入（期望 ${entry.module} 可 import，实际 ${dynamic.module_error}）`,
        );
      }
      if (dynamic.construct_error !== undefined) {
        errors.push(`${agentName}: ${dynamic.construct_error}`);
      }
      if (dynamic.kwargs_error !== undefined) {
        errors.push(`${agentName}: construct kwargs 校验失败——${dynamic.kwargs_error}`);
      }
      if (dynamic.kwargs_warn !== undefined) {
        warns.push(`${agentName}: ${dynamic.kwargs_warn}`);
      }
      if (dynamic.decide_error !== undefined) {
        errors.push(`${agentName}: ${dynamic.decide_error}`);
      }
    }
  }

  if (!quiet) {
    const passCount = Object.keys(agents).filter((agentName) =>
      !errors.some((error) => error.startsWith(agentName)),
    ).length;
    const summary = `python-agents.json 契约校验：${passCount}/${Object.keys(agents).length} 通过（python=${python ?? "不可用（静态降级）"})`;
    console.log(summary);
    if (warns.length > 0) {
      for (const warn of warns) console.warn(`  WARN ${warn}`);
    }
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`  FAIL ${error}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warns,
    summary: `python-agents.json: ${Object.keys(agents).length} agents, ${errors.length} errors, ${warns.length} warns`,
  };
}

// 直接执行（CLI）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pythonEquals = process.argv.find((arg) => arg.startsWith("--python="));
  const pythonFlagIndex = process.argv.indexOf("--python");
  const pythonArg = pythonEquals !== undefined
    ? pythonEquals.slice("--python=".length)
    : pythonFlagIndex >= 0 && pythonFlagIndex + 1 < process.argv.length
      ? process.argv[pythonFlagIndex + 1]
      : undefined;
  const result = validatePythonAgents({
    quiet: process.argv.includes("--quiet"),
    python: pythonArg,
  });
  process.exit(result.ok ? 0 : 1);
}
