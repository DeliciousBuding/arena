/**
 * ActiveToolContextSlot（4D-pre P0-1）：长驻 session 与 per-run ToolContext 的接通点。
 *
 * 背景：pi 的 customTools 在 session 创建时注册一次（无动态注册 API），而 ToolContext
 * 每 run 变化。工具定义持有本 slot，execute 时取当前 active context。
 *
 * 硬约束：
 * - 同一时间只允许一个 active context（activate 冲突即抛错）；
 * - deactivate(runId) 只关闭匹配 runId——旧 run 的迟到回调不得清掉新 run；
 * - forceClear() 用于 session rotation（放弃任何残留上下文）。
 */

import type { ToolContext } from "./tool-context.ts";

export class ActiveToolContextSlot {
  private active: ToolContext | null = null;

  /** 激活新 run 的 context；已有 active 时抛错（runtime 单 run 不变量）。 */
  activate(context: ToolContext): void {
    if (this.active !== null) {
      throw new Error(`slot already active: ${this.active.runId}（尝试激活 ${context.runId}）`);
    }
    this.active = context;
  }

  /** 工具 execute 时取当前 context；无 active 抛错（迟到的异步工具调用）。 */
  current(): ToolContext {
    if (this.active === null) {
      throw new Error("no active tool context");
    }
    return this.active;
  }

  /** 只关闭匹配 runId 的 context；旧 run 不得清掉新 run。 */
  deactivate(runId: string): void {
    if (this.active?.runId === runId) {
      this.active = null;
    }
  }

  /** session rotation 时强制清空（不匹配任何 runId）。 */
  forceClear(): void {
    this.active = null;
  }
}
