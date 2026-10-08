import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ExternalLink, ImageDown, Store, Trash2 } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import {
  ImageStatusBadge,
  SourcePlatformBadge,
} from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { EmptyState, ErrorState } from "@/src/components/shared/EmptyState";
import { ConfirmDialog } from "@/src/components/shared/ConfirmDialog";
import { useToast } from "@/src/components/shared/Toast";
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
import { SourcingImages, ImageSummaryBadges } from "@/src/pages/sourcing/SourcingImages";
import { useApi } from "@/src/hooks/useApi";
import { api } from "@/src/lib/api";
import { formatCnyAmount, formatDateTime, formatInt } from "@/src/lib/format";
import { cn } from "@/src/lib/utils";
import type { CollectedSku, PriceTier, SpecDimension } from "@/src/types";

const BACK_TO = "/sourcing";
const BACK_LABEL = "返回货源库";

export default function SourcingDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reingesting, setReingesting] = useState(false);

  const { data: offer, loading, error, errorStatus, source, reload } = useApi(
    () => api.getSourcingOffer(id),
    [id]
  );

  const handleReingest = async () => {
    setReingesting(true);
    try {
      const { data: res } = await api.reingestSourcingImages(id);
      toast.success(`已重新提交 ${res.resetImages} 张图片，正在后台转存`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新转存失败");
    } finally {
      setReingesting(false);
      reload();
    }
  };

  const handleDelete = async () => {
    await api.deleteSourcingOffer(id);
    toast.success("已删除该货源");
    navigate(BACK_TO);
  };

  // 404 与「服务挂了」要分开：前者是这条记录没了，该给返回入口而不是重试按钮
  if (error && errorStatus === 404) {
    return <NotFound id={id} />;
  }

  if (error) {
    return (
      <>
        <PageHeader title="货源详情" backTo={BACK_TO} backLabel={BACK_LABEL} />
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHeader title="货源详情" backTo={BACK_TO} backLabel={BACK_LABEL} />
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </>
    );
  }

  if (!offer) return <NotFound id={id} />;

  return (
    <>
      <PageHeader
        title={offer.title || "(无标题)"}
        backTo={BACK_TO}
        backLabel={BACK_LABEL}
        description={`${offer.platform} · ${offer.offerId} · 采集于 ${formatDateTime(offer.collectedAt)}`}
        meta={
          <>
            <SourcePlatformBadge platform={offer.platform} />
            <ImageStatusBadge status={offer.imageStatus} />
            <SourceBadge source={source} />
            {offer.skuCount === 0 && (
              <span className="text-[11px] text-amber-600">未解析到 SKU</span>
            )}
            {offer.priceMin === undefined && (
              <span className="text-[11px] text-amber-600">未解析到价格</span>
            )}
          </>
        }
        actions={
          <>
            <a href={offer.url} target="_blank" rel="noreferrer noopener">
              <Button variant="outline">
                <ExternalLink className="h-4 w-4 mr-1.5" />
                查看 1688 原页
              </Button>
            </a>
            <Button variant="outline" disabled={reingesting} onClick={handleReingest}>
              <ImageDown className={cn("h-4 w-4 mr-1.5", reingesting && "animate-pulse")} />
              重新转存图片
            </Button>
            <Button
              variant="outline"
              className="text-rose-600 hover:bg-rose-50"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              删除
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ---------- 左列 ---------- */}
        <div className="space-y-4 lg:col-span-1">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
            {offer.thumbnail ? (
              <img
                src={offer.thumbnail}
                alt={offer.title}
                className="aspect-square w-full object-cover"
              />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center bg-slate-50 text-xs text-slate-400">
                {offer.imageFailCount > 0 ? "主图转存失败" : "主图尚未转存"}
              </div>
            )}
          </div>

          <Card title="供应商">
            <dl className="space-y-2.5 text-xs">
              <Row label="公司名" value={offer.supplier.name} />
              <Row label="1688 账号" value={offer.supplier.loginId} mono />
              <Row label="所在地" value={offer.supplier.location} />
            </dl>
            {offer.supplier.shopUrl && (
              <a
                href={offer.supplier.shopUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                <Store className="h-3.5 w-3.5" />
                打开店铺
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </Card>

          <Card title="采集信息">
            <dl className="space-y-2.5 text-xs">
              <Row label="起订量" value={offer.moq === undefined ? undefined : `${formatInt(offer.moq)} 件`} />
              <Row
                label="重量"
                value={offer.weightGram === undefined ? undefined : `${formatInt(offer.weightGram)} g`}
              />
              <Row
                label="尺寸"
                value={
                  offer.dimensions
                    ? `${offer.dimensions.length} × ${offer.dimensions.width} × ${offer.dimensions.height} cm`
                    : undefined
                }
              />
              <Row label="最近采集" value={formatDateTime(offer.collectedAt)} />
              <Row label="最近更新" value={formatDateTime(offer.updatedAt)} />
              <Row label="解析器版本" value={offer.extractorVersion} mono />
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              「最近采集」是最后一次重采的时间。用旧版解析器采的记录，在 1688 改版后
              建议重新采一次。
            </p>
          </Card>
        </div>

        {/* ---------- 右列 ---------- */}
        <div className="space-y-4 lg:col-span-2">
          <Card
            title="阶梯价"
            subtitle={offer.priceLadder.length ? `${offer.priceLadder.length} 档` : undefined}
          >
            {offer.priceLadder.length ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>采购量</TableHead>
                    <TableHead className="text-right">单价</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {offer.priceLadder.map((tier, i) => (
                    <TableRow key={`${tier.beginAmount}-${i}`}>
                      <TableCell className="text-sm text-slate-700">
                        {formatTierRange(tier)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm font-semibold text-slate-800">
                        {formatCnyAmount(tier.price)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Hint>
                没有解析到阶梯价。常见原因是采集时未登录 1688 —— 未登录状态下详情页不返回价格。
              </Hint>
            )}
          </Card>

          <Card
            title="SKU 明细"
            subtitle={offer.skus.length ? `${offer.skus.length} 个` : undefined}
          >
            {offer.skus.length ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>规格</TableHead>
                    <TableHead className="text-right">价格</TableHead>
                    <TableHead className="text-right">库存</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {offer.skus.map((sku) => (
                    <TableRow key={sku.skuId}>
                      <TableCell>
                        <p className="text-sm text-slate-700">
                          {formatSpecValues(sku, offer.specDimensions)}
                        </p>
                        <span className="font-mono text-[11px] text-slate-400">
                          {sku.skuId}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm text-slate-700">
                        {sku.price === undefined ? "—" : formatCnyAmount(sku.price)}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "tabular-nums text-sm",
                            sku.stock === undefined
                              ? "text-slate-400"
                              : sku.stock > 0
                                ? "text-slate-700"
                                : "text-rose-500"
                          )}
                        >
                          {sku.stock === undefined ? "—" : formatInt(sku.stock)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Hint>没有解析到 SKU。可能是单规格商品，或页面数据里未包含 sku 列表。</Hint>
            )}
          </Card>

          {offer.attributes.length > 0 && (
            <Card title="商品属性" subtitle={`${offer.attributes.length} 项`}>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-2">
                {offer.attributes.map((attr, i) => (
                  <div key={`${attr.name}-${i}`} className="flex items-baseline gap-3">
                    <dt className="w-24 shrink-0 text-slate-500">{attr.name}</dt>
                    <dd className="min-w-0 flex-1 break-words text-slate-800">{attr.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">图片转存</h2>
              <ImageSummaryBadges
                total={offer.images.length}
                okCount={offer.imageOkCount}
                failCount={offer.imageFailCount}
              />
            </div>
            <SourcingImages images={offer.images} />
            {offer.imageFailCount > 0 && (
              <div className="border-t border-slate-200 bg-amber-50/60 px-4 py-2.5">
                <p className="text-[11px] leading-relaxed text-amber-800">
                  有 {offer.imageFailCount} 张图没转存成功。多数是源站防盗链拦截或原图已删除，
                  点右上角「重新转存图片」可以重试一次。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除货源"
        description={`将删除「${offer.title || offer.offerId}」及其已转存的全部图片文件，该操作不可撤销。`}
        confirmLabel="确认删除"
        destructive
        onConfirm={handleDelete}
      />
    </>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <>
      <PageHeader title="货源详情" backTo={BACK_TO} backLabel={BACK_LABEL} />
      <div className="rounded-xl border border-slate-200 bg-white">
        <EmptyState
          title="货源不存在"
          description={`没有找到 ID 为 ${id} 的货源，可能已被删除。`}
          action={
            <Link to={BACK_TO}>
              <Button variant="outline" size="sm">
                返回货源库
              </Button>
            </Link>
          }
        />
      </div>
    </>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {subtitle && <span className="text-xs font-normal text-slate-500">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-xs leading-relaxed text-slate-400">{children}</p>;
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right font-medium",
          value ? "text-slate-800" : "text-slate-300",
          mono && "font-mono text-[11px]"
        )}
      >
        {value || "未知"}
      </dd>
    </div>
  );
}

/** 最后一档没有 endAmount，表示无上限 */
function formatTierRange(tier: PriceTier): string {
  const begin = formatInt(tier.beginAmount);
  if (tier.endAmount === undefined) return `≥ ${begin} 件`;
  if (tier.endAmount === tier.beginAmount) return `${begin} 件`;
  return `${begin} - ${formatInt(tier.endAmount)} 件`;
}

/**
 * 把 SKU 的规格值按维度顺序拼成人话。
 *
 * 不能直接 Object.entries(specValues) —— 对象的键顺序在跨 JSON 往返后不保证稳定，
 * 同一条货源刷新两次可能显示成不同的顺序。按 specDimensions 的声明顺序取，
 * 与 1688 页面上展示的顺序一致。
 */
function formatSpecValues(sku: CollectedSku, dimensions: SpecDimension[]): string {
  const parts: string[] = [];
  for (const dim of dimensions) {
    const value = sku.specValues[dim.name];
    if (value) parts.push(`${dim.name}: ${value}`);
  }
  // 兜底：页面数据里出现了维度定义之外的规格键，追加在后面而不是丢掉
  const known = new Set(dimensions.map((d) => d.name));
  for (const [name, value] of Object.entries(sku.specValues)) {
    if (!known.has(name) && value) parts.push(`${name}: ${value}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}
