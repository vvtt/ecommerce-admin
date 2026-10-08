/**
 * 业务字典 —— 枚举的中文展示名、徽章样式、颜色，以及共享的参考数据。
 *
 * 前后端共用：前端经 `@/src/lib/labels` 引用，服务端用相对路径引用。
 * 本文件不得引入 React 或任何带 `@/` 别名的模块，否则服务端（tsx / esbuild）无法解析。
 */
import type {
  ChannelCode,
  ChannelStatus,
  ImageKind,
  ImageStatus,
  MovementType,
  ProductStatus,
  PurchaseStatus,
  SourcePlatform,
  StockHealth,
  WarehouseCode,
} from "../types";

/** 与 src/components/ui/badge.tsx 的 variant 保持一致 */
export type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info";

interface Meta {
  label: string;
  variant: BadgeVariant;
}

/* ------------------------------------------------------------------ *
 * 仓库
 * ------------------------------------------------------------------ */

export const WAREHOUSE_META: Record<
  WarehouseCode,
  { name: string; short: string; location: string; color: string }
> = {
  cn_main: { name: "国内主仓", short: "CN", location: "中国 · 深圳", color: "#2563eb" },
  us_west: { name: "美西海外仓", short: "US", location: "美国 · 洛杉矶", color: "#10b981" },
  de_central: { name: "德国海外仓", short: "DE", location: "德国 · 法兰克福", color: "#f59e0b" },
};

export const WAREHOUSE_CODES: WarehouseCode[] = ["cn_main", "us_west", "de_central"];

/* ------------------------------------------------------------------ *
 * 商品
 * ------------------------------------------------------------------ */

export const PRODUCT_STATUS_META: Record<ProductStatus, Meta> = {
  draft: { label: "草稿", variant: "secondary" },
  on_sale: { label: "在售", variant: "success" },
  off_shelf: { label: "已下架", variant: "outline" },
};

export const CHANNEL_META: Record<ChannelCode, { label: string; color: string }> = {
  amazon: { label: "Amazon", color: "#ff9900" },
  shopify: { label: "Shopify", color: "#5e8e3e" },
  tiktok: { label: "TikTok Shop", color: "#111827" },
};

export const CHANNEL_STATUS_META: Record<ChannelStatus, Meta> = {
  listed: { label: "已刊登", variant: "success" },
  not_listed: { label: "未刊登", variant: "secondary" },
  pending: { label: "刊登中", variant: "warning" },
  rejected: { label: "审核驳回", variant: "destructive" },
};

/* ------------------------------------------------------------------ *
 * 库存
 * ------------------------------------------------------------------ */

export const STOCK_HEALTH_META: Record<StockHealth, Meta & { short: string }> = {
  normal: { label: "库存正常", short: "正常", variant: "success" },
  low: { label: "低于安全库存", short: "偏低", variant: "warning" },
  out: { label: "已缺货", short: "缺货", variant: "destructive" },
};

export const MOVEMENT_TYPE_META: Record<MovementType, Meta & { sign: 1 | -1 | 0 }> = {
  inbound: { label: "采购入库", variant: "success", sign: 1 },
  outbound: { label: "订单出库", variant: "secondary", sign: -1 },
  adjust: { label: "盘点调整", variant: "warning", sign: 0 },
  return: { label: "退货入库", variant: "info", sign: 1 },
};

/* ------------------------------------------------------------------ *
 * 采购
 * ------------------------------------------------------------------ */

export const PURCHASE_STATUS_META: Record<PurchaseStatus, Meta> = {
  draft: { label: "草稿", variant: "secondary" },
  pending: { label: "待审核", variant: "warning" },
  approved: { label: "已审核", variant: "info" },
  shipping: { label: "在途", variant: "default" },
  received: { label: "已入库", variant: "success" },
  cancelled: { label: "已取消", variant: "outline" },
};

/**
 * 采购单状态机：每个状态可流转到的下一状态。
 * 服务端校验流转合法性，前端据此渲染操作按钮。
 */
export const PURCHASE_TRANSITIONS: Record<PurchaseStatus, PurchaseStatus[]> = {
  draft: ["pending", "cancelled"],
  pending: ["approved", "cancelled"],
  approved: ["shipping", "cancelled"],
  shipping: ["received"],
  received: [],
  cancelled: [],
};

/** 流转动作的中文名，用于按钮文案 */
export const PURCHASE_ACTION_LABEL: Partial<Record<PurchaseStatus, string>> = {
  pending: "提交审核",
  approved: "审核通过",
  shipping: "标记发货",
  received: "确认入库",
  cancelled: "取消订单",
};

/* ------------------------------------------------------------------ *
 * 货源采集
 * ------------------------------------------------------------------ */

/**
 * 图片转存状态。
 * pending 只出现在刚上报、后台下载还没跑完的短暂窗口内。
 */
export const IMAGE_STATUS_META: Record<ImageStatus, Meta & { short: string }> = {
  pending: { label: "转存中", short: "转存中", variant: "warning" },
  ok: { label: "已转存", short: "已转存", variant: "success" },
  partial: { label: "部分失败", short: "部分失败", variant: "warning" },
  failed: { label: "转存失败", short: "失败", variant: "destructive" },
};

export const IMAGE_KIND_META: Record<ImageKind, { label: string }> = {
  main: { label: "主图" },
  detail: { label: "详情图" },
  sku: { label: "SKU 图" },
};

export const SOURCE_PLATFORM_META: Record<SourcePlatform, { label: string; color: string }> = {
  "1688": { label: "1688", color: "#ff6a00" },
};

/** 采集域筛选下拉用；首版只有 1688，后续加平台时在这里追加 */
export const SOURCE_PLATFORMS: SourcePlatform[] = ["1688"];

/* ------------------------------------------------------------------ *
 * 参考数据
 * ------------------------------------------------------------------ */

export const SUPPLIERS = [
  "深圳市恒通电子有限公司",
  "义乌市博远家居用品厂",
  "宁波奥翔户外用品有限公司",
  "广州美研化妆品科技有限公司",
  "东莞市宠乐宠物用品厂",
] as const;

export const OPERATORS = [
  "李文博",
  "陈嘉怡",
  "黄志远",
  "林淑芬",
  "郑浩然",
] as const;

/** 销售渠道固定三件套 */
export const CHANNEL_CODES: ChannelCode[] = ["amazon", "shopify", "tiktok"];
