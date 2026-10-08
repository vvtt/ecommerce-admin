import * as React from "react";
import { cn } from "@/src/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[72px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 shadow-xs transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-blue-500",
      "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
