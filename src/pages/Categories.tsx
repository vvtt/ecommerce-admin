import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, FolderTree, Layers } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { StatCard } from "@/src/components/shared/StatCard";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { ErrorState } from "@/src/components/shared/EmptyState";
import { Button } from "@/src/components/ui/button";
import { Skeleton } from "@/src/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import { useApi } from "@/src/hooks/useApi";
import { api } from "@/src/lib/api";
import { formatInt } from "@/src/lib/format";
import { cn } from "@/src/lib/utils";
import type { Category } from "@/src/types";

export default function Categories() {
  const { data, loading, error, source, reload } = useApi(() => api.listCategories(), []);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const tree = data?.items ?? [];
  const topLevel = tree.length;
  const totalCount = tree.reduce(
    (n, top) => n + top.productCount + (top.children?.reduce((m, c) => m + c.productCount, 0) ?? 0),
    0
  );
  const avgCommission =
    tree.length > 0
      ? (
          tree.reduce((n, c) => n + c.commissionRate, 0) / tree.length
        ).toFixed(1)
      : "—";

  return (
    <>
      <PageHeader
        title="类目管理"
        description="两级类目树。商品必须挂在二级类目下，选择一级类目筛选时会自动包含其全部子类目。"
        meta={<SourceBadge source={source} />}
      />

      {error ? (
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={reload} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[104px] rounded-xl" />
              ))
            ) : (
              <>
                <StatCard
                  label="一级类目"
                  value={formatInt(topLevel)}
                  unit="个"
                  hint={`含 ${formatInt(totalCount)} 个在架商品`}
                  icon={<Layers className="h-4 w-4" />}
                  tone="blue"
                />
                <StatCard
                  label="二级类目"
                  value={formatInt(tree.reduce((n, c) => n + (c.children?.length ?? 0), 0))}
                  unit="个"
                  hint="商品实际挂载层级"
                  icon={<FolderTree className="h-4 w-4" />}
                  tone="violet"
                />
                <StatCard
                  label="平均佣金率"
                  value={`${avgCommission}%`}
                  hint="一级类目佣金率的算术平均"
                  tone="emerald"
                />
              </>
            )}
          </div>

          <div className="mt-6 rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">类目树</h2>
            </div>

            {loading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>类目名称</TableHead>
                    <TableHead>英文名</TableHead>
                    <TableHead>层级</TableHead>
                    <TableHead className="text-right">商品数</TableHead>
                    <TableHead className="text-right">佣金率</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tree.map((top) => (
                    <CategoryRows
                      key={top.id}
                      parent={top}
                      collapsed={!!collapsed[top.id]}
                      onToggle={() =>
                        setCollapsed((prev) => ({ ...prev, [top.id]: !prev[top.id] }))
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <p className="mt-3 text-[11px] text-slate-500">
            类目为平台基础数据，本模块只做只读展示与商品关联筛选；如需增删改，请在平台类目中心操作。
          </p>
        </>
      )}
    </>
  );
}

function CategoryRows({
  parent,
  collapsed,
  onToggle,
}: {
  parent: Category;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const children = parent.children ?? [];
  const hasChildren = children.length > 0;

  return (
    <>
      <TableRow className="bg-slate-50/60 hover:bg-slate-50">
        <TableCell>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              disabled={!hasChildren}
              className={cn(
                "rounded p-0.5 transition-colors",
                hasChildren
                  ? "text-slate-500 hover:bg-slate-200 hover:text-slate-800 cursor-pointer"
                  : "text-transparent"
              )}
              title={hasChildren ? (collapsed ? "展开子类目" : "折叠子类目") : undefined}
            >
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
            <span className="text-sm font-semibold text-slate-800">{parent.name}</span>
            {hasChildren && (
              <span className="text-[11px] text-slate-400">{children.length} 个子类目</span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-xs text-slate-500">{parent.nameEn}</TableCell>
        <TableCell>
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">
            一级
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums text-sm font-semibold text-slate-800">
          {formatInt(parent.productCount)}
        </TableCell>
        <TableCell className="text-right tabular-nums text-xs text-slate-600">
          {parent.commissionRate}%
        </TableCell>
        <TableCell>
          <Link to={`/products?categoryId=${encodeURIComponent(parent.id)}`}>
            <Button variant="ghost" size="sm" className="h-7 text-xs">
              查看商品
            </Button>
          </Link>
        </TableCell>
      </TableRow>

      {!collapsed &&
        children.map((child) => (
          <TableRow key={child.id}>
            <TableCell>
              <div className="flex items-center gap-2 pl-7">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                <span className="text-sm text-slate-700">{child.name}</span>
              </div>
            </TableCell>
            <TableCell className="text-xs text-slate-500">{child.nameEn}</TableCell>
            <TableCell>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                二级
              </span>
            </TableCell>
            <TableCell className="text-right tabular-nums text-sm text-slate-700">
              {formatInt(child.productCount)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-xs text-slate-500">
              {child.commissionRate}%
            </TableCell>
            <TableCell>
              <Link to={`/products?categoryId=${encodeURIComponent(child.id)}`}>
                <Button variant="ghost" size="sm" className="h-7 text-xs">
                  查看商品
                </Button>
              </Link>
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}
