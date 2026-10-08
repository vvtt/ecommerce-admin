import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ClipboardList,
  DollarSign,
  PackageCheck,
  PackageX,
  Truck,
} from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { StatCard } from "@/src/components/shared/StatCard";
import { SourceBadge } from "@/src/components/shared/SourceBadge";
import { StockHealthBadge } from "@/src/components/shared/StatusBadge";
import { ErrorState } from "@/src/components/shared/EmptyState";
import { Skeleton } from "@/src/components/ui/skeleton";
import { Button } from "@/src/components/ui/button";
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
import { WAREHOUSE_META } from "@/src/lib/labels";
import { formatCnyCompact, formatInt } from "@/src/lib/format";

export default function Overview() {
  const { data, loading, error, source, reload } = useApi(() => api.getOverview(), []);

  if (error) {
    return (
      <>
        <PageHeader title="经营概览" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </>
    );
  }

  const kpi = data?.kpi;

  return (
    <>
      <PageHeader
        title="经营概览"
        description="商品与库存域的整体健康度。数据由内存态实时派生，采购入库、库存调整后即时反映。"
        actions={<SourceBadge source={source} />}
      />

      {/* KPI */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !kpi ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))
        ) : (
          <>
            <StatCard
              label="SPU 总数 / 在售"
              value={formatInt(kpi.spuCount)}
              unit="款"
              hint={`其中 ${kpi.onSaleCount} 款在售`}
              icon={<Boxes className="h-4 w-4" />}
              tone="blue"
            />
            <StatCard
              label="SKU 总数"
              value={formatInt(kpi.skuCount)}
              unit="个"
              hint={`覆盖 ${kpi.spuCount} 个商品`}
              icon={<PackageCheck className="h-4 w-4" />}
              tone="violet"
            />
            <StatCard
              label="库存成本总额"
              value={formatCnyCompact(kpi.inventoryValueCny)}
              hint="按各 SKU 成本价 × 在手量"
              icon={<DollarSign className="h-4 w-4" />}
              tone="emerald"
            />
            <StatCard
              label="在途采购量"
              value={formatInt(kpi.inTransitQty)}
              unit="件"
              hint={`${kpi.pendingPurchaseCount} 张采购单待处理`}
              icon={<Truck className="h-4 w-4" />}
              tone="slate"
            />
            <StatCard
              label="低于安全库存"
              value={formatInt(kpi.lowStockSkuCount)}
              unit="个 SKU"
              hint="需尽快补货"
              icon={<AlertTriangle className="h-4 w-4" />}
              tone="amber"
            />
            <StatCard
              label="已缺货"
              value={formatInt(kpi.outOfStockSkuCount)}
              unit="个 SKU"
              hint="可售库存为 0"
              icon={<PackageX className="h-4 w-4" />}
              tone={kpi.outOfStockSkuCount > 0 ? "rose" : "slate"}
            />
            <StatCard
              label="待审核采购单"
              value={formatInt(kpi.pendingPurchaseCount)}
              unit="张"
              hint="待审核 + 已审核未发货"
              icon={<ClipboardList className="h-4 w-4" />}
              tone="blue"
            />
            <StatCard
              label="在售商品占比"
              value={
                kpi.spuCount > 0 ? `${Math.round((kpi.onSaleCount / kpi.spuCount) * 100)}%` : "—"
              }
              hint={`${kpi.onSaleCount} / ${kpi.spuCount} 款在售`}
              icon={<PackageCheck className="h-4 w-4" />}
              tone="emerald"
            />
          </>
        )}
      </div>

      {/* 图表 */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="仓库库存分布" subtitle="按在手量拆分三个仓库">
          {loading || !data ? (
            <Skeleton className="h-[260px] w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={data.warehouseDistribution}
                  dataKey="onHand"
                  nameKey="warehouseName"
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {data.warehouseDistribution.map((entry) => (
                    <Cell key={entry.warehouse} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => `${formatInt(Number(value))} 件`}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Legend
                  formatter={(value: string) => (
                    <span className="text-xs text-slate-600">{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="类目库存分布" subtitle="一级类目下的在手库存量">
          {loading || !data ? (
            <Skeleton className="h-[260px] w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.categoryStock} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <XAxis
                  dataKey="categoryName"
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  interval={0}
                  angle={-18}
                  textAnchor="end"
                  height={52}
                />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                <Tooltip
                  cursor={{ fill: "rgba(37,99,235,0.06)" }}
                  formatter={(value) => `${formatInt(Number(value))} 件`}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Bar dataKey="onHand" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={44} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* 低库存 TOP */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-bold text-slate-900">库存告急 TOP 8</h2>
            <span className="text-xs text-slate-500">按「可用量 / 安全库存」升序</span>
          </div>
          <Link to="/inventory?health=low">
            <Button variant="ghost" size="sm" className="text-xs">
              查看全部
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </Link>
        </div>

        {loading || !data ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : data.lowStockTop.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-slate-500">
            所有 SKU 均高于安全库存，暂无告急项。
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>商品</TableHead>
                <TableHead>SKU 编码</TableHead>
                <TableHead>仓库</TableHead>
                <TableHead className="text-right">可用</TableHead>
                <TableHead className="text-right">安全库存</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.lowStockTop.map((item) => (
                <TableRow key={`${item.skuCode}@${item.warehouse}`}>
                  <TableCell className="font-medium text-slate-800 max-w-[280px] truncate">
                    {item.productTitle}
                    {item.specText && (
                      <span className="text-slate-400 font-normal"> · {item.specText}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-slate-600">{item.skuCode}</TableCell>
                  <TableCell className="text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: WAREHOUSE_META[item.warehouse].color }}
                      />
                      {WAREHOUSE_META[item.warehouse].name}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-semibold text-rose-600">
                    {formatInt(item.available)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-slate-500">
                    {formatInt(item.safetyStock)}
                  </TableCell>
                  <TableCell>
                    <StockHealthBadge health={item.health} short />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}

const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid #e2e8f0",
  fontSize: 12,
  boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
};

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="mb-2">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
