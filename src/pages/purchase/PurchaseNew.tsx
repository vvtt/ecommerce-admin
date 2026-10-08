import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Textarea } from "@/src/components/ui/textarea";
import { Skeleton } from "@/src/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import { useApi } from "@/src/hooks/useApi";
import { api, WAREHOUSE_OPTIONS } from "@/src/lib/api";
import { SUPPLIERS } from "@/src/lib/labels";
import { formatCny, formatUsd } from "@/src/lib/format";
import type { PurchaseOrderInput } from "@/shared/mutations";
import type { Product, WarehouseCode } from "@/src/types";

interface Line {
  skuId: string;
  skuCode: string;
  productTitle: string;
  specText: string;
  /** 参考成本，来自商品主档 */
  refCost: number;
  quantity: string;
  unitCost: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export default function PurchaseNew() {
  const navigate = useNavigate();
  const toast = useToast();

  const [supplier, setSupplier] = useState<string>(SUPPLIERS[0]);
  const [warehouse, setWarehouse] = useState<WarehouseCode>("cn_main");
  const [expectedAt, setExpectedAt] = useState(plusDays(14));
  const [remark, setRemark] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // SKU 选择器要一次拿到全部商品；这里的数据量（16 个 SPU）远小于上限
  const products = useApi(() => api.listProducts({ page: 1, pageSize: 200 }), []);
  const items: Product[] = products.data?.items ?? [];

  // 已有明细的 SKU 不再出现在下拉里，避免同一 SKU 重复行
  const pickedIds = useMemo(() => new Set(lines.map((l) => l.skuId)), [lines]);

  const addLine = (skuId: string) => {
    for (const product of items) {
      const sku = product.skus.find((s) => s.id === skuId);
      if (!sku) continue;
      setLines((prev) => [
        ...prev,
        {
          skuId: sku.id,
          skuCode: sku.skuCode,
          productTitle: product.title,
          specText: Object.values(sku.specValues).join(" / "),
          refCost: sku.costPrice,
          quantity: "10",
          // 采购价默认取商品成本价，用户可以按供应商报价改
          unitCost: String(sku.costPrice),
        },
      ]);
      return;
    }
  };

  const updateLine = (index: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const totals = useMemo(() => {
    const amount = lines.reduce(
      (n, l) => n + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0),
      0
    );
    const quantity = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    return { amount, quantity };
  }, [lines]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!supplier.trim()) return setFormError("必须选择供应商");
    if (lines.length === 0) return setFormError("至少需要一行采购明细");
    for (let i = 0; i < lines.length; i++) {
      const q = Number(lines[i].quantity);
      const c = Number(lines[i].unitCost);
      if (!Number.isFinite(q) || q <= 0) {
        return setFormError(`第 ${i + 1} 行采购数量必须大于 0`);
      }
      if (!Number.isFinite(c) || c < 0) {
        return setFormError(`第 ${i + 1} 行单价不能为负`);
      }
    }

    const payload: PurchaseOrderInput = {
      supplier,
      warehouse,
      expectedAt: new Date(`${expectedAt}T00:00:00`).toISOString(),
      remark: remark.trim() || undefined,
      items: lines.map((l) => ({
        skuId: l.skuId,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
      })),
    };

    setSubmitting(true);
    try {
      const { data: order } = await api.createPurchaseOrder(payload);
      toast.success(`采购单 ${order.poNo} 已创建，状态为草稿`);
      navigate(`/purchase/${order.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "创建失败";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <PageHeader
        title="新建采购单"
        description="按 SKU 填写采购数量与单价。创建后为草稿状态，需在详情页提交审核。"
        backTo="/purchase"
        backLabel="返回采购单列表"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/purchase")}
              disabled={submitting}
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1.5" />
              )}
              创建采购单
            </Button>
          </>
        }
      />

      {formError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-medium text-rose-800">
          {formError}
        </div>
      )}

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="mb-4 text-sm font-bold text-slate-900">单据信息</h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5 md:col-span-2">
            <Label required>供应商</Label>
            <Select value={supplier} onValueChange={setSupplier}>
              <SelectTrigger>
                <SelectValue placeholder="选择供应商" />
              </SelectTrigger>
              <SelectContent>
                {SUPPLIERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label required>目的仓</Label>
            <Select
              value={warehouse}
              onValueChange={(v) => setWarehouse(v as WarehouseCode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WAREHOUSE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>预计到货日期</Label>
            <Input
              type="date"
              value={expectedAt}
              min={today()}
              onChange={(e) => setExpectedAt(e.target.value)}
            />
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label>备注</Label>
            <Textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="如：旺季备货 / 分两批到货"
              className="min-h-[38px] h-[38px] py-2"
            />
          </div>
        </div>
      </section>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">采购明细</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              选择 SKU 后按商品成本价预填单价，可改为供应商实际报价。
            </p>
          </div>

          <div className="w-full sm:w-80">
            {products.loading ? (
              <Skeleton className="h-9 w-full" />
            ) : products.error ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2">
                <span className="text-xs text-rose-700">商品加载失败</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-rose-700 hover:bg-rose-100"
                  onClick={products.reload}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  重试
                </Button>
              </div>
            ) : (
              <Select value="" onValueChange={addLine}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="+ 添加 SKU 到明细" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {items.map((p) => (
                    <SelectGroup key={p.id}>
                      <SelectLabel>{p.title}</SelectLabel>
                      {p.skus
                        .filter((s) => !pickedIds.has(s.id))
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.skuCode}
                            {Object.values(s.specValues).length > 0 &&
                              ` · ${Object.values(s.specValues).join(" / ")}`}
                            {` · ${formatUsd(s.price)}`}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        {lines.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center">
            <p className="text-sm font-medium text-slate-600">还没有采购明细</p>
            <p className="mt-1 text-xs text-slate-500">
              用右上角的下拉框选择要采购的 SKU，可添加多行。
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>商品 / SKU</TableHead>
                  <TableHead className="text-right">商品成本</TableHead>
                  <TableHead className="text-right">采购数量 *</TableHead>
                  <TableHead className="text-right">采购单价 (CNY) *</TableHead>
                  <TableHead className="text-right">小计</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, i) => {
                  const amount = (Number(line.quantity) || 0) * (Number(line.unitCost) || 0);
                  const diff =
                    Number(line.unitCost) - line.refCost;
                  return (
                    <TableRow key={line.skuId}>
                      <TableCell>
                        <p className="text-sm font-medium text-slate-800 max-w-[240px] truncate">
                          {line.productTitle}
                        </p>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="font-mono">{line.skuCode}</span>
                          {line.specText && (
                            <>
                              <span>·</span>
                              <span>{line.specText}</span>
                            </>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-slate-500">
                        {formatCny(line.refCost)}
                      </TableCell>
                      <TableCell className="p-2">
                        <Input
                          type="number"
                          min="1"
                          value={line.quantity}
                          onChange={(e) => updateLine(i, { quantity: e.target.value })}
                          className="h-8 w-24 text-right text-sm tabular-nums"
                        />
                      </TableCell>
                      <TableCell className="p-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.unitCost}
                          onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                          className="h-8 w-28 text-right text-sm tabular-nums"
                        />
                        {Math.abs(diff) > 0.001 && (
                          <p
                            className={
                              "mt-0.5 text-right text-[10px] tabular-nums " +
                              (diff > 0 ? "text-amber-600" : "text-emerald-600")
                            }
                          >
                            {diff > 0 ? "高于" : "低于"}成本 {formatCny(Math.abs(diff))}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm font-semibold text-slate-800">
                        {formatCny(amount)}
                      </TableCell>
                      <TableCell className="p-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-rose-600 hover:bg-rose-50"
                          title="移除该行"
                          onClick={() =>
                            setLines((prev) => prev.filter((_, idx) => idx !== i))
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {lines.length > 0 && (
          <div className="mt-3 flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-slate-500"
              onClick={() => setLines([])}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              清空明细
            </Button>

            <p className="text-xs text-slate-500">
              {lines.length} 行 · 合计{" "}
              <span className="font-semibold text-slate-700">{totals.quantity}</span> 件 · 金额{" "}
              <span className="text-sm font-bold text-slate-900 tabular-nums">
                {formatCny(totals.amount)}
              </span>
            </p>
          </div>
        )}
      </section>
    </form>
  );
}
