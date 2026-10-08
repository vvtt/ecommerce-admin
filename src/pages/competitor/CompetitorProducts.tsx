/**
 * 竞品商品列表页。
 *
 * 查询交互是「点查询按钮 / 回车」触发，而不是输入即查 —— 商品名往往要
 * 粘贴长串关键词，输入过程中不断打接口纯属浪费。不填条件点查询 =
 * 全量分页（q 为空时后端不加 WHERE）。
 */
import { useCallback, useMemo, useState } from "react";
import { Download, ExternalLink, Search } from "lucide-react";
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
import type { CompetitorProductSummary } from "@/src/types";

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
  /** 正在导出的行（shop_item），避免连点重复下载 */
  const [exporting, setExporting] = useState<string | null>(null);

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
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={url}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              打开
            </a>
          );
        },
      },
      {
        id: "actions",
        size: 80,
        enableSorting: false,
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => {
          const o = row.original;
          const key = `${o.shopId}_${o.itemId}`;
          return (
            <div className="flex items-center justify-end">
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
            </div>
          );
        },
      },
    ],
    // handleExport 每次渲染重建，与 ProductList/SourcingList 的写法一致不进依赖
    [exporting]
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
