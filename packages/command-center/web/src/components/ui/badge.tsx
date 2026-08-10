import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Badge 变体契约（DESIGN.md §6 徽章/胶囊）：
 *  语义色仅限「数据/状态/身份」三类。等宽字 + 胶囊 + 描边/底色成对出现。
 *  pulse=true 时前置一个呼吸脉冲点（live/实时态），复用 .badge.ok::before 的 dotPulse。
 *  统一替代手写 #topbar .badge / .health-chip / .ir-badge / .is-chip 等散落胶囊。 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border font-mono font-semibold leading-none tabular-nums transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-muted text-foreground",
        outline: "border-border-strong bg-transparent text-foreground",
        success: "border-[color-mix(in_srgb,var(--color-success)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-success",
        warn: "border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_12%,transparent)] text-warn",
        danger: "border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger",
      },
      size: {
        sm: "px-1.5 py-0.5 text-[9px] tracking-[0.08em]",
        default: "px-2 py-0.5 text-[10px] tracking-[0.1em]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** 前置呼吸脉冲点（live/实时态）。色随 variant：success 绿 / warn 橙 / danger 红。 */
  pulse?: boolean;
}

function Badge({ className, variant, size, pulse = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {pulse ? <span className="badge-pulse-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
