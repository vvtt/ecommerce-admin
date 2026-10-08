import type { ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import { EmptyState, ErrorState, TableLoading } from "@/src/components/shared/EmptyState";
import { cn } from "@/src/lib/utils";

const PAGE_SIZES = [10, 20, 50];

/**
 * 把 TanStack 的 sorting state 转成接口参数；未排序时返回空对象。
 *
 * 用泛型 K 约束可排序字段，这样列 id 与查询层的 sortBy 联合类型对不上时
 * 会在编译期报错，而不是静默按默认字段排序。
 */
export function toSortParam<K extends string = string>(
  sorting: SortingState
): { sortBy?: K; sortDir?: "asc" | "desc" } {
  const first = sorting[0];
  if (!first) return {};
  return { sortBy: first.id as K, sortDir: first.desc ? "desc" : "asc" };
}

/**
 * 可排序表头。
 * 排序是服务端算的（manualSorting），所以整个数据集排序正确，不只是当前页。
 */
export function SortableHeader({
  sorted,
  onToggle,
  children,
  align = "left",
  className,
}: {
  sorted: false | "asc" | "desc";
  onToggle: () => void;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors cursor-pointer",
        align === "right" && "flex-row-reverse",
        className
      )}
    >
      {children}
      {sorted === "asc" ? (
        <ArrowUp className="h-3 w-3 text-blue-600" />
      ) : sorted === "desc" ? (
        <ArrowDown className="h-3 w-3 text-blue-600" />
      ) : (
        <ChevronsUpDown className="h-3 w-3 text-slate-400" />
      )}
    </button>
  );
}

interface DataTableProps<T> {
  columns: ColumnDef<T, any>[];
  data: T[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;

  /* 服务端分页 —— 数据只有当前页，total 是全量匹配数 */
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;

  /* 服务端排序 */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;

  getRowId: (row: T) => string;
  /** 勾选行 id 受控传入 */
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;

  /** 表格上方的搜索/筛选工具条 */
  toolbar?: ReactNode;
  /** 有勾选时替换工具条显示的批量操作区 */
  selectionActions?: (selectedIds: string[]) => ReactNode;

  emptyTitle?: string;
  emptyDescription?: string;
  /** 表格下方左侧的补充说明 */
  footerNote?: ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  loading,
  error,
  onRetry,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  sorting = [],
  onSortingChange,
  getRowId,
  selectedIds,
  onSelectedIdsChange,
  toolbar,
  selectionActions,
  emptyTitle,
  emptyDescription,
  footerNote,
}: DataTableProps<T>) {
  const selectable = !!onSelectedIdsChange;

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      sorting,
      ...(selectable ? { rowSelection: Object.fromEntries((selectedIds ?? []).map((id) => [id, true])) } : {}),
    },
    // 筛选/排序/分页都在服务端做，前端只负责渲染当前页
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableRowSelection: selectable,
    onSortingChange: (updater) => {
      if (!onSortingChange) return;
      const next = typeof updater === "function" ? updater(sorting) : updater;
      onSortingChange(next);
    },
    onRowSelectionChange: (updater) => {
      if (!onSelectedIdsChange) return;
      const current = Object.fromEntries((selectedIds ?? []).map((id) => [id, true]));
      const next = typeof updater === "function" ? updater(current) : updater;
      // 只回传本页的 id —— 翻页/改筛选后不该保留已经看不见的选择
      onSelectedIdsChange(data.map(getRowId).filter((id) => next[id]));
    },
    getCoreRowModel: getCoreRowModel(),
  });

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const selected = selectedIds ?? [];
  const showSelectionBar = selectable && selected.length > 0 && !!selectionActions;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
      {showSelectionBar ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50/70 px-4 py-2.5">
          <span className="text-xs font-semibold text-blue-800">
            已选中 {selected.length} 项
          </span>
          <div className="flex items-center gap-2">{selectionActions(selected)}</div>
        </div>
      ) : (
        toolbar && <div className="border-b border-slate-200 px-4 py-3">{toolbar}</div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading ? (
        <TableLoading cols={columns.length} />
      ) : data.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} style={{ width: header.getSize() }}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-state={row.getIsSelected() ? "selected" : undefined}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* 分页条 */}
      {!error && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-2.5">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="tabular-nums">
              共 <span className="font-semibold text-slate-700">{total}</span> 条 · 当前 {from}-{to}
            </span>
            {footerNote}
          </div>

          <div className="flex items-center gap-3">
            {onPageSizeChange && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">每页</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => {
                    onPageSizeChange(Number(v));
                    onPageChange(1);
                  }}
                >
                  <SelectTrigger className="h-7 w-[68px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZES.map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-slate-600 tabular-nums px-1.5">
                {page} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2"
                disabled={page >= pageCount}
                onClick={() => onPageChange(page + 1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
