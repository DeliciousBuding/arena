/**
 * Pi 会话工厂类型面（切片 4-4A）。只依赖 pi 公开 API（@earendil-works/pi-coding-agent）。
 *
 * GPT 审核后定稿：
 * - createSession 可注入（默认真实 createAgentSession）——测试用 spy 验证配置模板；
 * - 每租户独立 cwd / agentDir / sessionDir（禁止项目仓库自动发现）；
 * - ModelRuntime.create({ modelNetworkEnabled: false }) 离线构造；
 * - artifacts 记录 VERSION / model / provider / configHash / sessionMode（run manifest 素材）。
 */

import type {
  AgentSession,
  createAgentSession,
  ModelRuntime,
  ResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** 从 createAgentSession 公开签名推导的 pi 类型（零额外依赖、接口变化即编译失败）。 */
type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
export type PiModel = NonNullable<CreateSessionOptions["model"]>;
export type PiThinkingLevel = NonNullable<CreateSessionOptions["thinkingLevel"]>;

/** 会话持久化模式（GPT 裁决 4：默认 in-memory；persistent 供显式选择）。 */
export type PiSessionMode = "in-memory" | "persistent";

/** 会话工厂配置（租户无关；tenantId 在 createSession 时传入）。 */
export interface PiSessionFactoryOptions {
  /** 租户隔离根目录（factory 在其下建 tenants/<id>/{runtime,agent}）。 */
  readonly baseDir: string;
  /** 显式模型（pi Model 结构）。 */
  readonly model: PiModel;
  /** 思考强度（缺省 "medium"，pi 会 clamp 到模型能力）。 */
  readonly thinkingLevel?: PiThinkingLevel;
  /** Arena 工具定义（4B 产物：arena_plan/arena_map；由 leader 集成时注入）。 */
  readonly customTools: readonly ToolDefinition[];
  /** 会话持久化模式（缺省 in-memory）。 */
  readonly sessionMode?: PiSessionMode;
  /** 会话目录（仅 persistent 模式；缺省 baseDir/sessions/<tenantId>）。 */
  readonly sessionDir?: string;
  /** ModelRuntime 认证文件（缺省 pi 全局 ~/.pi/agent/auth.json）。
   *  测试注入临时 auth.json；生产用真实凭据环境。 */
  readonly authPath?: string;
  /** ModelRuntime 注入（缺省自建离线 runtime；测试用 registerProvider 的 fake provider——
   *  pi 原生机制：provider 自带 apiKey + streamSimple，不依赖全局 default stream）。 */
  readonly modelRuntime?: ModelRuntime;
  /** 资源加载器（缺省不注入——pi 内部用 DefaultResourceLoader 按 cwd/agentDir 创建）。 */
  readonly resourceLoader?: ResourceLoader;
  /** 配置 hash（决策配置的 canonical JSON sha256，run manifest 素材）。 */
  readonly configHash: string;
  /** createAgentSession 覆盖（测试 spy 用；缺省 pi 公开 createAgentSession）。 */
  readonly createSession?: (options: unknown) => Promise<{
    session: AgentSession;
    extensionsResult: unknown;
  }>;
}

/** 工厂产出：session + 记录信息（Pi 版本/模型/provider/配置） + 句柄关闭。 */
export interface PiSessionArtifacts {
  readonly session: AgentSession;
  /** Pi 包版本（VERSION 导出）。 */
  readonly piVersion: string;
  readonly modelId: string;
  readonly provider: string;
  readonly sessionMode: PiSessionMode;
  readonly configHash: string;
  /** 该租户的隔离工作目录（cwd）。 */
  readonly cwd: string;
  readonly agentDir: string;
  /** 关闭会话（abort 兜底，幂等）。 */
  close(): Promise<void>;
}
