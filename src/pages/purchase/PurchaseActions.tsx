import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/src/components/ui/button";
import { ConfirmDialog } from "@/src/components/shared/ConfirmDialog";
import { useToast } from "@/src/components/shared/Toast";
import { api } from "@/src/lib/api";
import { PURCHASE_ACTION_LABEL, PURCHASE_TRANSITIONS } from "@/src/lib/labels";
import { formatInt } from "@/src/lib/format";
import type { PurchaseOrder, PurchaseStatus } from "@/src/types";

interface PurchaseActionsProps {
  order: PurchaseOrder;
  onDone?: () => void;
  /** 详情页用 default，列表行内用 sm */
  size?: "sm" | "default";
  /** 列表里空间紧张时只显示主操作 */
  primaryOnly?: boolean;
}

/**
 * 采购单状态流转按钮组。
 *
 * 可流转的状态由共享字典 PURCHASE_TRANSITIONS 决定 —— 服务端用同一份数据校验，
 * 因此这里渲染不出的动作，接口也一定不会接受。
 */
export function PurchaseActions({
  order,
  onDone,
  size = "sm",
  primaryOnly = false,
}: PurchaseActionsProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PurchaseStatus | null>(null);

  const allowed = PURCHASE_TRANSITIONS[order.status];
  const primary = allowed.filter((s) => s !== "cancelled");
  const canCancel = allowed.includes("cancelled");

  const visible = primaryOnly ? primary.slice(0, 1) : primary;

  if (allowed.length === 0) {
    return (
      <span className="text-[11px] text-slate-400">
        {order.status === "received" ? "已完结" : "—"}
      </span>
    );
  }

  const transition = async (next: PurchaseStatus) => {
    try {
      await api.transitionPurchaseOrder(order.id, next);
      const label = PURCHASE_ACTION_LABEL[next] ?? next;
      toast.success(
        next === "received"
          ? `${order.poNo} 已确认入库，库存已增加`
          : `${order.poNo} 已${label}`
      );
      setPending(null);
      onDone?.();
      // 新建的采购单可能还没有详情缓存，保持在当前页即可
    } catch (err) {
      // 状态机的非法流转会以 400 返回，原样提示
      toast.error(err instanceof Error ? err.message : "状态流转失败");
      setPending(null);
    }
  };

  const confirmText: Record<PurchaseStatus, string> = {
    draft: "退回草稿",
    pending: "提交后进入待审核状态，等待审批。",
    approved: "审核通过后即可安排供应商发货。",
    shipping: "标记发货后，货物进入在途状态。",
    received: `确认入库将把 ${formatInt(order.totalQuantity)} 件商品实际计入「${
      order.warehouse === "cn_main"
        ? "国内主仓"
        : order.warehouse === "us_west"
          ? "美西海外仓"
          : "德国海外仓"
    }」，并写入采购入库流水。`,
    cancelled: "取消后该采购单不可恢复。",
  };

  return (
    <div className="flex items-center justify-end gap-1.5">
      {visible.map((next) => (
        <Button
          key={next}
          variant={next === "received" ? "default" : "outline"}
          size={size}
          className="h-7 text-xs"
          onClick={() => setPending(next)}
        >
          {PURCHASE_ACTION_LABEL[next] ?? next}
        </Button>
      ))}

      {canCancel && !primaryOnly && (
        <Button
          variant="ghost"
          size={size}
          className="h-7 text-xs text-rose-600 hover:bg-rose-50"
          onClick={() => setPending("cancelled")}
        >
          取消
        </Button>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? (PURCHASE_ACTION_LABEL[pending] ?? "状态流转") : ""}
        description={pending ? confirmText[pending] : undefined}
        confirmLabel="确认"
        destructive={pending === "cancelled"}
        onConfirm={() => (pending ? transition(pending) : undefined)}
      />

      {onDone && (
        <Button
          variant="ghost"
          size={size}
          className="h-7 text-xs"
          onClick={() => navigate(`/purchase/${order.id}`)}
        >
          详情
        </Button>
      )}
    </div>
  );
}
