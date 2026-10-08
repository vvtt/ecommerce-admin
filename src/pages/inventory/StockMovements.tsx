import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { DataTable } from "@/src/components/shared/DataTable";
import { FilterBar, FilterSelect, SearchInput } from "@/src/components/shared/Filters";
import { MovementTypeBadge, WarehouseTag } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { useApi } from "@/src/hooks/useApi";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";
import { api, WAREHOUSE_OPTIONS } from "@/src/lib/api";
import { MOVEMENT_TYPE_META } from "@/src/lib/labels";
import { formatDateTime, formatDelta, formatInt } from "@/src/lib/format";
import type { MovementQuery } from "@/shared/queries";
import type { StockMovement, WarehouseCode } from "@/src/types";

export default function StockMovements() {
  const [searchParams] = useSearchParams();

  const [keyword, setKeyword] = useState(searchParams.get("q") ?? "");
  const [type, setType] = useState<string>(searchParams.get("type") ?? "all");
  const [warehouse, setWarehouse] = useState<string>(
    searchParams.get("warehouse") ?? "all"
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const debouncedKeyword = useDebouncedValue(keyword, 300);

  const query = useMemo<MovementQuery>(
    () => ({
      q: debouncedKeyword || undefined,
      type: type as MovementQuery["type"],
      warehouse: warehouse as WarehouseCode | "all",
      page,
      pageSize,
    }),
    [debouncedKeyword, type, warehouse, page, pageSize]
  );

  const { data, loading, error, source, reload } = useApi(
    () => api.listMovements(query),
    [query]
  );

  const resetTo = useCallback((apply: () => void) => {
    apply();
    setPage(1);
  }, []);

  const columns = useMemo<ColumnDef<StockMovement, any>[]>(
    () => [
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: "时间",
        cell: ({ row }) => (
          <span className="text-xs text-slate-500 whitespace-nowrap tabular-nums">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "type",
        accessorKey: "type",
        header: "类型",
        cell: ({ row }) => <MovementTypeBadge type={row.original.type} />,
      },
      {
        id: "product",
        header: "商品 / SKU",
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="min-w-[220px]">
              <p className="truncate text-sm font-medium text-slate-800">{m.productTitle}</p>
              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                <span className="font-mono">{m.skuCode}</span>
                {m.specText && (
                  <>
                    <span>·</span>
                    <span className="truncate max-w-[140px]">{m.specText}</span>
                  </>
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: "warehouse",
        accessorKey: "warehouse",
        header: "仓库",
        cell: ({ row }) => <WarehouseTag code={row.original.warehouse} />,
      },
      {
        id: "quantity",
        accessorKey: "quantity",
        header: () => <span className="block text-right">变动</span>,
        cell: ({ row }) => {
          const q = row.original.quantity;
          return (
            <span
              className={
                "block text-right tabular-nums text-sm font-bold " +
                (q > 0 ? "text-emerald-600" : q < 0 ? "text-rose-600" : "text-slate-600")
              }
            >
              {formatDelta(q)}
            </span>
          );
        },
      },
      {
        id: "beforeAfter",
        header: () => <span className="block text-right">变动前 → 后</span>,
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-xs text-slate-500 whitespace-nowrap">
            {formatInt(row.original.beforeQty)} → {formatInt(row.original.afterQty)}
          </span>
        ),
      },
      {
        id: "refNo",
        accessorKey: "refNo",
        header: "关联单号",
        cell: ({ row }) => {
          const refNo = row.original.refNo;
          // 采购入库流水可以点回采购单，其余单号仅展示
          if (refNo.startsWith("PO-")) {
            return (
              <Link
                to={`/purchase/${encodeURIComponent(refNo)}`}
                className="font-mono text-xs text-blue-600 hover:underline"
              >
                {refNo}
              </Link>
            );
          }
          return <span className="font-mono text-xs text-slate-600">{refNo}</span>;
        },
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
        id: "remark",
        accessorKey: "remark",
        header: "备注",
        cell: ({ row }) => (
          <span
            className="block max-w-[200px] truncate text-xs text-slate-500"
            title={row.original.remark}
          >
            {row.original.remark || "—"}
          </span>
        ),
      },
    ],
    []
  );

  return (
    <>
      <PageHeader
        title="库存流水"
        description="所有库存变动的审计轨迹：采购入库、订单出库、盘点调整、退货入库。记录只增不改。"
        meta={<SourceBadge source={source} />}
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
        getRowId={(m) => m.id}
        emptyTitle="没有匹配的流水"
        emptyDescription="调整库存或确认采购入库后，这里会出现对应记录。"
        toolbar={
          <FilterBar right={`共 ${formatInt(data?.total ?? 0)} 条流水`}>
            <SearchInput
              value={keyword}
              onChange={(v) => resetTo(() => setKeyword(v))}
              placeholder="搜索商品 / SKU / 单号 / 操作人"
              className="w-72"
            />
            <FilterSelect
              value={type}
              onChange={(v) => resetTo(() => setType(v))}
              options={Object.entries(MOVEMENT_TYPE_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              allLabel="全部类型"
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
