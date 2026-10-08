import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { TableSkeleton } from "@/src/components/ui/skeleton";

/** 空结果：筛选太严格或确实没有数据 */
export function EmptyState({
  title = "暂无数据",
  description,
  action,
  icon,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? <Inbox className="h-6 w-6" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {description && <p className="text-xs text-slate-500 max-w-sm">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * 请求失败。与 EmptyState 分开，因为「加载失败」需要给重试入口，
 * 而不是让用户以为数据本来就是空的。
 */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-500">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-800">加载失败</p>
        <p className="text-xs text-slate-500 max-w-md break-words">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          重试
        </Button>
      )}
    </div>
  );
}

/** 表格加载态：用骨架屏撑住高度，避免筛选时页面跳动 */
export function TableLoading({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="py-3">
      <TableSkeleton rows={rows} cols={cols} />
    </div>
  );
}
