/**
 * 官方 web 手操镜像（2026-08-08）：消费官方事件流回执（Received，source=MANUAL）
 * 的只读回显——官方 web 手动提交的命令经官方广播到达本侧 SDK，这里把它结构化
 * 落到独立镜像文件 + 审计，不合并进 human-commands（官方已接受执行，agent 重发
 * 会造成双提交冲突；single-writer 纪律：human-commands 写者仍是 command-plane）。
 *
 * 依赖：结构类型（不 import SDK 具体类型），复用 command-plane/audit.ts 审计流水。
 * 纯函数可单测：extractManualActions 无副作用；镜像落盘由调用方（tenant-runtime
 * onTick 接入点）驱动，带内容哈希去重（同内容不重复写盘/审计）。
 */
import { appendAuditEvent } from "./audit.ts";

/** 官方回执结构（Received 的鸭子类型：只依赖 source/plan 形状）。 */
export interface ReceiptLike {
  readonly source: string;
  readonly received_at: string;
  readonly plan?: {
    readonly tick?: number;
    readonly unit_actions?: Readonly<Record<string, unknown>>;
    readonly core_action?: unknown;
  };
}

export interface OfficialMirrorCommand {
  readonly unitId: string;
  readonly action: Record<string, unknown>;
  readonly receivedAt: string;
}

export interface OfficialManualMirror {
  readonly schema: "official-manual-mirror-v1";
  readonly tenant: string;
  readonly tick: number | null;
  readonly updatedAt: string;
  readonly commands: readonly OfficialMirrorCommand[];
  readonly coreAction: Record<string, unknown> | null;
}

/** 从回执表提取 MANUAL 来源的手动命令（无回执/无 MANUAL → 空列表）。 */
export function extractManualActions(receipts: Readonly<Record<string, ReceiptLike>> | undefined): {
  readonly commands: readonly OfficialMirrorCommand[];
  readonly coreAction: Record<string, unknown> | null;
  readonly tick: number | null;
} {
  const receipt = receipts?.["MANUAL"];
  if (receipt === undefined || receipt.plan === undefined) {
    return { commands: [], coreAction: null, tick: null };
  }
  const commands: OfficialMirrorCommand[] = [];
  for (const [unitId, action] of Object.entries(receipt.plan.unit_actions ?? {})) {
    if (typeof action === "object" && action !== null) {
      commands.push({ unitId, action: action as Record<string, unknown>, receivedAt: receipt.received_at });
    }
  }
  const coreAction = (typeof receipt.plan.core_action === "object" && receipt.plan.core_action !== null)
    ? receipt.plan.core_action as Record<string, unknown>
    : null;
  return { commands, coreAction, tick: receipt.plan.tick ?? null };
}

/** 内容哈希（同内容去重：每 tick 调用时不重复写盘/审计）。 */
export function hashMirror(mirror: OfficialManualMirror): string {
  let hash = 0;
  const seed = `${mirror.tick ?? "?"}:${JSON.stringify(mirror.commands)}:${JSON.stringify(mirror.coreAction)}`;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 单次镜像检查（幂等，供每 tick 接入点调用）：
 *  - 无 MANUAL 回执 → 返回 null（不写盘不审计）；
 *  - 内容哈希与上次一致 → 返回 "unchanged"（不写盘不审计）；
 *  - 内容变化 → 写盘 + 审计（kind=official_manual_mirror），返回 "mirrored"。
 * writeMirror 由调用方注入（落盘位置由调用方决定，保持本模块 IO 无关）。
 */
export function checkAndMirrorOfficialManual(
  receipts: Readonly<Record<string, ReceiptLike>> | undefined,
  context: {
    readonly tenant: string;
    readonly dataRoot: string;
    readonly writeMirror: (mirror: OfficialManualMirror) => void;
    readonly previousHash: string | null;
  },
): { readonly status: "none" | "unchanged" | "mirrored"; readonly mirror: OfficialManualMirror | null } {
  const { commands, coreAction, tick } = extractManualActions(receipts);
  if (commands.length === 0 && coreAction === null) {
    return { status: "none", mirror: null };
  }
  const mirror: OfficialManualMirror = {
    schema: "official-manual-mirror-v1",
    tenant: context.tenant,
    tick,
    updatedAt: new Date().toISOString(),
    commands,
    coreAction,
  };
  const hash = hashMirror(mirror);
  if (context.previousHash !== null && context.previousHash === hash) {
    return { status: "unchanged", mirror };
  }
  context.writeMirror(mirror);
  appendAuditEvent(context.dataRoot, context.tenant, {
    tenant: context.tenant,
    issuer: "official_web",
    sessionId: "official-manual",
    intentId: `official-${tick ?? "?"}-${hash}`,
    kind: "official_manual_mirror",
    action: "applied",
    evidence: {
      tick,
      commandCount: commands.length,
      hasCoreAction: coreAction !== null,
      hash,
    },
  });
  return { status: "mirrored", mirror };
}
