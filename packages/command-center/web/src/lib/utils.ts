import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 标准 class 合并：clsx 条件拼接 + tailwind-merge 消解冲突工具类。
 *  让 Button/Badge 等变体在叠加 className 时不会出现两个 `rounded-*` 互相打架。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
