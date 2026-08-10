import * as React from "react";
import { cn } from "@/lib/utils";

/** Skeleton：首载占位脉冲。自包含 shimmer（.ui-skeleton::after，tailwind.css base 层），
 *  替代手写 .skeleton/.skeleton-line——一处定义，全站加载态一致。
 *  尺寸/宽度由调用方用 Tailwind 工具类给定（h-3 / w-2/5 等），原语只管形状+shimmer。 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("ui-skeleton relative overflow-hidden rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
