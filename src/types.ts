/**
 * 跨境电商后台 —— 商品与库存域 业务类型定义
 *
 * 该文件是全站类型的唯一来源：前端通过 `@/src/types` 引用，
 * 服务端（server/）通过相对路径 `import type` 引用。
 * 因为是纯类型导入，编译期即被擦除，不存在运行时解析问题。
 */

/* ------------------------------------------------------------------ *
 * 导航
 * ------------------------------------------------------------------ */

export type BadgeColor = "blue" | "emerald" | "amber" | "rose" | "slate";

/**
 * 侧边栏菜单节点。
 * 同时也是路由与面包屑的单一数据源 —— 见 src/data/menu.ts。
 * 有 `path` 才是可跳转叶子节点；只有 `children` 的是分组。
 */
export interface MenuNode {
  id: string;
  title: string;
  iconName?: string;
  badge?: string | number;
  badgeColor?: BadgeColor;
  path?: string;
  children?: MenuNode[];
}

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

/** 商品状态：草稿 / 在售 / 下架 */
export type ProductStatus = "draft" | "on_sale" | "off_shelf";

/** 销售渠道 */
export type ChannelCode = "amazon" | "shopify" | "tiktok";

/** 渠道内刊登状态 */
export type ChannelStatus = "listed" | "not_listed" | "pending" | "rejected";

/** 仓库：国内主仓 / 美西海外仓 / 德国海外仓 */
export type WarehouseCode = "cn_main" | "us_west" | "de_central";

/** 库存健康度：正常 / 低于安全库存 / 缺货 */
export type StockHealth = "normal" | "low" | "out";

/** 库存流水类型：入库 / 出库 / 盘点调整 / 退货入库 */
export type MovementType = "inbound" | "outbound" | "adjust" | "return";

/** 采购单状态流转：草稿 → 待审核 → 已审核 → 在途 → 已入库 / 已取消 */
export type PurchaseStatus =
  | "draft"
  | "pending"
  | "approved"
  | "shipping"
  | "received"
  | "cancelled";

/* ------------------------------------------------------------------ *
 * 商品
 * ------------------------------------------------------------------ */

/** 商品属性（非销售属性，如材质、产地） */
export interface ProductAttribute {
  name: string;
  value: string;
}

/** 商品在某渠道的刊登情况 */
export interface ProductChannel {
  code: ChannelCode;
  status: ChannelStatus;
  /** 平台侧商品 ID */
  listingId?: string;
  lastSyncedAt?: string;
}

/** 最小销售单元。库存字段按仓库汇总后的总量存放在此 */
export interface Sku {
  id: string;
  skuCode: string;
  productId: string;
  /** 规格值，如 { 颜色: "午夜黑", 尺码: "M" } */
  specValues: Record<string, string>;
  barcode: string;
  /** 售价，USD */
  price: number;
  /** 成本价，CNY */
  costPrice: number;
  weightGram: number;
  image?: string;
  /** 在手库存（三个仓库合计） */
  stock: number;
  /** 订单占用库存 */
  lockedStock: number;
  /** 安全库存阈值 */
  safetyStock: number;
}

/** SPU 主档 */
export interface Product {
  id: string;
  /** 商品编码，如 SPU-10001 */
  spu: string;
  /** 中文标题 */
  title: string;
  /** 英文标题（跨境必需） */
  titleEn: string;
  categoryId: string;
  brand: string;
  mainImage: string;
  status: ProductStatus;
  attributes: ProductAttribute[];
  tags: string[];
  channels: ProductChannel[];
  skus: Sku[];
  createdAt: string;
  updatedAt: string;
  operator: string;
}

/* ------------------------------------------------------------------ *
 * 类目
 * ------------------------------------------------------------------ */

export interface Category {
  id: string;
  name: string;
  nameEn: string;
  parentId: string | null;
  /** 1 = 一级类目 */
  level: number;
  /** 含子类目的商品数合计，由服务端计算 */
  productCount: number;
  /** 平台佣金率（%） */
  commissionRate: number;
  /** 服务端构树时填充 */
  children?: Category[];
}

/* ------------------------------------------------------------------ *
 * 库存
 * ------------------------------------------------------------------ */

/**
 * 库存记录，粒度为 SKU × 仓库。
 * `available` / `health` 是服务端派生字段，前端直接渲染，不再自行计算。
 */
export interface InventoryRecord {
  id: string;
  skuId: string;
  skuCode: string;
  productId: string;
  productTitle: string;
  /** 规格文案，如 "午夜黑 / M" */
  specText: string;
  image: string;
  warehouse: WarehouseCode;
  onHand: number;
  locked: number;
  /** = onHand - locked */
  available: number;
  safetyStock: number;
  health: StockHealth;
  lastInboundAt: string;
  updatedAt: string;
}

/** 库存流水 */
export interface StockMovement {
  id: string;
  skuCode: string;
  productTitle: string;
  specText: string;
  warehouse: WarehouseCode;
  type: MovementType;
  /** 变动数量，入库为正、出库为负 */
  quantity: number;
  beforeQty: number;
  afterQty: number;
  /** 关联单号：采购单号 / 订单号 / 盘点单号 */
  refNo: string;
  operator: string;
  remark?: string;
  createdAt: string;
}

/** 库存概览 KPI */
export interface InventorySummary {
  /** 在管 SKU 数 */
  totalSkus: number;
  totalOnHand: number;
  totalLocked: number;
  totalAvailable: number;
  lowStockCount: number;
  outOfStockCount: number;
  /** 库存成本总额，CNY */
  stockValueCny: number;
  /** 预计周转天数 */
  turnoverDays: number;
}

/* ------------------------------------------------------------------ *
 * 采购补货
 * ------------------------------------------------------------------ */

export interface PurchaseOrderItem {
  id: string;
  skuId: string;
  skuCode: string;
  productTitle: string;
  specText: string;
  quantity: number;
  receivedQty: number;
  /** 采购单价，CNY */
  unitCost: number;
  /** = quantity * unitCost，服务端计算 */
  amount: number;
}

export interface PurchaseOrder {
  id: string;
  /** 采购单号，如 PO-20260301-001 */
  poNo: string;
  supplier: string;
  /** 目的仓 */
  warehouse: WarehouseCode;
  status: PurchaseStatus;
  items: PurchaseOrderItem[];
  /** 服务端计算的汇总字段 */
  totalAmount: number;
  totalQuantity: number;
  currency: "CNY";
  expectedAt: string;
  operator: string;
  remark?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * 货源采集（1688）
 *
 * 与商品/库存/采购三域不同，采集域的数据来自浏览器扩展上报，
 * 持久化在服务端 SQLite 中（server/sourcing/），浏览器端没有等价实现，
 * 因此这一域不提供离线兜底 —— 详见 src/lib/api.ts 的说明。
 * ------------------------------------------------------------------ */

/** 采集来源平台。首版只做 1688 */
export type SourcePlatform = "1688";

/** 图片转存状态。pending = 尚未下载完成 */
export type ImageStatus = "pending" | "ok" | "partial" | "failed";

/** 图片用途 */
export type ImageKind = "main" | "detail" | "sku";

/**
 * 阶梯价档位：购买量落在 [beginAmount, endAmount] 时单价为 price。
 * 最后一档不填 endAmount，表示无上限。
 */
export interface PriceTier {
  beginAmount: number;
  endAmount?: number;
  /** 单价，CNY */
  price: number;
}

/** 一条规格维度定义，如 { name: "颜色", values: ["红色", "蓝色"] } */
export interface SpecDimension {
  name: string;
  values: string[];
}

/** 采集到的 SKU。价格/库存可能缺失（未登录时 1688 不返回） */
export interface CollectedSku {
  /** 1688 侧的 SKU 标识 */
  skuId: string;
  /** 规格值，如 { 颜色: "红色", 尺码: "M" } */
  specValues: Record<string, string>;
  price?: number;
  stock?: number;
  /** SKU 图原始 URL，尚未转存 */
  imageUrl?: string;
}

export interface CollectedAttribute {
  name: string;
  value: string;
}

export interface CollectedSupplier {
  /** 公司名 */
  name?: string;
  /** 1688 登录账号 */
  loginId?: string;
  /** 所在地，如 "浙江 金华" */
  location?: string;
  shopUrl?: string;
}

/**
 * 扩展采集并归一化后上报的载荷。
 *
 * 这是「我们自己的结构」—— 扩展负责把 1688 页面的原始数据映射到这里。
 * 后端收到时已是成品字段值，不做任何 HTML 解析，也不碰 cookie。
 * 扩展侧对应 extension/main-world.js 的字段映射表。
 */
export interface CollectedOffer {
  platform: SourcePlatform;
  offerId: string;
  url: string;
  title: string;
  supplier: CollectedSupplier;
  /** 起订量 */
  moq?: number;
  priceLadder: PriceTier[];
  specDimensions: SpecDimension[];
  skus: CollectedSku[];
  attributes: CollectedAttribute[];
  /** 原始图片 URL（未转存） */
  images: {
    main: string[];
    detail: string[];
  };
  weightGram?: number;
  /** 长宽高，单位 cm */
  dimensions?: { length: number; width: number; height: number };
  /**
   * 解析器版本。1688 改版 → 改映射表 → 版本号 +1，
   * 据此可筛出「用旧版解析的、可能需要重采」的记录。
   */
  extractorVersion: string;
  capturedAt: string;
}

/** 转存后的一张图片 */
export interface SourcingImage {
  id: string;
  kind: ImageKind;
  sourceUrl: string;
  /** 转存后的可访问路径，如 /uploads/so_1688_612345/ab12cd.jpg；未成功时为空串 */
  localPath: string;
  status: ImageStatus;
  /** 失败原因 */
  error?: string;
  bytes?: number;
}

/** 列表项：只带列表要展示的字段，不含 SKU 明细与图片清单 */
export interface SourcingOfferSummary {
  id: string;
  platform: SourcePlatform;
  offerId: string;
  url: string;
  title: string;
  supplierName?: string;
  supplierLocation?: string;
  moq?: number;
  /** 由 priceLadder 派生 */
  priceMin?: number;
  priceMax?: number;
  skuCount: number;
  /** 列表缩略图 = 转存成功的第一张主图；转存未完成时为空串 */
  thumbnail: string;
  imageStatus: ImageStatus;
  imageOkCount: number;
  imageFailCount: number;
  extractorVersion: string;
  collectedAt: string;
  updatedAt: string;
}

/** 详情：列表字段 + 完整明细 */
export interface SourcingOfferDetail extends SourcingOfferSummary {
  supplier: CollectedSupplier;
  priceLadder: PriceTier[];
  specDimensions: SpecDimension[];
  skus: CollectedSku[];
  attributes: CollectedAttribute[];
  images: SourcingImage[];
  weightGram?: number;
  dimensions?: { length: number; width: number; height: number };
}

/**
 * 采集域查询参数。
 *
 * 放在这里而不是像 ProductQuery 那样放进 shared/queries.ts，是因为
 * 采集域的查询实现依赖 node:sqlite（Node 专有），无法放进浏览器安全的
 * shared/ 层。放这里可以保证「前端永不 import server/」这条约束不被打破。
 */
export interface SourcingQuery {
  q?: string;
  platform?: SourcePlatform | "all";
  imageStatus?: ImageStatus | "all";
  sortBy?: "collectedAt" | "priceMin" | "moq" | "title";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

/** 采集统计 */
export interface SourcingStats {
  total: number;
  /** 今日新增 */
  todayNew: number;
  imageFailed: number;
  imagePending: number;
}

/** 采集上报的响应 */
export interface CollectResult {
  offer: SourcingOfferDetail;
  /** created = 新入库；updated = 覆盖已有记录 */
  action: "created" | "updated";
}

/* ------------------------------------------------------------------ *
 * 竞品分析（Shopee 竞品商品库）
 * ------------------------------------------------------------------ */

/**
 * 竞品域查询参数。
 *
 * 与 SourcingQuery 同理放在这里：查询实现依赖 node:sqlite（Node 专有），
 * 放 shared/ 会打破「前端永不 import server/」的约束。
 */
export interface CompetitorQuery {
  q?: string;
  page?: number;
  pageSize?: number;
}

/** 竞品商品列表项。按需求只暴露轻字段，评论与 SKU 大字段留在详情里 */
export interface CompetitorProductSummary {
  shopId: string;
  itemId: string;
  name: string;
  /** 分类链（后端树），"居家生活 > ..." */
  categoryPath: string;
  feCategoryPath?: string;
  price?: number;
  priceMin?: number;
  priceMax?: number;
  currency: string;
  ratingStar?: number;
  modelCount?: number;
  reviewCount: number;
  shopName?: string;
  /** cb_option：1 = 跨境商品 */
  isCrossBorder?: number;
  itemStatus?: string;
  /** 商品页链接（Shopee 站内 URL），表格里直接点击跳转 */
  url: string;
  capturedAt: string;
  updatedAt: string;
}

/** 单条竞品评论（shape 与插件上报/落盘的 JSONL 行一致） */
export interface CompetitorReview {
  /** 去重键：作者|时间|内容前 80 字 */
  _key: string;
  authorUsername: string;
  authorName?: string;
  ratingStar?: number;
  comment: string;
  commentTag?: string;
  /** 评论时间（unix 秒） */
  ctime?: number;
  capturedAt: string;
}

/** 详情：列表字段 + 导出 txt 需要的完整明细 */
export interface CompetitorProductDetail extends CompetitorProductSummary {
  catId?: number;
  descriptionText: string;
  attributes: { name: string; value: string }[];
  tierVariations: { name: string; options: string[] }[];
  models: { modelid?: number; name: string; price?: number; normal_stock?: number }[];
  shopLocation?: string;
  /** 上架时间（unix 秒） */
  listedAt?: number;
  /** 全量评论，已按时间倒序（与入库顺序一致） */
  reviews: CompetitorReview[];
}

/* ------------------------------------------------------------------ *
 * 接口响应
 * ------------------------------------------------------------------ */

/** 统一分页响应 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 概览页：仓库库存分布（饼图数据源） */
export interface WarehouseDistribution {
  warehouse: WarehouseCode;
  warehouseName: string;
  onHand: number;
  valueCny: number;
  color: string;
}

/** 概览页：类目库存分布（柱图数据源） */
export interface CategoryStock {
  categoryId: string;
  categoryName: string;
  skuCount: number;
  onHand: number;
}

/** 概览页：低库存 TOP 榜 */
export interface LowStockItem {
  skuCode: string;
  productTitle: string;
  specText: string;
  warehouse: WarehouseCode;
  available: number;
  safetyStock: number;
  health: StockHealth;
}

/** 概览页 KPI 卡片数据 */
export interface OverviewKpi {
  spuCount: number;
  onSaleCount: number;
  skuCount: number;
  inventoryValueCny: number;
  lowStockSkuCount: number;
  outOfStockSkuCount: number;
  pendingPurchaseCount: number;
  inTransitQty: number;
}

export interface OverviewResponse {
  kpi: OverviewKpi;
  warehouseDistribution: WarehouseDistribution[];
  categoryStock: CategoryStock[];
  lowStockTop: LowStockItem[];
}

/** 数据来源标记：命中 Express API，还是回退到本地 mock */
export type DataSource = "api" | "mock";
