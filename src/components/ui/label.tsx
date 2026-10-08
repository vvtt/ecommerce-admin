import * as React from "react";
import { cn } from "@/src/lib/utils";

const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }
>(({ className, children, required, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-xs font-semibold text-slate-700 leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  >
    {children}
    {required && <span className="text-rose-500 ml-0.5">*</span>}
  </label>
));
Label.displayName = "Label";

export { Label };
