import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

interface PageHeaderProps {
  title: string;
  /** 一句话说明这个页面能做什么 */
  description?: string;
  /** 标题右侧的操作按钮组 */
  actions?: ReactNode;
  /** 详情页的返回链接 */
  backTo?: string;
  backLabel?: string;
  /** 标题下方的附加内容，如状态徽章、编码 */
  meta?: ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  backTo,
  backLabel = "返回",
  meta,
}: PageHeaderProps) {
  return (
    <div className="mb-6 space-y-3">
      {backTo && (
        <Link
          to={backTo}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {backLabel}
        </Link>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5 min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 truncate">{title}</h1>
          {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
          {description && (
            <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
          )}
        </div>

        {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
