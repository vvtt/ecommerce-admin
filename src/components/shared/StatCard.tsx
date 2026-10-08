import type { ReactNode } from "react";
import { cn } from "@/src/lib/utils";

export type StatTone = "blue" | "emerald" | "amber" | "rose" | "slate" | "violet";

const toneClasses: Record<StatTone, { ring: string; icon: string; value: string }> = {
  blue: { ring: "border-blue-100", icon: "bg-blue-50 text-blue-600", value: "text-slate-900" },
  emerald: {
    ring: "border-emerald-100",
    icon: "bg-emerald-50 text-emerald-600",
    value: "text-slate-900",
  },
  amber: { ring: "border-amber-100", icon: "bg-amber-50 text-amber-600", value: "text-slate-900" },
  rose: { ring: "border-rose-100", icon: "bg-rose-50 text-rose-600", value: "text-rose-700" },
  slate: { ring: "border-slate-200", icon: "bg-slate-100 text-slate-600", value: "text-slate-900" },
  violet: {
    ring: "border-violet-100",
    icon: "bg-violet-50 text-violet-600",
    value: "text-slate-900",
  },
};

interface StatCardProps {
  label: string;
  value: ReactNode;
  /** 数值后缀，如 "件" / "CNY" */
  unit?: string;
  /** 副标题，如环比说明、明细拆分 */
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  /** 点击后跳转的说明文字，配 onClick 使用 */
  className?: string;
  onClick?: () => void;
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  tone = "blue",
  className,
  onClick,
}: StatCardProps) {
  const t = toneClasses[tone];

  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-xl border bg-white p-4 shadow-xs transition-all",
        t.ring,
        onClick && "cursor-pointer hover:shadow-md hover:-translate-y-0.5",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-500 truncate">{label}</p>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className={cn("text-2xl font-bold tracking-tight tabular-nums", t.value)}>
              {value}
            </span>
            {unit && <span className="text-xs font-medium text-slate-500">{unit}</span>}
          </div>
        </div>

        {icon && (
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
              t.icon
            )}
          >
            {icon}
          </div>
        )}
      </div>

      {hint && <p className="mt-2 text-[11px] text-slate-500 leading-snug truncate">{hint}</p>}
    </div>
  );
}
