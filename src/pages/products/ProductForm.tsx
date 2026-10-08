import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Plus, Save, Sparkles, Trash2, X } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { ErrorState } from "@/src/components/shared/EmptyState";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Textarea } from "@/src/components/ui/textarea";
import { Skeleton } from "@/src/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { useCategories } from "@/src/hooks/useCategories";
import { api, ApiError } from "@/src/lib/api";
import { PRODUCT_STATUS_META } from "@/src/lib/labels";
import { formatCny } from "@/src/lib/format";
import type { ProductInput, SkuInput } from "@/shared/mutations";
import type { ProductStatus } from "@/src/types";

interface SkuRow {
  /** 每个规格维度的取值，下标与 specNames 对齐 */
  values: string[];
  barcode: string;
  price: string;
  costPrice: string;
  weightGram: string;
  safetyStock: string;
}

const emptyRow = (dimCount: number): SkuRow => ({
  values: Array.from({ length: dimCount }, () => ""),
  barcode: "",
  price: "",
  costPrice: "",
  weightGram: "300",
  safetyStock: "30",
});

/** 笛卡尔积：把「颜色: 黑,白 × 尺码: M,L」展开成 4 个 SKU 组合 */
function cartesian(dims: string[][]): string[][] {
  return dims.reduce<string[][]>(
    (acc, values) => acc.flatMap((combo) => values.map((v) => [...combo, v])),
    [[]]
  );
}

export default function ProductForm({ mode }: { mode: "create" | "edit" }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const categories = useCategories();

  const isEdit = mode === "edit";
  const { data: existing, loading, error, reload } = useApi(
    () => (isEdit ? api.getProduct(id) : Promise.resolve({ data: null, source: "api" as const })),
    [id, isEdit]
  );

  /* ---------------- 表单状态 ---------------- */

  const [title, setTitle] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brand, setBrand] = useState("");
  const [status, setStatus] = useState<ProductStatus>("draft");
  const [tags, setTags] = useState("");
  const [attributes, setAttributes] = useState<{ name: string; value: string }[]>([]);

  const [specNames, setSpecNames] = useState<string[]>(["颜色"]);
  const [skuRows, setSkuRows] = useState<SkuRow[]>([emptyRow(1)]);
  /** 各维度的候选值，仅用于「批量生成规格」 */
  const [specCandidates, setSpecCandidates] = useState<string[]>([""]);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 编辑模式：把已有商品灌进表单
  useEffect(() => {
    if (!existing) return;
    setTitle(existing.title);
    setTitleEn(existing.titleEn);
    setCategoryId(existing.categoryId);
    setBrand(existing.brand);
    setStatus(existing.status);
    setTags(existing.tags.join(", "));
    setAttributes(existing.attributes.map((a) => ({ ...a })));

    const names = Array.from(
      new Set(existing.skus.flatMap((s) => Object.keys(s.specValues)))
    );
    const dims = names.length ? names : ["规格"];
    setSpecNames(dims);
    setSpecCandidates(dims.map(() => ""));
    setSkuRows(
      existing.skus.map((s) => ({
        values: dims.map((n) => s.specValues[n] ?? ""),
        barcode: s.barcode,
        price: String(s.price),
        costPrice: String(s.costPrice),
        weightGram: String(s.weightGram),
        safetyStock: String(s.safetyStock),
      }))
    );
  }, [existing]);

  // 创建模式：类目树加载完给个默认值，省得用户第一步就撞空
  useEffect(() => {
    if (!isEdit && !categoryId && categories.flat.length) {
      setCategoryId(categories.flat[0].id);
    }
  }, [isEdit, categoryId, categories.flat]);

  /* ---------------- 规格维度操作 ---------------- */

  const addDimension = () => {
    setSpecNames((prev) => [...prev, ""]);
    setSpecCandidates((prev) => [...prev, ""]);
    setSkuRows((prev) => prev.map((r) => ({ ...r, values: [...r.values, ""] })));
  };

  const removeDimension = (index: number) => {
    if (specNames.length <= 1) return;
    setSpecNames((prev) => prev.filter((_, i) => i !== index));
    setSpecCandidates((prev) => prev.filter((_, i) => i !== index));
    setSkuRows((prev) =>
      prev.map((r) => ({ ...r, values: r.values.filter((_, i) => i !== index) }))
    );
  };

  const renameDimension = (index: number, name: string) => {
    setSpecNames((prev) => prev.map((n, i) => (i === index ? name : n)));
  };

  /** 按各维度候选值生成规格组合，价格等字段沿用第一行 */
  const generateCombos = () => {
    const dims = specCandidates.map((c) =>
      c
        .split(/[,，\s]+/)
        .map((v) => v.trim())
        .filter(Boolean)
    );
    if (dims.some((d) => d.length === 0)) {
      setFormError("每个规格维度都要先填写候选值，用逗号分隔，例如：黑色,白色");
      return;
    }
    setFormError(null);

    const combos = cartesian(dims);
    const template = skuRows[0] ?? emptyRow(dims.length);
    setSkuRows(
      combos.map((values) => ({
        ...template,
        values,
        // 组合是新生成的，条码让服务端按规则补
        barcode: "",
      }))
    );
    toast.success(`已生成 ${combos.length} 个规格组合`);
  };

  const updateRow = (index: number, patch: Partial<SkuRow>) => {
    setSkuRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const updateRowValue = (rowIndex: number, dimIndex: number, value: string) => {
    setSkuRows((prev) =>
      prev.map((r, i) =>
        i === rowIndex
          ? { ...r, values: r.values.map((v, d) => (d === dimIndex ? value : v)) }
          : r
      )
    );
  };

  /* ---------------- 提交 ---------------- */

  const costSum = useMemo(
    () => skuRows.reduce((n, r) => n + (Number(r.costPrice) || 0), 0),
    [skuRows]
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    // 先做一轮本地校验，避免为明显错误跑一趟网络
    if (!title.trim()) return setFormError("商品标题不能为空");
    if (!titleEn.trim()) return setFormError("英文标题不能为空");
    if (!categoryId) return setFormError("必须选择类目");
    if (specNames.some((n) => !n.trim())) return setFormError("规格维度名称不能为空");
    if (skuRows.length === 0) return setFormError("至少需要一个 SKU");

    const skus: SkuInput[] = [];
    for (let i = 0; i < skuRows.length; i++) {
      const row = skuRows[i];
      const price = Number(row.price);
      const costPrice = Number(row.costPrice);
      const weightGram = Number(row.weightGram);
      const safetyStock = Number(row.safetyStock);

      if (!row.values.some((v) => v.trim())) {
        return setFormError(`第 ${i + 1} 行 SKU 至少要填一个规格值`);
      }
      if (!(price > 0)) return setFormError(`第 ${i + 1} 行售价必须大于 0`);
      if (!(costPrice >= 0)) return setFormError(`第 ${i + 1} 行成本价不能为负`);

      skus.push({
        specValues: Object.fromEntries(
          specNames.map((name, d) => [name.trim(), row.values[d]?.trim() || "默认"])
        ),
        barcode: row.barcode.trim() || undefined,
        price,
        costPrice,
        weightGram: Number.isFinite(weightGram) ? weightGram : 0,
        safetyStock: Number.isFinite(safetyStock) ? safetyStock : 0,
      });
    }

    const payload: ProductInput = {
      title,
      titleEn,
      categoryId,
      brand,
      status,
      tags: tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      attributes: attributes.filter((a) => a.name.trim() && a.value.trim()),
      skus,
    };

    setSubmitting(true);
    try {
      if (isEdit) {
        const { data: updated } = await api.updateProduct(id, payload);
        toast.success(`已保存「${updated.title}」`);
        navigate(`/products/${updated.id}`);
      } else {
        const { data: created } = await api.createProduct(payload);
        toast.success(`已创建商品「${created.title}」，编码 ${created.spu}`);
        navigate(`/products/${created.id}`);
      }
    } catch (err) {
      // 服务端 4xx 是真实校验失败，原样展示而不是吞掉
      const message =
        err instanceof ApiError || err instanceof Error ? err.message : "保存失败";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (error) {
    return (
      <>
        <PageHeader title={isEdit ? "编辑商品" : "新建商品"} backTo="/products" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </>
    );
  }

  if (isEdit && loading) {
    return (
      <>
        <PageHeader title="编辑商品" backTo="/products" />
        <div className="space-y-4">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      </>
    );
  }

  if (isEdit && !existing) {
    return (
      <>
        <PageHeader title="编辑商品" backTo="/products" />
        <div className="rounded-xl border border-slate-200 bg-white">
          <ErrorState message={`商品不存在: ${id}`} />
        </div>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <PageHeader
        title={isEdit ? "编辑商品" : "新建商品"}
        description={
          isEdit
            ? "修改 SPU 主档与 SKU 明细。已有 SKU 的库存会被保留，删除 SKU 会连带删除其库存记录。"
            : "SPU 主档一次可录入多个规格 SKU；新 SKU 会在国内主仓建立 0 库存记录。"
        }
        backTo="/products"
        backLabel="返回商品列表"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/products")}
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
              {isEdit ? "保存修改" : "创建商品"}
            </Button>
          </>
        }
      />

      {formError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-medium text-rose-800">
          {formError}
        </div>
      )}

      {/* 基本信息 */}
      <Section title="基本信息">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="商品标题（中文）" required className="md:col-span-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：无线蓝牙耳机 主动降噪长续航"
            />
          </Field>

          <Field label="商品标题（英文）" required className="md:col-span-2">
            <Input
              value={titleEn}
              onChange={(e) => setTitleEn(e.target.value)}
              placeholder="Wireless Bluetooth Earbuds with Active Noise Cancelling"
            />
          </Field>

          <Field label="类目" required>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue placeholder="选择类目" />
              </SelectTrigger>
              <SelectContent>
                {categories.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="品牌">
            <Input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="自有品牌"
            />
          </Field>

          <Field label="上架状态">
            <Select value={status} onValueChange={(v) => setStatus(v as ProductStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PRODUCT_STATUS_META).map(([value, meta]) => (
                  <SelectItem key={value} value={value}>
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="商品标签" hint="用逗号分隔">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="热销, 新品, 跨境专供"
            />
          </Field>
        </div>

        {/* 属性 */}
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <Label>商品属性</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAttributes((prev) => [...prev, { name: "", value: "" }])}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              添加属性
            </Button>
          </div>

          {attributes.length === 0 ? (
            <p className="text-xs text-slate-400">
              如材质、产地、认证等非销售属性，可留空。
            </p>
          ) : (
            <div className="space-y-2">
              {attributes.map((attr, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={attr.name}
                    onChange={(e) =>
                      setAttributes((prev) =>
                        prev.map((a, idx) => (idx === i ? { ...a, name: e.target.value } : a))
                      )
                    }
                    placeholder="属性名，如 材质"
                    className="h-8 flex-1 text-sm"
                  />
                  <Input
                    value={attr.value}
                    onChange={(e) =>
                      setAttributes((prev) =>
                        prev.map((a, idx) => (idx === i ? { ...a, value: e.target.value } : a))
                      )
                    }
                    placeholder="属性值，如 铝合金"
                    className="h-8 flex-1 text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-rose-600 hover:bg-rose-50"
                    onClick={() => setAttributes((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* 规格与 SKU */}
      <Section
        title="规格与 SKU"
        description="定义规格维度（如颜色、尺码），再批量生成组合或逐行填写。"
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={addDimension}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              添加维度
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={generateCombos}>
              <Sparkles className="h-3.5 w-3.5 mr-1" />
              批量生成
            </Button>
          </div>
        }
      >
        {/* 维度定义 */}
        <div className="mb-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          {specNames.map((name, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-14 shrink-0 text-xs font-semibold text-slate-600">
                维度 {i + 1}
              </span>
              <Input
                value={name}
                onChange={(e) => renameDimension(i, e.target.value)}
                placeholder="维度名，如 颜色"
                className="h-8 w-36 text-sm bg-white"
              />
              <Input
                value={specCandidates[i] ?? ""}
                onChange={(e) =>
                  setSpecCandidates((prev) =>
                    prev.map((c, idx) => (idx === i ? e.target.value : c))
                  )
                }
                placeholder="候选值，逗号分隔：黑色,白色"
                className="h-8 flex-1 min-w-[200px] text-sm bg-white"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-rose-600 hover:bg-rose-50"
                disabled={specNames.length <= 1}
                title={specNames.length <= 1 ? "至少保留一个维度" : "删除该维度"}
                onClick={() => removeDimension(i)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <p className="pl-16 text-[11px] text-slate-500">
            点「批量生成」按候选值做笛卡尔积生成 SKU 组合，价格沿用第一行，之后再逐行微调。
          </p>
        </div>

        {/* SKU 表格 */}
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {specNames.map((name, i) => (
                  <TableHead key={i}>{name.trim() || `维度 ${i + 1}`}</TableHead>
                ))}
                <TableHead>条码</TableHead>
                <TableHead className="text-right">售价 (USD) *</TableHead>
                <TableHead className="text-right">成本 (CNY) *</TableHead>
                <TableHead className="text-right">重量 (g)</TableHead>
                <TableHead className="text-right">安全库存</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {skuRows.map((row, ri) => (
                <TableRow key={ri}>
                  {specNames.map((_, di) => (
                    <TableCell key={di} className="p-2">
                      <Input
                        value={row.values[di] ?? ""}
                        onChange={(e) => updateRowValue(ri, di, e.target.value)}
                        placeholder="规格值"
                        className="h-8 w-full min-w-[90px] text-sm"
                      />
                    </TableCell>
                  ))}
                  <TableCell className="p-2">
                    <Input
                      value={row.barcode}
                      onChange={(e) => updateRow(ri, { barcode: e.target.value })}
                      placeholder="留空自动生成"
                      className="h-8 w-full min-w-[130px] font-mono text-xs"
                    />
                  </TableCell>
                  <TableCell className="p-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.price}
                      onChange={(e) => updateRow(ri, { price: e.target.value })}
                      placeholder="0.00"
                      className="h-8 w-24 text-right text-sm tabular-nums"
                    />
                  </TableCell>
                  <TableCell className="p-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.costPrice}
                      onChange={(e) => updateRow(ri, { costPrice: e.target.value })}
                      placeholder="0.00"
                      className="h-8 w-24 text-right text-sm tabular-nums"
                    />
                  </TableCell>
                  <TableCell className="p-2">
                    <Input
                      type="number"
                      min="0"
                      value={row.weightGram}
                      onChange={(e) => updateRow(ri, { weightGram: e.target.value })}
                      className="h-8 w-20 text-right text-sm tabular-nums"
                    />
                  </TableCell>
                  <TableCell className="p-2">
                    <Input
                      type="number"
                      min="0"
                      value={row.safetyStock}
                      onChange={(e) => updateRow(ri, { safetyStock: e.target.value })}
                      className="h-8 w-20 text-right text-sm tabular-nums"
                    />
                  </TableCell>
                  <TableCell className="p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-rose-600 hover:bg-rose-50"
                      disabled={skuRows.length <= 1}
                      title={skuRows.length <= 1 ? "至少保留一个 SKU" : "删除该 SKU"}
                      onClick={() =>
                        setSkuRows((prev) => prev.filter((_, idx) => idx !== ri))
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSkuRows((prev) => [...prev, emptyRow(specNames.length)])}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            添加一行 SKU
          </Button>

          <p className="text-xs text-slate-500">
            共 <span className="font-semibold text-slate-700">{skuRows.length}</span> 个 SKU · 成本合计{" "}
            <span className="font-semibold text-slate-700">{formatCny(costSum)}</span>
          </p>
        </div>
      </Section>
    </form>
  );
}

function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <div className="flex items-center justify-between">
        <Label required={required}>{label}</Label>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
