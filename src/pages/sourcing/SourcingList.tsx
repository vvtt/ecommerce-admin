import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Eye, ImageDown, Trash2 } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import {
  DataTable,
  SortableHeader,
  toSortParam,
} from "@/src/components/shared/DataTable";
import { FilterBar, FilterSelect, SearchInput } from "@/src/components/shared/Filters";
import { ImageStatusBadge, SourcePlatformBadge } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { ConfirmDialog } from "@/src/components/shared/ConfirmDialog";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import { Checkbox } from "@/src/components/ui/checkbox";
import { useApi } from "@/src/hooks/useApi";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";
import { api } from "@/src/lib/api";
import {
  IMAGE_STATUS_META,
  SOURCE_PLATFORM_META,
  SOURCE_PLATFORMS,
} from "@/src/lib/labels";
import { formatCnyRange, formatInt, formatRelative } from "@/src/lib/format";
import { cn } from "@/src/lib/utils";
import type { ImageStatus, SourcingOfferSummary, SourcingQuery } from "@/src/types";

export default function SourcingList() {
  const navigate = useNavigate();
  const toast = useToast();

  const [keyword, setKeyword] = useState("");
  const [platform, setPlatform] = useState<string>("all");
  const [imageStatus, setImageStatus] = useState<string>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "collectedAt", desc: true }]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<SourcingOfferSummary | null>(null);
  const [batchDelete, setBatchDelete] = useState(false);
  /** 正在重跑图片转存的 offer，避免连点重复提交 */
  const [reingesting, setReingesting] = useState<string | null>(null);

  const debouncedKeyword = useDebouncedValue(keyword, 300);

  const query = useMemo<SourcingQuery>(
    () => ({
      q: debouncedKeyword || undefined,
      platform: platform as SourcingQuery["platform"],
      imageStatus: imageStatus as SourcingQuery["imageStatus"],
      page,
      pageSize,
      ...toSortParam<NonNullable<SourcingQuery["sortBy"]>>(sorting),
    }),
    [debouncedKeyword, platform, imageStatus, page, pageSize, sorting]
  );

  const { data, loading, error, source, reload } = useApi(
    () => api.listSourcingOffers(query),
    [query]
  );

  /** 筛选条件变化时回到第一页，否则会停在一个空页上 */
  const resetTo = useCallback((apply: () => void) => {
    apply();
    setPage(1);
    setSelectedIds([]);
  }, []);

  /** 删除不 catch：失败时让 ConfirmDialog 接住并把错误显示在弹窗里 */
  const handleDelete = async (offer: SourcingOfferSummary) => {
    await api.deleteSourcingOffer(offer.id);
    toast.success(`已删除货源「${offer.title}」`);
    reload();
  };

  const handleBatchDelete = async () => {
    const { data: res } = await api.batchDeleteSourcingOffers(selectedIds);
    toast.success(`已删除 ${res.affected} 条货源`);
    setSelectedIds([]);
    setBatchDelete(false);
    reload();
  };

  const handleReingest = async (offer: SourcingOfferSummary) => {
    setReingesting(offer.id);
    try {
      const { data: res } = await api.reingestSourcingImages(offer.id);
      // 接口是异步返回的，此刻图片还在后台下载，说"已在转存"而不是"已完成"
      toast.success(`已重新提交 ${res.resetImages} 张图片，正在后台转存`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新转存失败");
    } finally {
      setReingesting(null);
      reload();
    }
  };

  const columns = useMemo<ColumnDef<SourcingOfferSummary, any>[]>(
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
            货源
          </SortableHeader>
        ),
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="flex items-center gap-3 min-w-[280px]">
              {/* 转存未完成或失败时 thumbnail 是空串，用灰底占位而不是显示裂图 */}
              {o.thumbnail ? (
                <img
                  src={o.thumbnail}
                  alt=""
                  loading="lazy"
                  className="h-10 w-10 shrink-0 rounded-md border border-slate-200 object-cover bg-slate-50"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-slate-300">
                  <ImageDown className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0">
                <Link
                  to={`/sourcing/${o.id}`}
                  className="block truncate text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors"
                >
                  {o.title || "(无标题)"}
                </Link>
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  <span className="font-mono">{o.offerId}</span>
                  <span>·</span>
                  <span>{o.skuCount} 个 SKU</span>
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "platform",
        enableSorting: false,
        header: "来源",
        cell: ({ row }) => <SourcePlatformBadge platform={row.original.platform} />,
      },
      {
        id: "supplier",
        enableSorting: false,
        header: "供应商",
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="min-w-0">
              <p className="truncate text-xs text-slate-700 max-w-[180px]">
                {o.supplierName || "—"}
              </p>
              {o.supplierLocation && (
                <p className="text-[11px] text-slate-400">{o.supplierLocation}</p>
              )}
            </div>
          );
        },
      },
      {
        id: "priceMin",
        enableSorting: true,
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            采购价
          </SortableHeader>
        ),
        cell: ({ row }) => {
          const o = row.original;
          if (o.priceMin === undefined) {
            return <span className="text-xs text-slate-400">价格未知</span>;
          }
          return (
            <span className="tabular-nums text-xs font-medium text-slate-700 whitespace-nowrap">
              {formatCnyRange(o.priceMin, o.priceMax ?? o.priceMin)}
            </span>
          );
        },
      },
      {
        id: "moq",
        enableSorting: true,
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
            align="right"
            className="w-full justify-end"
          >
            起订量
          </SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-xs text-slate-700">
            {row.original.moq === undefined ? "—" : formatInt(row.original.moq)}
          </span>
        ),
      },
      {
        id: "imageStatus",
        enableSorting: false,
        header: "图片",
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <ImageStatusBadge status={o.imageStatus} short />
              <span className="text-[11px] text-slate-400 tabular-nums">
                {o.imageOkCount > 0 && `${o.imageOkCount} 成功`}
                {o.imageFailCount > 0 && (
                  <span className={cn(o.imageOkCount > 0 && "ml-1", "text-rose-500")}>
                    {o.imageFailCount} 失败
                  </span>
                )}
              </span>
            </div>
          );
        },
      },
      {
        id: "collectedAt",
        accessorKey: "collectedAt",
        header: ({ column }) => (
          <SortableHeader
            sorted={column.getIsSorted()}
            onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            采集时间
          </SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {formatRelative(row.original.collectedAt)}
          </span>
        ),
      },
      {
        id: "actions",
        size: 130,
        enableSorting: false,
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="查看详情"
                onClick={() => navigate(`/sourcing/${o.id}`)}
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="重新转存图片"
                disabled={reingesting === o.id}
                onClick={() => handleReingest(o)}
              >
                <ImageDown
                  className={cn("h-3.5 w-3.5", reingesting === o.id && "animate-pulse")}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-rose-600 hover:bg-rose-50"
                title="删除"
                onClick={() => setPendingDelete(o)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    // 只依赖真正会变的东西：navigate 稳定，reingesting 变了要重画按钮的禁用态。
    // handleReingest 不进依赖 —— 它每次渲染都会重建，加进来会让 columns 每帧重算，
    // 与 ProductList 的写法一致。
    [navigate, reingesting]
  );

  return (
    <>
      <PageHeader
        title="货源库"
        description="从 1688 商品页采集的货源。图片已转存到本地，原站图失效也不影响查看。"
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
        sorting={sorting}
        onSortingChange={setSorting}
        getRowId={(o) => o.id}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelectedIds}
        emptyTitle="货源库还是空的"
        emptyDescription="在 1688 商品详情页用采集扩展抓一条，数据就会出现在这里。"
        toolbar={
          <FilterBar right={`共 ${formatInt(data?.total ?? 0)} 条货源`}>
            <SearchInput
              value={keyword}
              onChange={(v) => resetTo(() => setKeyword(v))}
              placeholder="搜索标题 / offerId / 供应商"
              className="w-72"
            />
            <FilterSelect
              value={platform}
              onChange={(v) => resetTo(() => setPlatform(v))}
              options={SOURCE_PLATFORMS.map((p) => ({
                value: p,
                label: SOURCE_PLATFORM_META[p].label,
              }))}
              allLabel="全部平台"
              className="w-[130px]"
            />
            <FilterSelect
              value={imageStatus}
              onChange={(v) => resetTo(() => setImageStatus(v))}
              options={Object.entries(IMAGE_STATUS_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
              allLabel="全部图片状态"
              className="w-[150px]"
            />
          </FilterBar>
        }
        selectionActions={(ids) => (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs bg-white text-rose-600 hover:bg-rose-50"
              onClick={() => setBatchDelete(true)}
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
        title="删除货源"
        description={
          pendingDelete
            ? `将删除「${pendingDelete.title || pendingDelete.offerId}」及其已转存的全部图片文件，该操作不可撤销。`
            : undefined
        }
        confirmLabel="确认删除"
        destructive
        onConfirm={() => (pendingDelete ? handleDelete(pendingDelete) : undefined)}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={batchDelete}
        onOpenChange={setBatchDelete}
        title="批量删除货源"
        description={`将删除选中的 ${selectedIds.length} 条货源及其图片文件，该操作不可撤销。`}
        confirmLabel="确认删除"
        destructive
        onConfirm={handleBatchDelete}
      />
    </>
  );
}
