import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { DataTable } from "@/src/components/shared/DataTable";
import { FilterBar, FilterSelect, SearchInput } from "@/src/components/shared/Filters";
import { PurchaseStatusBadge, WarehouseTag } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { Button } from "@/src/components/ui/button";
import { useApi } from "@/src/hooks/useApi";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";
import { api, WAREHOUSE_OPTIONS } from "@/src/lib/api";
import { PURCHASE_STATUS_META } from "@/src/lib/labels";
import { formatCny, formatDate, formatInt } from "@/src/lib/format";
import { PurchaseActions } from "@/src/pages/purchase/PurchaseActions";
import type { PurchaseQuery } from "@/shared/queries";
import type { PurchaseOrder, WarehouseCode } from "@/src/types";

export default function PurchaseList() {
  const [searchParams] = useSearchParams();

  const [keyword, setKeyword] = useState(searchParams.get("q") ?? "");
  const [status, setStatus] = useState<string>(searchParams.get("status") ?? "all");
  const [warehouse, setWarehouse] = useState<string>(
    searchParams.get("warehouse") ?? "all"
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const debouncedKeyword = useDebouncedValue(keyword, 300);

  const query = useMemo<PurchaseQuery>(
    () => ({
      q: debouncedKeyword || undefined,
      status: status as PurchaseQuery["status"],
      warehouse: warehouse as WarehouseCode | "all",
      page,
      pageSize,
    }),
    [debouncedKeyword, status, warehouse, page, pageSize]
  );

  const { data, loading, error, source, reload } = useApi(
    () => api.listPurchaseOrders(query),
    [query]
  );

  const resetTo = useCallback((apply: () => void) => {
    apply();
    setPage(1);
  }, []);

  const columns = useMemo<ColumnDef<PurchaseOrder, any>[]>(
    () => [
      {
        id: "poNo",
        accessorKey: "poNo",
        header: "采购单号",
        cell: ({ row }) => {
          const po = row.original;
          return (
            <div className="min-w-[170px]">
              <Link
                to={`/purchase/${po.id}`}
                className="block font-mono text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors"
              >
                {po.poNo}
              </Link>
              <span className="text-[11px] text-slate-500">
                {po.items.length} 个 SKU · {formatInt(po.totalQuantity)} 件
              </span>
            </div>
          );
        },
      },
      {
        id: "supplier",
        accessorKey: "supplier",
        header: "供应商",
        cell: ({ row }) => (
          <span className="block max-w-[200px] truncate text-xs text-slate-700">
            {row.original.supplier}
          </span>
        ),
      },
      {
        id: "warehouse",
        accessorKey: "warehouse",
        header: "目的仓",
        cell: ({ row }) => <WarehouseTag code={row.original.warehouse} />,
      },
      {
        id: "totalAmount",
        accessorKey: "totalAmount",
        header: () => <span className="block text-right">采购金额</span>,
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-sm font-semibold text-slate-800">
            {formatCny(row.original.totalAmount)}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => <PurchaseStatusBadge status={row.original.status} />,
      },
      {
        id: "expectedAt",
        accessorKey: "expectedAt",
        header: "预计到货",
        cell: ({ row }) => (
          <span className="text-xs text-slate-600 whitespace-nowrap tabular-nums">
            {formatDate(row.original.expectedAt)}
          </span>
        ),
      },
      {
        id: "operator",
        accessorKey: "operator",
        header: "操作人",
        cell: ({ row }) => (
          <span className="text-xs text-slate-600 whitespace-nowrap">
            {row.original.operator}
          </span>
        ),
      },
      {
        id: "actions",
        size: 200,
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => (
          <PurchaseActions order={row.original} onDone={reload} primaryOnly />
        ),
      },
    ],
    [reload]
  );

  return (
    <>
      <PageHeader
        title="采购单"
        description="补货单据与状态流转。确认入库会真实增加目的仓库存并写入采购入库流水。"
        meta={<SourceBadge source={source} />}
        actions={
          <Link to="/purchase/new">
            <Button>
              <Plus className="h-4 w-4 mr-1.5" />
              新建采购单
            </Button>
          </Link>
        }
      />

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
        getRowId={(po) => po.id}
        emptyTitle="没有匹配的采购单"
        emptyDescription="换个筛选条件，或新建一张采购单。"
        toolbar={
          <FilterBar right={`共 ${formatInt(data?.total ?? 0)} 张采购单`}>
            <SearchInput
              value={keyword}
              onChange={(v) => resetTo(() => setKeyword(v))}
              placeholder="搜索单号 / 供应商 / SKU 编码"
              className="w-72"
            />
            <FilterSelect
              value={status}
              onChange={(v) => resetTo(() => setStatus(v))}
              options={Object.entries(PURCHASE_STATUS_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              allLabel="全部状态"
              className="w-[140px]"
            />
            <FilterSelect
              value={warehouse}
              onChange={(v) => resetTo(() => setWarehouse(v))}
              options={WAREHOUSE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              allLabel="全部仓库"
            />
          </FilterBar>
        }
      />
    </>
  );
}
