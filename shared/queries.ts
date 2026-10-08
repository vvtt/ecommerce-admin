/**
 * 共享查询层 —— 所有只读业务查询的唯一实现。
 *
 * 服务端（server/routes/*）把它包成 HTTP 接口；前端在接口不可达时
 * 直接调用同一批函数。因此离线兜底与在线行为逐字一致，不存在两套逻辑。
 *
 * 约定：过滤 + 排序 + 分页都在这一层完成（模拟真实服务的服务端分页语义），
 * 前端表格用 TanStack 的 manualPagination / manualSorting 配合。
 */
import type {
  Category,
  CategoryStock,
  InventoryRecord,
  InventorySummary,
  LowStockItem,
  MovementType,
  OverviewResponse,
  Paginated,
  Product,
  ProductStatus,
  PurchaseOrder,
  PurchaseStatus,
  Sku,
  StockHealth,
  StockMovement,
  WarehouseCode,
  WarehouseDistribution,
} from "../src/types";
import { WAREHOUSE_CODES, WAREHOUSE_META } from "../src/lib/labels";
import { db, refreshDerived } from "./db";

/* ------------------------------------------------------------------ *
 * 通用
 * ------------------------------------------------------------------ */

function paginate<T>(rows: T[], page?: number, pageSize?: number): Paginated<T> {
  const size = Math.min(Math.max(Math.trunc(pageSize ?? 10) || 10, 1), 200);
  const current = Math.max(Math.trunc(page ?? 1) || 1, 1);
  const start = (current - 1) * size;
  return { items: rows.slice(start, start + size), total: rows.length, page: current, pageSize: size };
}

const matches = (haystack: (string | undefined)[], needle: string) =>
  haystack.some((h) => h?.toLowerCase().includes(needle));

function compare(a: string | number, b: string | number, dir: 1 | -1): number {
  if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
  return String(a).localeCompare(String(b), "zh-CN") * dir;
}

/** SKU id → Sku，供库存记录反查成本价等字段 */
function skuIndex(): Map<string, Sku> {
  const map = new Map<string, Sku>();
  for (const p of db.products) for (const s of p.skus) map.set(s.id, s);
  return map;
}

/** SKU id → 所属类目 id */
function skuCategoryIndex(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of db.products) for (const s of p.skus) map.set(s.id, p.categoryId);
  return map;
}

/* ------------------------------------------------------------------ *
 * 商品
 * ------------------------------------------------------------------ */

export interface ProductQuery {
  q?: string;
  status?: ProductStatus | "all";
  categoryId?: string;
  sortBy?: "spu" | "title" | "stock" | "price" | "updatedAt";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function queryProducts(params: ProductQuery): Paginated<Product> {
  refreshDerived();
  let rows = db.products.slice();

  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((p) =>
      matches(
        [p.title, p.titleEn, p.spu, p.brand, ...p.skus.map((s) => s.skuCode)],
        q
      )
    );
  }

  if (params.status && params.status !== "all") {
    rows = rows.filter((p) => p.status === params.status);
  }

  if (params.categoryId && params.categoryId !== "all") {
    // 选一级类目时按其全部子类目筛选
    const cat = db.categories.find((c) => c.id === params.categoryId);
    const ids =
      cat?.level === 1
        ? db.categories.filter((c) => c.parentId === cat.id).map((c) => c.id)
        : [params.categoryId];
    rows = rows.filter((p) => ids.includes(p.categoryId));
  }

  const dir: 1 | -1 = params.sortDir === "asc" ? 1 : -1;
  const sortBy = params.sortBy ?? "updatedAt";
  rows.sort((a, b) => {
    switch (sortBy) {
      case "spu":
        return compare(a.spu, b.spu, dir);
      case "title":
        return compare(a.title, b.title, dir);
      case "stock":
        return compare(
          a.skus.reduce((n, s) => n + s.stock, 0),
          b.skus.reduce((n, s) => n + s.stock, 0),
          dir
        );
      case "price":
        return compare(
          Math.min(...a.skus.map((s) => s.price)),
          Math.min(...b.skus.map((s) => s.price)),
          dir
        );
      default:
        return compare(a.updatedAt, b.updatedAt, dir);
    }
  });

  return paginate(rows, params.page, params.pageSize);
}

export function getProductById(id: string): Product | undefined {
  refreshDerived();
  return db.products.find((p) => p.id === id || p.spu === id);
}

/* ------------------------------------------------------------------ *
 * 类目
 * ------------------------------------------------------------------ */

export function getCategoryTree(): Category[] {
  refreshDerived();
  return db.categories
    .filter((c) => c.level === 1)
    .map((top) => ({
      ...top,
      children: db.categories.filter((c) => c.parentId === top.id).map((c) => ({ ...c })),
    }));
}

/* ------------------------------------------------------------------ *
 * 库存
 * ------------------------------------------------------------------ */

export interface InventoryQuery {
  q?: string;
  warehouse?: WarehouseCode | "all";
  health?: StockHealth | "all";
  sortBy?: "onHand" | "available" | "safetyStock" | "skuCode";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function queryInventory(params: InventoryQuery): Paginated<InventoryRecord> {
  refreshDerived();
  let rows = db.inventory.slice();

  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => matches([r.skuCode, r.productTitle, r.specText], q));
  }

  if (params.warehouse && params.warehouse !== "all") {
    rows = rows.filter((r) => r.warehouse === params.warehouse);
  }

  if (params.health && params.health !== "all") {
    rows = rows.filter((r) => r.health === params.health);
  }

  const dir: 1 | -1 = params.sortDir === "asc" ? 1 : -1;
  const sortBy = params.sortBy ?? "available";
  rows.sort((a, b) => compare(a[sortBy], b[sortBy], dir));

  return paginate(rows, params.page, params.pageSize);
}

export function getInventoryRecord(id: string): InventoryRecord | undefined {
  return db.inventory.find((r) => r.id === id);
}

export function getInventorySummary(): InventorySummary {
  refreshDerived();
  const idx = skuIndex();
  const value = db.inventory.reduce(
    (sum, r) => sum + r.onHand * (idx.get(r.skuId)?.costPrice ?? 0),
    0
  );

  // 周转天数 = 当前在手 / 近 30 天日均出库量
  const cutoff = Date.now() - 30 * 86_400_000;
  const outbound = db.movements
    .filter((m) => m.type === "outbound" && new Date(m.createdAt).getTime() >= cutoff)
    .reduce((sum, m) => sum + Math.abs(m.quantity), 0);
  const dailyAvg = outbound / 30;
  const onHand = db.inventory.reduce((sum, r) => sum + r.onHand, 0);

  return {
    totalSkus: new Set(db.inventory.map((r) => r.skuId)).size,
    totalOnHand: onHand,
    totalLocked: db.inventory.reduce((sum, r) => sum + r.locked, 0),
    totalAvailable: db.inventory.reduce((sum, r) => sum + r.available, 0),
    lowStockCount: new Set(db.inventory.filter((r) => r.health === "low").map((r) => r.skuId)).size,
    outOfStockCount: new Set(db.inventory.filter((r) => r.health === "out").map((r) => r.skuId)).size,
    stockValueCny: Math.round(value),
    turnoverDays: dailyAvg > 0 ? Math.round((onHand / dailyAvg) * 10) / 10 : 0,
  };
}

export interface MovementQuery {
  q?: string;
  type?: MovementType | "all";
  warehouse?: WarehouseCode | "all";
  page?: number;
  pageSize?: number;
}

export function queryMovements(params: MovementQuery): Paginated<StockMovement> {
  let rows = db.movements.slice(); // 种子里已按时间倒序

  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((m) => matches([m.skuCode, m.productTitle, m.refNo, m.operator], q));
  }
  if (params.type && params.type !== "all") rows = rows.filter((m) => m.type === params.type);
  if (params.warehouse && params.warehouse !== "all") {
    rows = rows.filter((m) => m.warehouse === params.warehouse);
  }

  return paginate(rows, params.page, params.pageSize);
}

/* ------------------------------------------------------------------ *
 * 采购
 * ------------------------------------------------------------------ */

export interface PurchaseQuery {
  q?: string;
  status?: PurchaseStatus | "all";
  warehouse?: WarehouseCode | "all";
  page?: number;
  pageSize?: number;
}

export function queryPurchaseOrders(params: PurchaseQuery): Paginated<PurchaseOrder> {
  let rows = db.purchaseOrders.slice();

  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((po) =>
      matches([po.poNo, po.supplier, po.operator, ...po.items.map((i) => i.skuCode)], q)
    );
  }
  if (params.status && params.status !== "all") rows = rows.filter((po) => po.status === params.status);
  if (params.warehouse && params.warehouse !== "all") {
    rows = rows.filter((po) => po.warehouse === params.warehouse);
  }

  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return paginate(rows, params.page, params.pageSize);
}

export function getPurchaseOrderById(id: string): PurchaseOrder | undefined {
  return db.purchaseOrders.find((po) => po.id === id || po.poNo === id);
}

/* ------------------------------------------------------------------ *
 * 概览
 * ------------------------------------------------------------------ */

export function getOverview(): OverviewResponse {
  refreshDerived();
  const idx = skuIndex();
  const skuCat = skuCategoryIndex();

  const skuCount = db.products.reduce((n, p) => n + p.skus.length, 0);
  const inventoryValueCny = db.products.reduce(
    (sum, p) => sum + p.skus.reduce((s, sk) => s + sk.stock * sk.costPrice, 0),
    0
  );

  const warehouseDistribution: WarehouseDistribution[] = WAREHOUSE_CODES.map((code) => {
    const rows = db.inventory.filter((r) => r.warehouse === code);
    return {
      warehouse: code,
      warehouseName: WAREHOUSE_META[code].name,
      onHand: rows.reduce((s, r) => s + r.onHand, 0),
      valueCny: Math.round(
        rows.reduce((s, r) => s + r.onHand * (idx.get(r.skuId)?.costPrice ?? 0), 0)
      ),
      color: WAREHOUSE_META[code].color,
    };
  });

  const categoryStock: CategoryStock[] = db.categories
    .filter((c) => c.level === 1)
    .map((top) => {
      const childIds = db.categories.filter((c) => c.parentId === top.id).map((c) => c.id);
      const rows = db.inventory.filter((r) => childIds.includes(skuCat.get(r.skuId) ?? ""));
      return {
        categoryId: top.id,
        categoryName: top.name,
        skuCount: new Set(rows.map((r) => r.skuId)).size,
        onHand: rows.reduce((s, r) => s + r.onHand, 0),
      };
    });

  const lowStockTop: LowStockItem[] = db.inventory
    .filter((r) => r.health !== "normal")
    .sort((a, b) => {
      // 按「可用量 / 安全库存」升序，最告急的排最前
      const ra = a.safetyStock > 0 ? a.available / a.safetyStock : 99;
      const rb = b.safetyStock > 0 ? b.available / b.safetyStock : 99;
      return ra - rb;
    })
    .slice(0, 8)
    .map((r) => ({
      skuCode: r.skuCode,
      productTitle: r.productTitle,
      specText: r.specText,
      warehouse: r.warehouse,
      available: r.available,
      safetyStock: r.safetyStock,
      health: r.health,
    }));

  return {
    kpi: {
      spuCount: db.products.length,
      onSaleCount: db.products.filter((p) => p.status === "on_sale").length,
      skuCount,
      inventoryValueCny: Math.round(inventoryValueCny),
      lowStockSkuCount: new Set(
        db.inventory.filter((r) => r.health === "low").map((r) => r.skuId)
      ).size,
      outOfStockSkuCount: new Set(
        db.inventory.filter((r) => r.health === "out").map((r) => r.skuId)
      ).size,
      pendingPurchaseCount: db.purchaseOrders.filter(
        (po) => po.status === "pending" || po.status === "approved"
      ).length,
      inTransitQty: db.purchaseOrders
        .filter((po) => po.status === "shipping")
        .reduce((s, po) => s + po.totalQuantity, 0),
    },
    warehouseDistribution,
    categoryStock,
    lowStockTop,
  };
}
