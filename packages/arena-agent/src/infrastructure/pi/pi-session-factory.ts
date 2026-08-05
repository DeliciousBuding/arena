/**
 * Pi 会话工厂（切片 4-4A）：用公开 createAgentSession() 装配隔离的 Pi 会话。
 *
 * GPT 审核后定稿：
 * - 只调用公开 API；每租户独立 cwd / agentDir / sessionDir；
 * - noTools: "all" + tools allowlist（builtin 全禁用，只留 arena_plan/arena_map）；
 * - 显式 model / thinkingLevel / resourceLoader；
 * - sessionManager：in-memory（默认）或 persistent（SessionManager.create）；
 * - createSession 可注入（测试 spy；缺省 pi 公开 createAgentSession）。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import type { PiSessionArtifacts, PiSessionFactoryOptions } from "./pi-types.ts";

/** Arena 工具白名单（builtin 之外的唯一工具；与 noTools:"all" 组合 = 零内置工具）。 */
export const ARENA_TOOL_ALLOWLIST = ["arena_plan", "arena_map"] as const;

/** 租户会话目录结构（总任务书 1.2）：<baseDir>/<tenantId>/{cwd,agent,session}。
 *  baseDir 由调用方给运行时根（如 runtime/<processRunId>/）。 */
function tenantDirs(
  baseDir: string,
  tenantId: string,
): { cwdDir: string; agentDir: string; sessionDir: string } {
  const root = join(baseDir, tenantId);
  const cwdDir = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "session");
  mkdirSync(cwdDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  return { cwdDir, agentDir, sessionDir };
}

/** 从模型对象提取 modelId/provider（pi Model 结构字段名以 d.ts 为准，缺失时降级）。 */
function modelMeta(model: PiSessionFactoryOptions["model"]): { modelId: string; provider: string } {
  const id = (model as { id?: string })?.id ?? (model as { name?: string })?.name ?? "unknown";
  const provider =
    (model as { provider?: string })?.provider ?? (model as { providerId?: string })?.providerId ?? "unknown";
  return { modelId: id, provider };
}

export class PiSessionFactory {
  readonly options: PiSessionFactoryOptions;

  constructor(options: PiSessionFactoryOptions) {
    if (typeof options.baseDir !== "string" || options.baseDir.trim().length === 0) {
      throw new RangeError("PiSessionFactoryOptions.baseDir must be a non-empty path");
    }
    if (!Array.isArray(options.customTools)) {
      throw new RangeError("PiSessionFactoryOptions.customTools must be a ToolDefinition[]");
    }
    if (typeof options.configHash !== "string" || options.configHash.trim().length === 0) {
      throw new RangeError("PiSessionFactoryOptions.configHash must be a non-empty string");
    }
    this.options = options;
  }

  /** 为一个租户创建隔离会话（目录幂等；跨租户互不干扰）。 */
  async createSession(tenantId: string): Promise<PiSessionArtifacts> {
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw new RangeError("tenantId must be a non-empty string");
    }
    const { cwdDir, agentDir, sessionDir } = tenantDirs(this.options.baseDir, tenantId);
    const sessionMode = this.options.sessionMode ?? "in-memory";

    const sessionManager =
      sessionMode === "persistent"
        ? SessionManager.create(cwdDir, this.options.sessionDir ?? sessionDir)
        : SessionManager.inMemory(cwdDir);

    const modelRuntime =
      this.options.modelRuntime ??
      (await ModelRuntime.create({
        allowModelNetwork: false,
        ...(this.options.authPath !== undefined ? { authPath: this.options.authPath } : {}),
      }));

    // 完整模型解析：调用方模型常缺 baseUrl/compat（手工构造），pi 的 stream 内部
    // 依赖 model.baseUrl（openai-completions 的 URL 检测）——从 modelRuntime 按
    // provider+id 解析 models.json 合成模型（带 baseUrl/compat）；找不到回退调用方模型
    //（测试的 fake provider 走此回退）。诊断依据：真实 newapi 流在缺 baseUrl 时
    // 报 "Cannot read properties of undefined (reading 'includes')"。
    // v0.2.15：解析结果必须保留调用方显式 compat 覆盖（supportsDeveloperRole 等）——
    // models.json 的模型常缺 compat，Pi 0.83 会按 provider 推断 supportsDeveloperRole=true，
    // thinkingLevel≠off 时把 system prompt 发成 developer role，DeepSeek/SenseNova
    // 网关拒绝（400 messages[0].role，生产 19 次 policy_error）。显式 compat 永远优先。
    let model = this.options.model;
    try {
      const modelMeta = this.options.model as { provider?: string; id?: string };
      const resolved =
        modelMeta.provider !== undefined && modelMeta.id !== undefined
          ? modelRuntime.getModel(modelMeta.provider, modelMeta.id)
          : undefined;
      if (resolved !== undefined) {
        model = {
          ...resolved,
          ...(this.options.model.compat !== undefined
            ? { compat: { ...(resolved as { compat?: Record<string, unknown> }).compat, ...this.options.model.compat } }
            : {}),
        };
      }
    } catch {
      // 解析失败回退调用方模型（保持可运行）
    }
    const { modelId, provider } = modelMeta(this.options.model);

    const call = this.options.createSession ?? createAgentSession;
    const result = await call({
      cwd: cwdDir,
      agentDir,
      modelRuntime,
      model, // 解析后的完整模型（baseUrl/compat 齐全）；解析失败时回退调用方模型
      thinkingLevel: this.options.thinkingLevel,
      // GPT 审核：builtin 全禁用 + 白名单只留两个 Arena 工具
      noTools: "all",
      tools: [...ARENA_TOOL_ALLOWLIST],
      customTools: [...this.options.customTools],
      // resourceLoader 省略：pi 内部用 DefaultResourceLoader 按 cwd/agentDir 创建
      ...(this.options.resourceLoader !== undefined ? { resourceLoader: this.options.resourceLoader } : {}),
      sessionManager,
    });

    return {
      session: result.session,
      piVersion: VERSION,
      modelId,
      provider,
      sessionMode,
      configHash: this.options.configHash,
      cwd: cwdDir,
      agentDir,
      // 总任务书 PiSessionHandle.close：session 无公开 close，abort 兜底（幂等）
      close: async () => {
        await result.session.abort().catch(() => {});
      },
    };
  }
}
