/**
 * M3: evidence-v1 归档脚本测试（node:test + 临时目录，不提交 fixture 数据文件）。
 *
 * 门禁：MY_CLEAN=1 node --test test/evidence-archive.test.ts
 * 覆盖：合法归档 / 缺字段拒绝 / underpowered→hold / promote·reject 判定 /
 *       incompatible 分桶 / LOG 追加（日期段不重复）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveEvidence,
  computeRecommend,
  EvidenceSchemaError,
  loadAndValidateRecordDir,
} from "../scripts/archive-evidence.mts";

interface FixtureOverrides {
  mode?: string;
  seeds?: number[];
  engineCommit?: string;
  rulesVersion?: string;
  generatedAt?: string;
  scenario?: string;
  winRate?: Record<string, number>;
  wilson95?: Record<string, [number, number]>;
  underpowered?: boolean;
  participantIds?: string[];
}

/** 构造最小合法 evidence record-dir（manifest.json + summary.json）。 */
async function makeRecordDir(parent: string, overrides: FixtureOverrides = {}): Promise<string> {
  const recordDir = await mkdtemp(join(parent, "record-"));
  const seeds = overrides.seeds ?? Array.from({ length: 14 }, (_, index) => index + 1);
  const mode = overrides.mode ?? "version-compare";
  const participantIds = overrides.participantIds ?? ["mine", "mine2"];
  const participants = participantIds.map((id) => ({
    id,
    desc: `desc for ${id}`,
    kind: "config",
    source: "synthetic",
  }));
  const winRate = overrides.winRate ?? { mine: 0.714, mine2: 0.286 };
  const wilson95 = overrides.wilson95 ?? {
    mine: [0.47, 0.88],
    mine2: [0.12, 0.53],
  };
  const wins = Object.fromEntries(
    participantIds.map((id) => [id, Math.round((winRate[id] ?? 0) * seeds.length)]),
  );
  const meanResources = Object.fromEntries(participantIds.map((id) => [id, 8]));

  const manifest = {
    schema: "arena-ts/evidence/v1",
    generatedAt: overrides.generatedAt ?? "2026-08-09T12:00:00.000Z",
    rulesVersion: overrides.rulesVersion ?? "v0.14",
    engineCommit: overrides.engineCommit ?? "abcdef1234567890",
    mode,
    refillEveryTicks: 4,
    scenario: overrides.scenario ?? "synthetic",
    ticks: 200,
    seeds,
    participants,
    rounds: seeds.map((seed) => ({
      seed,
      winner: seed % 2 === 0 ? "mine" : "mine2",
      finalResources: { mine: 10, mine2: 6 },
      finalPopulation: { mine: 5, mine2: 3 },
      coreAlive: { mine: true, mine2: true },
    })),
  };
  const summary: Record<string, unknown> = { wins, winRate, wilson95, meanResources };
  if (overrides.underpowered !== undefined) {
    summary.underpowered = overrides.underpowered;
  }

  await writeFile(join(recordDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(recordDir, "summary.json"), JSON.stringify(summary, null, 2));
  return recordDir;
}

async function makeDocRoot(parent: string): Promise<{ evidenceRoot: string; logPath: string }> {
  const docRoot = await mkdtemp(join(parent, "docroot-"));
  return {
    evidenceRoot: join(docRoot, "docs", "evidence"),
    logPath: join(docRoot, "docs", "progress", "LOG.md"),
  };
}

async function withSandbox(body: (sandbox: string) => Promise<void>): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "m3-evidence-"));
  try {
    await body(sandbox);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

test("合法 record-dir：合并 manifest+summary 单文件归档，recommend=promote", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await makeRecordDir(sandbox);
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);

    const result = await archiveEvidence(recordDir, { evidenceRoot, logPath });
    assert.equal(result.fileName, "2026-08-09-version-compare-abcdef12.json");
    assert.equal(result.recommend, "promote");
    assert.equal(result.comparable, true, "空 docs/evidence 时首个归档应可比");

    const archived = JSON.parse(await readFile(result.archivePath, "utf8")) as Record<string, unknown>;
    assert.equal(archived.schema, "arena-ts/evidence/v1");
    assert.equal(archived.rulesVersion, "v0.14");
    assert.equal(archived.engineCommit, "abcdef1234567890");
    assert.equal(archived.mode, "version-compare");
    assert.equal(archived.recommend, "promote");
    assert.ok(Array.isArray(archived.rounds) && archived.rounds.length === 14, "rounds 应随 manifest 合并");
    assert.deepEqual((archived.summary as Record<string, unknown>).winRate, { mine: 0.714, mine2: 0.286 });
  });
});

test("缺字段拒绝：错误信息列出全部缺失与类型错误字段", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await makeRecordDir(sandbox);
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);

    const manifestPath = join(recordDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.rulesVersion;
    delete manifest.ticks;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const summaryPath = join(recordDir, "summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
    delete summary.meanResources;
    summary.winRate = { mine: "0.714", mine2: 0.286 };
    await writeFile(summaryPath, JSON.stringify(summary));

    await assert.rejects(
      archiveEvidence(recordDir, { evidenceRoot, logPath }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceSchemaError);
        for (const field of ["rulesVersion", "ticks", "meanResources", "winRate"]) {
          assert.ok(error.message.includes(field), `错误信息应列出缺失/错误字段 ${field}`);
        }
        return true;
      },
    );
  });
});

test("缺失 manifest.json / summary.json 文件本身也被列出", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await mkdtemp(join(sandbox, "empty-record-"));
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);
    await assert.rejects(
      archiveEvidence(recordDir, { evidenceRoot, logPath }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceSchemaError);
        assert.ok(error.message.includes("manifest.json 缺失"));
        assert.ok(error.message.includes("summary.json 缺失"));
        return true;
      },
    );
  });
});

test("underpowered：seeds<12 一律 hold，不论胜率数字", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await makeRecordDir(sandbox, {
      seeds: [1, 2, 3, 4, 5, 6, 7, 8],
      winRate: { mine: 1.0, mine2: 0.0 },
      wilson95: { mine: [0.63, 1.0], mine2: [0.0, 0.37] },
    });
    const { manifest, summary } = await loadAndValidateRecordDir(recordDir);
    assert.equal(computeRecommend(manifest, summary), "hold");

    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);
    const result = await archiveEvidence(recordDir, { evidenceRoot, logPath });
    assert.equal(result.recommend, "hold");
    const archived = JSON.parse(await readFile(result.archivePath, "utf8")) as { recommend: string };
    assert.equal(archived.recommend, "hold");
  });
});

test("summary.underpowered=true 时即使 seeds>=12 也 hold", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await makeRecordDir(sandbox, {
      winRate: { mine: 0.9, mine2: 0.1 },
      wilson95: { mine: [0.71, 0.97], mine2: [0.03, 0.29] },
      underpowered: true,
    });
    const { manifest, summary } = await loadAndValidateRecordDir(recordDir);
    assert.equal(computeRecommend(manifest, summary), "hold");
  });
});

test("promote/reject/hold 判定（seeds>=12 有样本量）", async () => {
  await withSandbox(async (sandbox) => {
    // mine 显著优 → promote（默认 fixture 即此情形）
    const promoteRecordDir = await makeRecordDir(sandbox);
    const { manifest: promoteManifest, summary: promoteSummary } =
      await loadAndValidateRecordDir(promoteRecordDir);
    assert.equal(computeRecommend(promoteManifest, promoteSummary), "promote");

    // mine2 显著优 → reject
    const rejectRecordDir = await makeRecordDir(sandbox, {
      winRate: { mine: 0.286, mine2: 0.714 },
      wilson95: { mine: [0.12, 0.53], mine2: [0.47, 0.88] },
    });
    const { manifest: rejectManifest, summary: rejectSummary } =
      await loadAndValidateRecordDir(rejectRecordDir);
    assert.equal(computeRecommend(rejectManifest, rejectSummary), "reject");

    // 双方均未达显著性下界（Wilson 下界 <= 0.35）→ hold
    const holdRecordDir = await makeRecordDir(sandbox, {
      winRate: { mine: 0.55, mine2: 0.45 },
      wilson95: { mine: [0.28, 0.79], mine2: [0.21, 0.72] },
    });
    const { manifest: holdManifest, summary: holdSummary } =
      await loadAndValidateRecordDir(holdRecordDir);
    assert.equal(computeRecommend(holdManifest, holdSummary), "hold");

    // mode 非 version-compare → record
    const matrixRecordDir = await makeRecordDir(sandbox, {
      mode: "matrix",
      participantIds: ["mine", "farmer-s1"],
      winRate: { mine: 0.75, "farmer-s1": 0.25 },
      wilson95: { mine: [0.41, 0.93], "farmer-s1": [0.07, 0.59] },
    });
    const { manifest: matrixManifest, summary: matrixSummary } =
      await loadAndValidateRecordDir(matrixRecordDir);
    assert.equal(computeRecommend(matrixManifest, matrixSummary), "record");
  });
});

test("version-compare 缺 mine/mine2：schema 拒绝并列出", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await makeRecordDir(sandbox, { participantIds: ["mine", "farmer-s1"] });
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);
    await assert.rejects(
      archiveEvidence(recordDir, { evidenceRoot, logPath }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceSchemaError);
        assert.ok(error.message.includes('"mine2"'), "应提示 version-compare 缺 mine2");
        return true;
      },
    );
  });
});

test("incompatible 分桶：rulesVersion/engineCommit 前缀不一致进 incompatible/", async () => {
  await withSandbox(async (sandbox) => {
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);

    // 首个归档：空索引 → 顶层，可比
    const firstRecordDir = await makeRecordDir(sandbox);
    const first = await archiveEvidence(firstRecordDir, { evidenceRoot, logPath });
    assert.equal(first.comparable, true);
    assert.equal(first.archivePath, join(evidenceRoot, first.fileName));

    // 同窗口（同 rulesVersion + 同 commit 前缀）→ 顶层，可比
    // （matrix mode 生成不同文件名，避免与首个 version-compare 归档重名）
    const sameWindowRecordDir = await makeRecordDir(sandbox, {
      mode: "matrix",
      participantIds: ["mine", "farmer-s1"],
      winRate: { mine: 0.643, "farmer-s1": 0.357 },
      wilson95: { mine: [0.38, 0.84], "farmer-s1": [0.16, 0.62] },
    });
    const sameWindow = await archiveEvidence(sameWindowRecordDir, { evidenceRoot, logPath });
    assert.equal(sameWindow.comparable, true);
    assert.equal(sameWindow.archivePath, join(evidenceRoot, sameWindow.fileName));

    // rulesVersion 不一致 → incompatible/ 分桶
    const differentRulesRecordDir = await makeRecordDir(sandbox, { rulesVersion: "v0.15" });
    const differentRules = await archiveEvidence(differentRulesRecordDir, { evidenceRoot, logPath });
    assert.equal(differentRules.comparable, false);
    assert.equal(differentRules.archivePath, join(evidenceRoot, "incompatible", differentRules.fileName));

    // 同 rulesVersion 但 commit 前缀不一致 → incompatible/ 分桶
    const differentCommitRecordDir = await makeRecordDir(sandbox, { engineCommit: "fedcba9876543210" });
    const differentCommit = await archiveEvidence(differentCommitRecordDir, { evidenceRoot, logPath });
    assert.equal(differentCommit.comparable, false);
    assert.equal(differentCommit.archivePath, join(evidenceRoot, "incompatible", differentCommit.fileName));

    // 顶层恰有 2 份，incompatible/ 恰有 2 份
    assert.ok(existsSync(join(evidenceRoot, first.fileName)));
    assert.ok(existsSync(join(evidenceRoot, sameWindow.fileName)));
    assert.ok(existsSync(join(evidenceRoot, "incompatible", differentRules.fileName)));
    assert.ok(existsSync(join(evidenceRoot, "incompatible", differentCommit.fileName)));
  });
});

test("LOG 追加：首次建日期段，同日直接加条目不重复日期头", async () => {
  await withSandbox(async (sandbox) => {
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);

    const firstRecordDir = await makeRecordDir(sandbox);
    const first = await archiveEvidence(firstRecordDir, { evidenceRoot, logPath });
    assert.equal(first.logSectionCreated, true);

    const logAfterFirst = await readFile(logPath, "utf8");
    assert.ok(logAfterFirst.includes("## 2026-08-09"));
    assert.ok(logAfterFirst.includes(first.logEntry));
    assert.ok(logAfterFirst.includes("recommend=promote"));

    // 同日第二份：直接加条目，不新建日期段
    const secondRecordDir = await makeRecordDir(sandbox, {
      mode: "matrix",
      participantIds: ["mine", "farmer-s1"],
      winRate: { mine: 0.75, "farmer-s1": 0.25 },
      wilson95: { mine: [0.41, 0.93], "farmer-s1": [0.07, 0.59] },
    });
    const second = await archiveEvidence(secondRecordDir, { evidenceRoot, logPath });
    assert.equal(second.logSectionCreated, false);

    const logAfterSecond = await readFile(logPath, "utf8");
    const dateHeaderCount = logAfterSecond.split("\n").filter((line) => line === "## 2026-08-09").length;
    assert.equal(dateHeaderCount, 1, "同日多次归档不应重复日期段头");
    assert.ok(logAfterSecond.includes(second.logEntry));
    assert.ok(logAfterSecond.includes("recommend=record"));
    assert.ok(logAfterSecond.indexOf(second.logEntry) > logAfterSecond.indexOf(first.logEntry));

    // 不同日期 → 新建日期段
    const nextDayRecordDir = await makeRecordDir(sandbox, { generatedAt: "2026-08-10T08:00:00.000Z" });
    const nextDay = await archiveEvidence(nextDayRecordDir, { evidenceRoot, logPath });
    assert.equal(nextDay.logSectionCreated, true);
    const logAfterNextDay = await readFile(logPath, "utf8");
    assert.ok(logAfterNextDay.includes("## 2026-08-10"));
  });
});

test("同窗口同文件名重复归档：拒绝覆盖", async () => {
  await withSandbox(async (sandbox) => {
    const recordDir = await makeRecordDir(sandbox);
    const { evidenceRoot, logPath } = await makeDocRoot(sandbox);
    await archiveEvidence(recordDir, { evidenceRoot, logPath });
    await assert.rejects(
      archiveEvidence(recordDir, { evidenceRoot, logPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes("拒绝覆盖"));
        return true;
      },
    );
  });
});
