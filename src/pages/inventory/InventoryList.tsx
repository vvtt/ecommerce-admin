import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { DataTable, SortableHeader, toSortParam } from "@/src/components/shared/DataTable";
import { FilterBar, FilterSelect, SearchInput } from "@/src/components/shared/Filters";
import { StockHealthBadge, WarehouseTag } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { ErrorState } from "@/src/components/shared/EmptyState";
import { StatCard } from "@/src/components/shared/StatCard";
import { Button } from "@/src/components/ui/button";
import { Skeleton } from "@/src/components/ui/skeleton";
import { useApi } from "@/src/hooks/useApi";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";
import { api, WAREHOUSE_OPTIONS } from "@/src/lib/api";
import { STOCK_HEALTH_META } from "@/src/lib/labels";
import { formatCny, formatInt, formatRelative } from "@/src/lib/format";
import { StockAdjustDialog } from "@/src/pages/inventory/StockAdjustDialog";
import type { InventoryQuery } from "@/shared/queries";
import type { InventoryRecord, WarehouseCode } from "@/src/types";

export default function InventoryList() {
  const [searchParams] = useSearchParams();

  const [keyword, setKeyword] = useState(searchParams.get("q") ?? "");
  const [warehouse, setWarehouse] = useState<string>(
    searchParams.get("warehouse") ?? "all"
  );
  const [health, setHealth] = useState<string>(searchParams.get("health") ?? "all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "available", desc: false }]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<InventoryRecord | null>(null);

  const debouncedKeyword = useDebouncedValue(keyword, 300);

  const query = useMemo<InventoryQuery>(
    () => ({
      q: debouncedKeyword || undefined,
      warehouse: warehouse as WarehouseCode | "all",
      health: health as InventoryQuery["health"],
      page,
      pageSize,
      ...toSortParam<NonNullable<InventoryQuery["sortBy"]>>(sorting),
    }),
    [debouncedKeyword, warehouse, health, page, pageSize, sorting]
  );

  const { data, loading, error, source, reload } = useApi(
    () => api.listInventory(query),
    [query]
  );

  const summary = useApi(() => api.getInventorySummary(), []);
  const kpi = summary.data;

  const resetTo = useCallback((apply: () => void) => {
    apply();
    setPage(1);
  }, []);

  const columns = useMemo<ColumnDef<InventoryRecord, any>[]>(
    () => [
      {
        id: "productTitle",
        accessorKey: "productTitle",
        enableSorting: false,
        header: "商品 / SKU",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex items-center gap-3 min-w-[280px]">
              <img
                src={r.image}
                alt=""
                loading="lazy"
                className="h-10 w-10 shrink-0 rounded-md border border-slate-200 object-cover bg-slate-50"
              />
              <div className="min-w-0">
                <Link
                  to={`/products/${r.productId}`}
                  className="block truncate text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors"
                >
                  {r.productTitle}
                </Link>
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  <span className="font-mono">{r.skuCode}</span>
                  {r.specText && (
                    <>
                      <span>·</span>
                      <span className="truncate max-w-[140px]">{r.specText}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "warehouse",
        accessorKey: "warehouse",
        enableSorting: false,
        header: "仓库",
        cell: ({ row }) => <WarehouseTag code={row.original.warehouse} />,
      },
      {
        id: "onHand",
        accessorKey: "onHand",
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
            align="right"
            className="w-full justify-end"
          >
            在手
          </SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-sm text-slate-700">
            {formatInt(row.original.onHand)}
          </span>
        ),
      },
      {
        id: "locked",
        accessorKey: "locked",
        enableSorting: false,
        header: () => <span className="block text-right">占用</span>,
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-sm text-slate-500">
            {formatInt(row.original.locked)}
          </span>
        ),
      },
      {
        id: "available",
        accessorKey: "available",
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
            align="right"
            className="w-full justify-end"
          >
            可用
          </SortableHeader>
        ),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span
              className={
                "block text-right tabular-nums text-sm font-semibold " +
                (r.health === "out"
                  ? "text-rose-600"
                  : r.health === "low"
                    ? "text-amber-600"
                    : "text-slate-800")
              }
            >
              {formatInt(r.available)}
            </span>
          );
        },
      },
      {
        id: "safetyStock",
        accessorKey: "safetyStock",
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
            align="right"
            className="w-full justify-end"
          >
            安全库存
          </SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-sm text-slate-500">
            {formatInt(row.original.safetyStock)}
          </span>
        ),
      },
      {
        id: "health",
        accessorKey: "health",
        enableSorting: false,
        header: "状态",
        cell: ({ row }) => <StockHealthBadge health={row.original.health} />,
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        enableSorting: false,
        header: "更新时间",
        cell: ({ row }) => (
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {formatRelative(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: "actions",
        size: 110,
        enableSorting: false,
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setEditing(row.original)}
            >
              <SlidersHorizontal className="h-3 w-3 mr-1" />
              调整
            </Button>
          </div>
        ),
      },
    ],
    []
  );

  return (
    <>
      <PageHeader
        title="库存总览"
        description="按 SKU × 仓库列出库存明细。调整在手量会写入一条盘点调整流水，可用于对账。"
        meta={<SourceBadge source={source} />}
      />

      {/* 汇总 KPI */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.loading || !kpi ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))
        ) : (
          <>
            <StatCard
              label="在管 SKU"
              value={formatInt(kpi.totalSkus)}
              unit="个"
              hint={`在手 ${formatInt(kpi.totalOnHand)} 件`}
              tone="blue"
            />
            <StatCard
              label="可售库存"
              value={formatInt(kpi.totalAvailable)}
              unit="件"
              hint={`订单占用 ${formatInt(kpi.totalLocked)} 件`}
              tone="emerald"
            />
            <StatCard
              label="库存成本总额"
              value={formatCny(kpi.stockValueCny)}
              hint={`预计周转 ${kpi.turnoverDays} 天`}
              tone="violet"
            />
            <StatCard
              label="库存告急"
              value={formatInt(kpi.lowStockCount + kpi.outOfStockCount)}
              unit="个 SKU"
              hint={`其中缺货 ${kpi.outOfStockCount} 个`}
              tone={kpi.outOfStockCount > 0 ? "rose" : "amber"}
            />
          </>
        )}
      </div>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        loading={loading}
        error={error}
        onRetry={reload}
        total={data?.total ?? 0}
        page={data?.page ?? page}
        pageSize={data?.pageSize ?? pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        sorting={sorting}
        onSortingChange={setSorting}
        getRowId={(r) => r.id}
        emptyTitle="没有匹配的库存记录"
        emptyDescription="试试换个仓库或状态筛选。新建商品会自动在国内主仓建立 0 库存记录。"
        toolbar={
          <FilterBar right={`共 ${formatInt(data?.total ?? 0)} 条记录`}>
            <SearchInput
              value={keyword}
              onChange={(v) => resetTo(() => setKeyword(v))}
              placeholder="搜索商品 / SKU 编码 / 规格"
              className="w-72"
            />
            <FilterSelect
              value={warehouse}
              onChange={(v) => resetTo(() => setWarehouse(v))}
              options={WAREHOUSE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              allLabel="全部仓库"
            />
            <FilterSelect
              value={health}
              onChange={(v) => resetTo(() => setHealth(v))}
              options={Object.entries(STOCK_HEALTH_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              allLabel="全部状态"
              className="w-[140px]"
            />
          </FilterBar>
        }
      />

      {summary.error && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          汇总指标加载失败：{summary.error}
        </div>
      )}

      <StockAdjustDialog
        record={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        onDone={() => {
          reload();
          summary.reload();
        }}
      />
    </>
  );
}
