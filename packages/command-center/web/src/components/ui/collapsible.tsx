import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

/** Collapsible：Radix 提供键盘语义（Enter/Space 切换）+ aria-expanded，
 *  替代手写 role=button + onKeyDown（修 a11y）。
 *  动画由 CSS height 过渡驱动（550ms cubic-bezier(.22,1,.36,1)）。 */
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
