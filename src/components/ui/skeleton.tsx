import { cn } from "@/src/lib/utils";

/** 加载占位骨架。列表页首次加载时用它撑住布局，避免高度塌陷。 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-slate-200/80", className)} />;
}

/** 表格骨架：按列数生成 rows 行 */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-1">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn("h-5", c === 0 ? "w-[22%]" : c === cols - 1 ? "w-[10%]" : "flex-1")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
