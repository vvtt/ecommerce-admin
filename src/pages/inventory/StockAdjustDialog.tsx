import { useEffect, useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Textarea } from "@/src/components/ui/textarea";
import { useToast } from "@/src/components/shared/Toast";
import { api } from "@/src/lib/api";
import { WAREHOUSE_META } from "@/src/lib/labels";
import { formatInt } from "@/src/lib/format";
import type { InventoryRecord } from "@/src/types";

interface StockAdjustDialogProps {
  /** 为 null 时弹窗关闭 */
  record: InventoryRecord | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/**
 * 库存调整（盘点）。
 *
 * 只让用户填「调整后的在手量」而不是「增减量」—— 盘点场景里手上拿的是实测数字，
 * 让系统去算差额可以避免加减号搞反。服务端会再校验一遍并写入流水。
 */
export function StockAdjustDialog({ record, onOpenChange, onDone }: StockAdjustDialogProps) {
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都按当前记录重置表单
  useEffect(() => {
    if (!record) return;
    setTarget(String(record.onHand));
    setReason("");
    setError(null);
    setPending(false);
  }, [record]);

  if (!record) return null;

  const targetNum = Number(target);
  const delta =
    Number.isFinite(targetNum) && target !== "" ? Math.trunc(targetNum) - record.onHand : 0;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (target === "" || !Number.isFinite(targetNum)) {
      setError("请填写调整后的在手数量");
      return;
    }
    if (Math.trunc(targetNum) < 0) {
      setError("在手库存不能为负数");
      return;
    }
    if (!reason.trim()) {
      setError("必须填写调整原因");
      return;
    }
    if (delta === 0) {
      setError("调整后的数量与原数量相同，无需变更");
      return;
    }

    setPending(true);
    try {
      await api.adjustStock({
        inventoryId: record.id,
        onHand: Math.trunc(targetNum),
        reason: reason.trim(),
      });
      toast.success(
        `${record.skuCode} 库存已由 ${formatInt(record.onHand)} 调整为 ${formatInt(targetNum)}`
      );
      onOpenChange(false);
      onDone();
    } catch (err) {
      // 4xx 是真实校验失败（如低于占用量），留在弹窗里让用户改
      const message = err instanceof Error ? err.message : "调整失败";
      setError(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>调整库存</DialogTitle>
          <DialogDescription>
            {record.productTitle}
            {record.specText && ` · ${record.specText}`}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs space-y-1.5">
          <Row label="SKU 编码" value={record.skuCode} mono />
          <Row label="仓库" value={WAREHOUSE_META[record.warehouse].name} />
          <Row label="当前在手" value={`${formatInt(record.onHand)} 件`} />
          <Row label="已占用" value={`${formatInt(record.locked)} 件`} />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label required>调整后的在手数量</Label>
            <Input
              type="number"
              min={0}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              autoFocus
            />
            <p className="text-[11px] text-slate-500">
              {delta === 0 ? (
                "与原数量相同"
              ) : (
                <>
                  变动{" "}
                  <span
                    className={
                      delta > 0 ? "font-semibold text-emerald-600" : "font-semibold text-rose-600"
                    }
                  >
                    {delta > 0 ? `+${formatInt(delta)}` : formatInt(delta)}
                  </span>{" "}
                  件；不能低于已占用数量 {formatInt(record.locked)} 件。
                </>
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label required>调整原因</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：季度盘点差异 / 破损报废 / 系统数据修正"
              className="min-h-[64px]"
            />
          </div>

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "提交中…" : "确认调整"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`text-slate-800 font-medium ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
