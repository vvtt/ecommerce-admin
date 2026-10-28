/**
 * 竞品商品列表页。
 *
 * 查询交互是「点查询按钮 / 回车」触发，而不是输入即查 —— 商品名往往要
 * 粘贴长串关键词，输入过程中不断打接口纯属浪费。不填条件点查询 =
 * 全量分页（q 为空时后端不加 WHERE）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, ExternalLink, ListChecks, Search, Square, Trash2 } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { DataTable } from "@/src/components/shared/DataTable";
import { FilterBar, SearchInput } from "@/src/components/shared/Filters";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import { useApi } from "@/src/hooks/useApi";
import { api } from "@/src/lib/api";
import { downloadCompetitorTxt } from "@/src/lib/competitor-export";
import { formatInt } from "@/src/lib/format";
import type { CompetitorProductSummary, RatingsBatchState } from "@/src/types";

/** 价格展示：单一价直接显示，min/max 存在且不同时显示区间 */
function PriceCell({ item }: { item: CompetitorProductSummary }) {
  if (item.price === undefined && item.priceMin === undefined) {
    return <span className="text-xs text-slate-400">价格未知</span>;
  }
  const symbol = item.currency || "";
  const showRange =
    item.priceMin !== undefined &&
    item.priceMax !== undefined &&
    item.priceMin !== item.priceMax;
  const text = showRange
    ? `${item.priceMin!.toFixed(2)} ~ ${item.priceMax!.toFixed(2)}`
    : (item.price ?? item.priceMin)!.toFixed(2);
  return (
    <span className="whitespace-nowrap text-xs font-medium tabular-nums text-slate-700">
      {symbol === "TWD" ? "NT$" : `${symbol} `}
      {text}
    </span>
  );
}

export default function CompetitorProducts() {
  const toast = useToast();

  const [keyword, setKeyword] = useState("");
  /** 已提交到接口的查询条件。与输入框分离，点「查询」/回车才生效 */
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  /** 正在导出/删除的行（shop_item），避免连点重复操作 */
  const [exporting, setExporting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      q: appliedKeyword || undefined,
      page,
      pageSize,
    }),
    [appliedKeyword, page, pageSize]
  );

  const { data, loading, error, source, reload } = useApi(
    () => api.listCompetitorProducts(query),
    [query]
  );

  /** 查询条件变化时回第一页，避免停在空页上 */
  const applySearch = useCallback(() => {
    setAppliedKeyword(keyword.trim());
    setPage(1);
  }, [keyword]);

  /** 导出走详情接口拿完整数据，前端拼 txt 触发下载 */
  const handleExport = async (item: CompetitorProductSummary) => {
    const key = `${item.shopId}_${item.itemId}`;
    setExporting(key);
    try {
      const { data: detail } = await api.getCompetitorProduct(item.shopId, item.itemId);
      downloadCompetitorTxt(detail);
      toast.success(`已导出「${item.name || detail.itemId}」`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(null);
    }
  };

  /** 删除单条：DB 只删索引行，落盘原始文件保留（误删可从源头恢复） */
  const handleDelete = async (item: CompetitorProductSummary) => {
    const label = item.name || item.itemId;
    if (!window.confirm(`确定删除「${label}」？落盘的原始采集文件会保留，误删可恢复。`)) return;
    const key = `${item.shopId}_${item.itemId}`;
    setDeleting(key);
    try {
      await api.deleteCompetitorProduct(item.shopId, item.itemId);
      toast.success(`已删除「${label}」`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(null);
    }
  };

  /* ---------------- 批量评论采集 ----------------
   * 进度挂浏览器状态接口里，轮询节奏与 BrowserConsole 一致（3 秒）。
   * 跑批结束时刷新列表，让新采到评论的商品行立即反映 reviewCount。 */
  const [batch, setBatch] = useState<RatingsBatchState | null>(null);
  const prevRunningRef = useRef(false);

  const refreshBatch = useCallback(async () => {
    try {
      const { data } = await api.getBrowserStatus();
      setBatch(data.ratingsBatch);
    } catch {
      // 轮询失败静默：进度条不是关键路径，下一轮会再试
    }
  }, []);

  useEffect(() => {
    void refreshBatch();
    const timer = setInterval(() => void refreshBatch(), 3000);
    return () => clearInterval(timer);
  }, [refreshBatch]);

  useEffect(() => {
    if (prevRunningRef.current && batch && !batch.running) {
      reload();
      if (batch.failed > 0) {
        toast.info(`批量评论结束：成功 ${batch.success}，失败 ${batch.failed}`);
      } else if (batch.done > 0) {
        toast.success(`批量评论结束：成功采集 ${batch.success} 个商品`);
      }
    }
    prevRunningRef.current = batch?.running ?? false;
  }, [batch, reload, toast]);

  const handleStartBatch = useCallback(async () => {
    try {
      const { data } = await api.startRatingsBatch({ limit: 50 });
      toast.success(data.message);
      void refreshBatch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "启动失败");
    }
  }, [toast, refreshBatch]);

  const handleStopBatch = useCallback(async () => {
    try {
      await api.stopRatingsBatch();
      toast.info("已请求停止，当前商品采完即退出");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "停止失败");
    }
  }, [toast]);

  const columns = useMemo<ColumnDef<CompetitorProductSummary, any>[]>(
    () => [
      {
        id: "itemId",
        accessorKey: "itemId",
        header: "商品ID",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-slate-600">{row.original.itemId}</span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => (
          <span className="block max-w-[320px] truncate text-sm text-slate-800" title={row.original.name}>
            {row.original.name || "—"}
          </span>
        ),
      },
      {
        id: "categoryPath",
        accessorKey: "categoryPath",
        header: "分类",
        cell: ({ row }) => (
          <span
            className="block max-w-[240px] truncate text-xs text-slate-600"
            title={row.original.categoryPath}
          >
            {row.original.categoryPath || "—"}
          </span>
        ),
      },
      {
        id: "price",
        enableSorting: false,
        header: "价格",
        cell: ({ row }) => <PriceCell item={row.original} />,
      },
      {
        id: "url",
        enableSorting: false,
        header: "链接",
        cell: ({ row }) => {
          const url = row.original.url;
          if (!url) return <span className="text-xs text-slate-400">—</span>;
          return (
            <Link
              to={`/competitor/browser?url=${encodeURIComponent(url)}`}
              title={`在内嵌浏览器打开：${url}`}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              打开
            </Link>
          );
        },
      },
      {
        id: "actions",
        size: 96,
        enableSorting: false,
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => {
          const o = row.original;
          const key = `${o.shopId}_${o.itemId}`;
          return (
            <div className="flex items-center justify-end gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="导出 txt"
                disabled={exporting === key}
                onClick={() => handleExport(o)}
              >
                <Download className={exporting === key ? "h-3.5 w-3.5 animate-pulse" : "h-3.5 w-3.5"} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-400 hover:text-rose-600"
                title="删除该竞品"
                disabled={deleting === key}
                onClick={() => handleDelete(o)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    // handleExport/handleDelete 每次渲染重建，与 ProductList/SourcingList 的写法一致不进依赖
    [exporting, deleting]
  );

  return (
    <>
      <PageHeader
        title="竞品商品"
        description="通过 Shopee 采集扩展抓取的竞品商品库，可单条导出 txt 供分析。"
        meta={<span className="text-xs text-slate-500">数据来源：Shopee 采集扩展</span>}
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
        getRowId={(o) => `${o.shopId}_${o.itemId}`}
        emptyTitle="竞品库还是空的"
        emptyDescription="在 Shopee 商品详情页用采集扩展抓一条，数据就会出现在这里。"
        toolbar={
          <FilterBar right={`共 ${formatInt(data?.total ?? 0)} 条竞品`}>
            {batch?.running ? (
              <div className="flex items-center gap-2">
                {batch.waitingCaptcha && (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                    等待过验证码（去 Edge 窗口滑一下）
                  </span>
                )}
                <span className="whitespace-nowrap text-xs text-slate-600">
                  采评论中 {batch.done}/{batch.total} · 成 {batch.success} 败 {batch.failed} · 评{batch.reviews}条
                </span>
                <span
                  className="hidden max-w-[260px] truncate text-xs text-slate-400 lg:inline"
                  title={`${batch.currentStep ?? ""} ${batch.currentItem ?? ""}`}
                >
                  {[batch.currentStep, batch.currentItem].filter(Boolean).join(" · ")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 gap-1.5"
                  onClick={handleStopBatch}
                >
                  <Square className="h-3 w-3" />
                  停止
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5"
                title="逐个打开还没采过评论的商品页，自动滚动+翻页采集评论（每商品间隔 5~10 秒）"
                onClick={handleStartBatch}
              >
                <ListChecks className="h-3.5 w-3.5" />
                批量采评论
              </Button>
            )}
            <SearchInput
              value={keyword}
              onChange={setKeyword}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
              placeholder="按商品名模糊查询"
              className="w-72"
            />
            <Button size="sm" className="h-9 gap-1.5" onClick={applySearch}>
              <Search className="h-3.5 w-3.5" />
              查询
            </Button>
            {(keyword || appliedKeyword) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-slate-500"
                onClick={() => {
                  // 清空 = 回到全量：输入框与已提交条件一起复位
                  setKeyword("");
                  setAppliedKeyword("");
                  setPage(1);
                }}
              >
                清空
              </Button>
            )}
          </FilterBar>
        }
      />
    </>
  );
}
