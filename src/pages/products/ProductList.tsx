import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import {
  DataTable,
  SortableHeader,
  toSortParam,
} from "@/src/components/shared/DataTable";
import { FilterBar, FilterSelect, SearchInput } from "@/src/components/shared/Filters";
import { ProductStatusBadge } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { ConfirmDialog } from "@/src/components/shared/ConfirmDialog";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import { Checkbox } from "@/src/components/ui/checkbox";
import { useApi } from "@/src/hooks/useApi";
import { useCategories } from "@/src/hooks/useCategories";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";
import { api } from "@/src/lib/api";
import type { ProductQuery } from "@/shared/queries";
import { PRODUCT_STATUS_META } from "@/src/lib/labels";
import { formatInt, formatPriceRange, formatRelative } from "@/src/lib/format";
import type { Product, ProductStatus } from "@/src/types";

export default function ProductList() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  // 筛选条件与分页 —— 初始值支持从 URL 带入（概览页的低库存链接会用到）
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<string>(searchParams.get("status") ?? "all");
  const [categoryId, setCategoryId] = useState<string>(searchParams.get("categoryId") ?? "all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "updatedAt", desc: true }]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);
  const [batchAction, setBatchAction] = useState<"activate" | "deactivate" | "delete" | null>(null);

  const debouncedKeyword = useDebouncedValue(keyword, 300);
  const categories = useCategories();

  const query = useMemo<ProductQuery>(
    () => ({
      q: debouncedKeyword || undefined,
      status: status as ProductStatus | "all",
      categoryId,
      page,
      pageSize,
      ...toSortParam<NonNullable<ProductQuery["sortBy"]>>(sorting),
    }),
    [debouncedKeyword, status, categoryId, page, pageSize, sorting]
  );

  const { data, loading, error, source, reload } = useApi(
    () => api.listProducts(query),
    [query]
  );

  /** 筛选条件变化时回到第一页，否则会停在一个空页上 */
  const resetTo = useCallback((apply: () => void) => {
    apply();
    setPage(1);
    setSelectedIds([]);
  }, []);

  const handleDelete = async (product: Product) => {
    await api.deleteProduct(product.id);
    toast.success(`已删除商品「${product.title}」`);
    reload();
  };

  const handleBatch = async () => {
    if (!batchAction) return;
    const action = batchAction;
    const ids = selectedIds;

    if (action === "delete") {
      const { data: res } = await api.batchProducts(ids, "delete");
      toast.success(`已删除 ${res.affected} 个商品`);
    } else {
      const { data: res } = await api.batchProducts(ids, action);
      toast.success(
        `${action === "activate" ? "上架" : "下架"}成功，共 ${res.affected} 个商品`
      );
    }

    setSelectedIds([]);
    setBatchAction(null);
    reload();
  };

  const columns = useMemo<ColumnDef<Product, any>[]>(
    () => [
      {
        id: "select",
        size: 40,
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected()
                ? true
                : table.getIsSomeRowsSelected()
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
            aria-label="全选"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            aria-label="选择行"
          />
        ),
      },
      {
        id: "title",
        accessorKey: "title",
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            商品
          </SortableHeader>
        ),
        cell: ({ row }) => {
          const p = row.original;
          const totalStock = p.skus.reduce((n, s) => n + s.stock, 0);
          return (
            <div className="flex items-center gap-3 min-w-[260px]">
              <img
                src={p.mainImage}
                alt=""
                loading="lazy"
                className="h-10 w-10 shrink-0 rounded-md border border-slate-200 object-cover bg-slate-50"
              />
              <div className="min-w-0">
                <Link
                  to={`/products/${p.id}`}
                  className="block truncate text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors"
                >
                  {p.title}
                </Link>
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  <span className="font-mono">{p.spu}</span>
                  <span>·</span>
                  <span>{p.skus.length} 个 SKU</span>
                  <span>·</span>
                  <span className={totalStock > 0 ? "text-slate-500" : "text-rose-500"}>
                    库存 {formatInt(totalStock)}
                  </span>
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "categoryId",
        accessorKey: "categoryId",
        enableSorting: false,
        header: "类目",
        cell: ({ row }) => (
          <span className="text-xs text-slate-600">
            {categories.nameOf(row.original.categoryId)}
          </span>
        ),
      },
      {
        id: "brand",
        accessorKey: "brand",
        enableSorting: false,
        header: "品牌",
        cell: ({ row }) => (
          <span className="text-xs text-slate-600">{row.original.brand}</span>
        ),
      },
      {
        id: "price",
        enableSorting: true,
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            售价区间
          </SortableHeader>
        ),
        cell: ({ row }) => {
          const prices = row.original.skus.map((s) => s.price);
          return (
            <span className="tabular-nums text-xs font-medium text-slate-700">
              {prices.length ? formatPriceRange(Math.min(...prices), Math.max(...prices)) : "—"}
            </span>
          );
        },
      },
      {
        id: "stock",
        enableSorting: true,
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
            align="right"
            className="w-full justify-end"
          >
            总库存
          </SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums font-semibold text-slate-800">
            {formatInt(row.original.skus.reduce((n, s) => n + s.stock, 0))}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        enableSorting: false,
        header: "状态",
        cell: ({ row }) => <ProductStatusBadge status={row.original.status} />,
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            更新时间
          </SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {formatRelative(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: "actions",
        size: 120,
        enableSorting: false,
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="查看详情"
                onClick={() => navigate(`/products/${p.id}`)}
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="编辑"
                onClick={() => navigate(`/products/${p.id}/edit`)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-rose-600 hover:bg-rose-50"
                title="删除"
                onClick={() => setPendingDelete(p)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    [categories, navigate]
  );

  return (
    <>
      <PageHeader
        title="商品列表"
        description="SPU 主档管理。支持按类目、状态筛选与批量上下架。"
        meta={<SourceBadge source={source} />}
        actions={
          <Link to="/products/new">
            <Button>
              <Plus className="h-4 w-4 mr-1.5" />
              新建商品
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
        sorting={sorting}
        onSortingChange={setSorting}
        getRowId={(p) => p.id}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelectedIds}
        emptyTitle="没有匹配的商品"
        emptyDescription="试试放宽筛选条件，或新建一个商品。"
        toolbar={
          <FilterBar right={`共 ${formatInt(data?.total ?? 0)} 个 SPU`}>
            <SearchInput
              value={keyword}
              onChange={(v) => resetTo(() => setKeyword(v))}
              placeholder="搜索标题 / SPU / 品牌 / SKU 编码"
              className="w-72"
            />
            <FilterSelect
              value={categoryId}
              onChange={(v) => resetTo(() => setCategoryId(v))}
              options={categories.options}
              allLabel="全部类目"
            />
            <FilterSelect
              value={status}
              onChange={(v) => resetTo(() => setStatus(v))}
              options={Object.entries(PRODUCT_STATUS_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              allLabel="全部状态"
              className="w-[130px]"
            />
          </FilterBar>
        }
        selectionActions={(ids) => (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs bg-white"
              onClick={() => setBatchAction("activate")}
            >
              批量上架
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs bg-white"
              onClick={() => setBatchAction("deactivate")}
            >
              批量下架
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs bg-white text-rose-600 hover:bg-rose-50"
              onClick={() => setBatchAction("delete")}
            >
              批量删除
            </Button>
            <span className="text-[11px] text-blue-700/70 ml-1">已选 {ids.length} 项</span>
          </>
        )}
      />

      {/* 单个删除确认 */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="删除商品"
        description={
          pendingDelete
            ? `将删除「${pendingDelete.title}」及其 ${pendingDelete.skus.length} 个 SKU 的全部库存记录，该操作不可撤销。`
            : undefined
        }
        confirmLabel="确认删除"
        destructive
        onConfirm={() => (pendingDelete ? handleDelete(pendingDelete) : undefined)}
      />

      {/* 批量操作确认 */}
      <ConfirmDialog
        open={!!batchAction}
        onOpenChange={(open) => !open && setBatchAction(null)}
        title={
          batchAction === "delete"
            ? "批量删除商品"
            : batchAction === "activate"
              ? "批量上架"
              : "批量下架"
        }
        description={
          batchAction === "delete"
            ? `将删除选中的 ${selectedIds.length} 个商品及其库存记录，该操作不可撤销。`
            : `将把选中的 ${selectedIds.length} 个商品状态改为「${
                batchAction === "activate" ? "在售" : "已下架"
              }」。`
        }
        confirmLabel="确认执行"
        destructive={batchAction === "delete"}
        onConfirm={handleBatch}
      />
    </>
  );
}
