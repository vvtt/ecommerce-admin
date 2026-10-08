import * as React from "react";
import { cn } from "@/src/lib/utils";

/** 1px 分隔线，横向默认、vertical 可做工具栏分隔 */
const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }
>(({ className, orientation = "horizontal", ...props }, ref) => (
  <div
    ref={ref}
    role="separator"
    className={cn(
      "bg-slate-200 shrink-0",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px self-stretch",
      className
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

export { Separator };
