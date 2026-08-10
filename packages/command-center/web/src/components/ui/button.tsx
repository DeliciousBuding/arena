import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Button 变体契约（DESIGN.md §6 组件要点）：
 *  - default：极淡白线 + 5% 白底（次要动作）→ bg-secondary
 *  - primary：单一白色强调（白底黑字 / 浅底深字反相）→ bg-primary text-primary-foreground
 *  - ghost：透明，hover 弱底
 *  - outline：描边
 *  - destructive：danger 底
 *  焦点环 = outline-ring（白强调，唯一高亮态）；active scale(.97) 微反馈。 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,box-shadow,transform,color,border-color] duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[.97] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground border border-border hover:bg-secondary/70",
        primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-card",
        ghost: "bg-transparent text-foreground hover:bg-muted",
        outline: "border border-border-strong bg-transparent text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/85",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        default: "h-8 px-3 text-xs",
        lg: "h-9 px-4 text-[13px]",
        icon: "h-8 w-8",
        "icon-sm": "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** asChild：把渲染委托给子元素（用于 <a> 或自定义触发器，保留变体样式）。 */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        type={asChild ? undefined : type ?? "button"}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
