import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Circle, Info } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { PurchaseStatusBadge, WarehouseTag } from "@/src/components/shared/StatusBadge";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { EmptyState, ErrorState } from "@/src/components/shared/EmptyState";
import { StatCard } from "@/src/components/shared/StatCard";
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
import { useApi } from "@/src/hooks/useApi";
import { api } from "@/src/lib/api";
import { PURCHASE_STATUS_META, PURCHASE_TRANSITIONS } from "@/src/lib/labels";
import { formatCny, formatDate, formatDateTime, formatInt } from "@/src/lib/format";
import { PurchaseActions } from "@/src/pages/purchase/PurchaseActions";
import { cn } from "@/src/lib/utils";
import type { PurchaseStatus } from "@/src/types";

/** 状态机主干，用来画审批进度条 */
const PIPELINE: PurchaseStatus[] = ["draft", "pending", "approved", "shipping", "received"];

export default function PurchaseDetail() {
  const { id = "" } = useParams();
  const { data: order, loading, error, source, reload } = useApi(
    () => api.getPurchaseOrder(id),
    [id]
  );

  if (error) {
    return (
      <>
        <PageHeader title="采购单详情" backTo="/purchase" backLabel="返回采购单列表" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHeader title="采购单详情" backTo="/purchase" backLabel="返回采购单列表" />
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </>
    );
  }

  if (!order) {
    return (
      <>
        <PageHeader title="采购单详情" backTo="/purchase" backLabel="返回采购单列表" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <EmptyState
            title="采购单不存在"
            description={`没有找到单号为 ${id} 的采购单。`}
            action={
              <Link to="/purchase">
                <Button variant="outline" size="sm">
                  返回采购单列表
                </Button>
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const receivedQty = order.items.reduce((n, i) => n + i.receivedQty, 0);
  const progress =
    order.totalQuantity > 0 ? Math.round((receivedQty / order.totalQuantity) * 100) : 0;

  return (
    <>
      <PageHeader
        title={order.poNo}
        backTo="/purchase"
        backLabel="返回采购单列表"
        description={`${order.supplier} · 创建于 ${formatDateTime(order.createdAt)}`}
        meta={
          <>
            <PurchaseStatusBadge status={order.status} />
            <SourceBadge source={source} />
          </>
        }
        actions={<PurchaseActions order={order} onDone={reload} size="default" primaryOnly={false} />}
      />

      {/* 状态进度 */}
      {order.status !== "cancelled" ? (
        <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center">
            {PIPELINE.map((stage, i) => {
              const currentIndex = PIPELINE.indexOf(order.status);
              const done = i < currentIndex;
              const active = i === currentIndex;
              return (
                <div key={stage} className="flex flex-1 items-center last:flex-none">
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold",
                        active
                          ? "bg-blue-600 text-white ring-4 ring-blue-100"
                          : done
                            ? "bg-blue-100 text-blue-700"
                            : "bg-slate-100 text-slate-400"
                      )}
                    >
                      {done ? "✓" : i + 1}
                    </div>
                    <span
                      className={cn(
                        "text-[11px] whitespace-nowrap",
                        active
                          ? "font-bold text-blue-700"
                          : done
                            ? "font-medium text-slate-600"
                            : "text-slate-400"
                      )}
                    >
                      {PURCHASE_STATUS_META[stage].label}
                    </span>
                  </div>

                  {i < PIPELINE.length - 1 && (
                    <div
                      className={cn(
                        "mx-2 h-0.5 flex-1 rounded",
                        i < PIPELINE.indexOf(order.status) ? "bg-blue-200" : "bg-slate-100"
                      )}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <Circle className="h-3 w-3 fill-slate-400 text-slate-400" />
          该采购单已取消，不再参与库存流转。
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="采购金额" value={formatCny(order.totalAmount)} tone="violet" />
        <StatCard
          label="采购数量"
          value={formatInt(order.totalQuantity)}
          unit="件"
          hint={`${order.items.length} 个 SKU`}
          tone="blue"
        />
        <StatCard
          label="已入库"
          value={formatInt(receivedQty)}
          unit="件"
          hint={`完成度 ${progress}%`}
          tone={progress === 100 ? "emerald" : "slate"}
        />
        <StatCard
          label="预计到货"
          value={formatDate(order.expectedAt)}
          hint={order.warehouse === "cn_main" ? "国内主仓" : "海外仓"}
          tone="amber"
        />
      </div>

      {/* 单据信息 */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs lg:col-span-1">
          <h2 className="mb-3 text-sm font-bold text-slate-900">单据信息</h2>
          <dl className="space-y-2.5 text-xs">
            <Row label="供应商" value={order.supplier} />
            <Row label="目的仓">
              <WarehouseTag code={order.warehouse} />
            </Row>
            <Row label="操作人" value={order.operator} />
            <Row label="创建时间" value={formatDateTime(order.createdAt)} />
            <Row label="最近更新" value={formatDateTime(order.updatedAt)} />
            <Row label="币种" value={order.currency} />
          </dl>

          {order.remark && (
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-semibold text-slate-600">备注</p>
              <p className="mt-0.5 text-xs text-slate-700 leading-relaxed">{order.remark}</p>
            </div>
          )}

          {order.status === "received" && (
            <div className="mt-3 flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
              <Info className="h-3.5 w-3.5 shrink-0 text-emerald-600 mt-px" />
              <p className="text-[11px] text-emerald-800 leading-relaxed">
                已确认入库，库存已计入目的仓，并写入采购入库流水。
              </p>
            </div>
          )}

          {PURCHASE_TRANSITIONS[order.status].length === 0 && order.status !== "received" && (
            <p className="mt-3 text-[11px] text-slate-400">该单据已无可用流转动作。</p>
          )}
        </div>

        {/* 明细 */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden lg:col-span-2">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-bold text-slate-900">
              采购明细
              <span className="ml-2 text-xs font-normal text-slate-500">
                {order.items.length} 行
              </span>
            </h2>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>商品 / SKU</TableHead>
                <TableHead className="text-right">采购量</TableHead>
                <TableHead className="text-right">已入库</TableHead>
                <TableHead className="text-right">单价</TableHead>
                <TableHead className="text-right">小计</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <p className="text-sm font-medium text-slate-800 max-w-[260px] truncate">
                      {item.productTitle}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-mono">{item.skuCode}</span>
                      {item.specText && (
                        <>
                          <span>·</span>
                          <span>{item.specText}</span>
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {formatInt(item.quantity)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "tabular-nums text-sm font-medium",
                        item.receivedQty >= item.quantity
                          ? "text-emerald-600"
                          : item.receivedQty > 0
                            ? "text-amber-600"
                            : "text-slate-400"
                      )}
                    >
                      {formatInt(item.receivedQty)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs text-slate-600">
                    {formatCny(item.unitCost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold text-slate-800">
                    {formatCny(item.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-end gap-6 border-t border-slate-200 bg-slate-50/70 px-4 py-3">
            <span className="text-xs text-slate-500">
              合计数量 <span className="font-semibold text-slate-700">{formatInt(order.totalQuantity)}</span> 件
            </span>
            <span className="text-xs text-slate-500">
              采购金额{" "}
              <span className="text-base font-bold text-slate-900 tabular-nums">
                {formatCny(order.totalAmount)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500 shrink-0">{label}</dt>
      <dd className="text-slate-800 font-medium text-right truncate">{children ?? value}</dd>
    </div>
  );
}
