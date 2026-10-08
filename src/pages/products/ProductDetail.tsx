import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { ProductStatusBadge, ChannelStatusBadge } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { EmptyState, ErrorState } from "@/src/components/shared/EmptyState";
import { ConfirmDialog } from "@/src/components/shared/ConfirmDialog";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import { Badge } from "@/src/components/ui/badge";
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
import { useCategories } from "@/src/hooks/useCategories";
import { api } from "@/src/lib/api";
import { CHANNEL_META, STOCK_HEALTH_META } from "@/src/lib/labels";
import { formatCny, formatDateTime, formatInt, formatUsd } from "@/src/lib/format";

export default function ProductDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const categories = useCategories();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: product, loading, error, source, reload } = useApi(
    () => api.getProduct(id),
    [id]
  );

  const handleDelete = async () => {
    if (!product) return;
    await api.deleteProduct(product.id);
    toast.success(`已删除商品「${product.title}」`);
    navigate("/products");
  };

  if (error) {
    return (
      <>
        <PageHeader title="商品详情" backTo="/products" backLabel="返回商品列表" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHeader title="商品详情" backTo="/products" backLabel="返回商品列表" />
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </>
    );
  }

  if (!product) {
    return (
      <>
        <PageHeader title="商品详情" backTo="/products" backLabel="返回商品列表" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <EmptyState
            title="商品不存在"
            description={`没有找到编码为 ${id} 的商品，可能已被删除。`}
            action={
              <Link to="/products">
                <Button variant="outline" size="sm">
                  返回商品列表
                </Button>
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const totalStock = product.skus.reduce((n, s) => n + s.stock, 0);
  const totalLocked = product.skus.reduce((n, s) => n + s.lockedStock, 0);

  return (
    <>
      <PageHeader
        title={product.title}
        backTo="/products"
        backLabel="返回商品列表"
        description={product.titleEn}
        meta={
          <>
            <span className="font-mono text-xs text-slate-500">{product.spu}</span>
            <ProductStatusBadge status={product.status} />
            <SourceBadge source={source} />
          </>
        }
        actions={
          <>
            <Link to={`/products/${product.id}/edit`}>
              <Button variant="outline">
                <Pencil className="h-4 w-4 mr-1.5" />
                编辑
              </Button>
            </Link>
            <Button variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4 mr-1.5 text-rose-600" />
              <span className="text-rose-600">删除</span>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 主图 + 基础信息 */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <img
              src={product.mainImage}
              alt={product.title}
              className="aspect-square w-full rounded-lg border border-slate-200 object-cover bg-slate-50"
            />
            <dl className="mt-4 space-y-2.5 text-xs">
              <InfoRow label="品牌" value={product.brand} />
              <InfoRow label="类目" value={categories.nameOf(product.categoryId)} />
              <InfoRow label="维护人" value={product.operator} />
              <InfoRow label="创建时间" value={formatDateTime(product.createdAt)} />
              <InfoRow label="最近更新" value={formatDateTime(product.updatedAt)} />
            </dl>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <h2 className="mb-3 text-sm font-bold text-slate-900">渠道刊登状态</h2>
            <div className="space-y-2">
              {product.channels.map((ch) => (
                <div
                  key={ch.code}
                  className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: CHANNEL_META[ch.code].color }}
                    />
                    <span className="text-xs font-medium text-slate-700">
                      {CHANNEL_META[ch.code].label}
                    </span>
                  </span>
                  <ChannelStatusBadge status={ch.status} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 库存概览 + SKU 明细 */}
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <MiniStat label="在手库存" value={formatInt(totalStock)} unit="件" />
            <MiniStat label="订单占用" value={formatInt(totalLocked)} unit="件" />
            <MiniStat
              label="可售库存"
              value={formatInt(totalStock - totalLocked)}
              unit="件"
              highlight={totalStock - totalLocked <= 0}
            />
          </div>

          {(product.tags.length > 0 || product.attributes.length > 0) && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
              {product.tags.length > 0 && (
                <div className="mb-3">
                  <p className="mb-1.5 text-xs font-semibold text-slate-600">商品标签</p>
                  <div className="flex flex-wrap gap-1.5">
                    {product.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="font-normal">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {product.attributes.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-slate-600">商品属性</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                    {product.attributes.map((attr) => (
                      <div key={attr.name} className="flex items-baseline gap-2 text-xs">
                        <span className="text-slate-500 shrink-0">{attr.name}</span>
                        <span className="text-slate-800 font-medium truncate">{attr.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">
                SKU 明细
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {product.skus.length} 个规格
                </span>
              </h2>
              <Link to={`/inventory?q=${encodeURIComponent(product.spu)}`}>
                <Button variant="ghost" size="sm" className="text-xs">
                  查看库存分布
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </Link>
            </div>

            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>SKU 编码</TableHead>
                  <TableHead>规格</TableHead>
                  <TableHead className="text-right">售价</TableHead>
                  <TableHead className="text-right">成本</TableHead>
                  <TableHead className="text-right">在手</TableHead>
                  <TableHead className="text-right">占用</TableHead>
                  <TableHead className="text-right">可用</TableHead>
                  <TableHead className="text-right">安全库存</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.skus.map((sku) => {
                  const available = sku.stock - sku.lockedStock;
                  const health =
                    available <= 0 ? "out" : available < sku.safetyStock ? "low" : "normal";
                  return (
                    <TableRow key={sku.id}>
                      <TableCell className="font-mono text-xs">{sku.skuCode}</TableCell>
                      <TableCell className="text-xs text-slate-700">
                        {Object.entries(sku.specValues)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" / ") || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-medium">
                        {formatUsd(sku.price)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-slate-500">
                        {formatCny(sku.costPrice)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {formatInt(sku.stock)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-slate-500">
                        {formatInt(sku.lockedStock)}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          title={STOCK_HEALTH_META[health].label}
                          className={
                            "tabular-nums text-xs font-semibold " +
                            (health === "out"
                              ? "text-rose-600"
                              : health === "low"
                                ? "text-amber-600"
                                : "text-slate-800")
                          }
                        >
                          {formatInt(available)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-slate-500">
                        {formatInt(sku.safetyStock)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除商品"
        description={`将删除「${product.title}」及其 ${product.skus.length} 个 SKU 的全部库存记录，该操作不可撤销。`}
        confirmLabel="确认删除"
        destructive
        onConfirm={handleDelete}
      />
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500 shrink-0">{label}</dt>
      <dd className="text-slate-800 font-medium text-right truncate">{value}</dd>
    </div>
  );
}

function MiniStat({
  label,
  value,
  unit,
  highlight,
}: {
  label: string;
  value: string;
  unit: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span
          className={
            highlight
              ? "text-xl font-bold tabular-nums text-rose-600"
              : "text-xl font-bold tabular-nums text-slate-900"
          }
        >
          {value}
        </span>
        <span className="text-xs text-slate-500">{unit}</span>
      </p>
    </div>
  );
}
