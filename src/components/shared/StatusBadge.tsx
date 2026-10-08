import { Badge } from "@/src/components/ui/badge";
import {
  CHANNEL_STATUS_META,
  IMAGE_STATUS_META,
  MOVEMENT_TYPE_META,
  PRODUCT_STATUS_META,
  PURCHASE_STATUS_META,
  SOURCE_PLATFORM_META,
  STOCK_HEALTH_META,
  WAREHOUSE_META,
  type BadgeVariant,
} from "@/src/lib/labels";
import { cn } from "@/src/lib/utils";
import type {
  ChannelStatus,
  ImageStatus,
  MovementType,
  ProductStatus,
  PurchaseStatus,
  SourcePlatform,
  StockHealth,
  WarehouseCode,
} from "@/src/types";

/**
 * 状态徽章：把枚举统一渲染成「中文名 + 语义色」。
 * 所有颜色来自 labels.ts 的字典，页面里不再散落 if/else 配色。
 */

function render(label: string, variant: BadgeVariant, className?: string) {
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}

export function ProductStatusBadge({
  status,
  className,
}: {
  status: ProductStatus;
  className?: string;
}) {
  const meta = PRODUCT_STATUS_META[status];
  return render(meta.label, meta.variant, className);
}

export function StockHealthBadge({
  health,
  short,
  className,
}: {
  health: StockHealth;
  /** 表格里空间紧张时用短文案 */
  short?: boolean;
  className?: string;
}) {
  const meta = STOCK_HEALTH_META[health];
  return render(short ? meta.short : meta.label, meta.variant, className);
}

export function MovementTypeBadge({
  type,
  className,
}: {
  type: MovementType;
  className?: string;
}) {
  const meta = MOVEMENT_TYPE_META[type];
  return render(meta.label, meta.variant, className);
}

export function PurchaseStatusBadge({
  status,
  className,
}: {
  status: PurchaseStatus;
  className?: string;
}) {
  const meta = PURCHASE_STATUS_META[status];
  return render(meta.label, meta.variant, className);
}

export function ChannelStatusBadge({
  status,
  className,
}: {
  status: ChannelStatus;
  className?: string;
}) {
  const meta = CHANNEL_STATUS_META[status];
  return render(meta.label, meta.variant, className);
}

export function ImageStatusBadge({
  status,
  short,
  className,
}: {
  status: ImageStatus;
  /** 表格里空间紧张时用短文案 */
  short?: boolean;
  className?: string;
}) {
  const meta = IMAGE_STATUS_META[status];
  return render(short ? meta.short : meta.label, meta.variant, className);
}

/**
 * 来源平台标签。
 *
 * 用平台自己的品牌色（1688 是橙色）而不是 Meta 的语义色 —— 它标识的是
 * "来自哪个站"，不是状态，用红黄绿会误导。
 */
export function SourcePlatformBadge({
  platform,
  className,
}: {
  platform: SourcePlatform;
  className?: string;
}) {
  const meta = SOURCE_PLATFORM_META[platform];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-none",
        className
      )}
      style={{
        color: meta.color,
        borderColor: `${meta.color}55`,
        backgroundColor: `${meta.color}14`,
      }}
    >
      {meta.label}
    </span>
  );
}

/** 仓库标签带一个小色点，和概览页图表的配色对应 */
export function WarehouseTag({
  code,
  className,
}: {
  code: WarehouseCode;
  className?: string;
}) {
  const meta = WAREHOUSE_META[code];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-slate-700 ${className ?? ""}`}>
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: meta.color }}
      />
      {meta.name}
    </span>
  );
}
