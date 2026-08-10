import { Toaster as SonnerToaster } from "sonner";
import { cn } from "@/lib/utils";

/** Sonner 轻提示：替代 #uiToast 手写 DOM。
 *  暗底浅字 + 极淡描边 + 柔和阴影（DESIGN.md 浮层规范）。
 *  主题随 [data-theme] 自动翻转（token 桥接）。 */
function Toaster({ className, ...props }: React.ComponentProps<typeof SonnerToaster>) {
  return (
    <SonnerToaster
      className={cn("toaster", className)}
      theme="dark"
      position="bottom-center"
      richColors={false}
      closeButton={false}
      toastOptions={{
        classNames: {
          toast:
            "group rounded-md border border-border bg-popover text-popover-foreground px-3 py-2 text-xs shadow-float",
          description: "text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}

/** toast 桥接：供引擎 / 旧 #uiToast 代码调用，统一走 Sonner。
 *  原 engine.toast(text) → toast(text)，行为一致（2.4s 自动消失）。 */
export { toast } from "sonner";
export { Toaster };
