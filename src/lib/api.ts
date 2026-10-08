/**
 * 前端数据访问层。
 *
 * 每个方法都优先打 Express 接口；只有**网络层失败**（服务未启动、断网）才回退到
 * shared/ 里的同一批函数，并如实把 source 标成 "mock" 让页面提示用户。
 *
 * 关键约定：服务端返回的 4xx 是真实业务校验失败（如售价为 0、库存低于占用量），
 * 必须原样抛给调用方展示，绝不能被兜底逻辑吞掉假装成功。
 */
import type {
  Category,
  CompetitorProductDetail,
  CompetitorProductSummary,
  CompetitorQuery,
  DataSource,
  InventoryRecord,
  InventorySummary,
  OverviewResponse,
  Paginated,
  Product,
  PurchaseOrder,
  SourcingOfferDetail,
  SourcingOfferSummary,
  SourcingQuery,
  SourcingStats,
  StockMovement,
  WarehouseCode,
} from "@/src/types";
import type {
  InventoryQuery,
  MovementQuery,
  ProductQuery,
  PurchaseQuery,
} from "@/shared/queries";
import {
  getCategoryTree,
  getInventorySummary,
  getOverview,
  getProductById,
  getPurchaseOrderById,
  queryInventory,
  queryMovements,
  queryProducts,
  queryPurchaseOrders,
} from "@/shared/queries";
import {
  adjustStock,
  batchDeleteProducts,
  batchUpdateProductStatus,
  createProduct,
  createPurchaseOrder,
  deleteProduct,
  transitionPurchaseOrder,
  updateProduct,
} from "@/shared/mutations";
import type {
  AdjustStockInput,
  ProductInput,
  PurchaseOrderInput,
} from "@/shared/mutations";
import type { ProductStatus, PurchaseStatus } from "@/src/types";
import { clearSession, getSession } from "@/src/lib/auth";

/** 会话失效的统一出口：清本地会话并回到登录页 */
function handleUnauthorized(): void {
  clearSession();
  // 直接整页跳转，比路由 API 省事且不依赖组件上下文
  window.location.href = "/login";
}

export interface ApiResult<T> {
  data: T;
  source: DataSource;
}

/** 带 HTTP 状态码的错误，用于区分「业务校验失败」与「服务不可达」 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 参数签名收 object 而非 Record<string, unknown>：接口类型没有索引签名，否则每处调用都要断言 */
function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** 带会话的请求头。登录 token 存在时所有 API 请求都带上 */
function authHeaders(): Record<string, string> {
  const session = getSession();
  return session
    ? { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }
    : { "Content-Type": "application/json" };
}

/** GET：网络失败时回退本地实现 */
async function apiGet<T>(url: string, offline: () => T): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 401) {
      handleUnauthorized();
      throw new ApiError("登录已过期", 401);
    }
    if (!res.ok) {
      // 接口存在但报错（404/500），说明服务是活的，不该伪装成离线
      throw new ApiError(`接口返回 ${res.status}`, res.status);
    }
    return { data: (await res.json()) as T, source: "api" };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return { data: offline(), source: "mock" };
  }
}

/** 写操作：业务校验失败照实抛错，仅网络失败才落到本地实现 */
async function apiSend<T>(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
  offline: () => T
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      handleUnauthorized();
      throw new ApiError("登录已过期", 401);
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(payload?.error ?? `请求失败 (HTTP ${res.status})`, res.status);
    }
    return { data: (await res.json()) as T, source: "api" };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return { data: offline(), source: "mock" };
  }
}

/**
 * 采集域的「无兜底」占位。
 *
 * 现有三域的兜底能成立，是因为那份实现前后端共用：兜底 lambda 直接调
 * shared/queries.ts，浏览器里跑的是同一段代码。采集域的数据在服务端
 * SQLite 里（server/sourcing/），浏览器端**没有等价实现**。
 *
 * 所以这里不返回 mock，而是抛错让页面走 ErrorState。给一个假的空列表或
 * 编造的记录反而更危险 —— 用户会以为自己看到的是真实采集结果。
 * 这不是漏写，是有意为之。
 */
const noOfflineSourcing = (): never => {
  throw new ApiError("采集数据需要后端服务支持，请确认 npm run dev 已启动", 503);
};

/**
 * 竞品域同款「无兜底」：数据只在服务端 SQLite（server/competitor/），浏览器端
 * 没有等价实现。接口不可达时如实报错，不伪造数据。
 */
const noOfflineCompetitor = (): never => {
  throw new ApiError("竞品数据需要后端服务支持，请确认 npm run dev 已启动", 503);
};

export const api = {
  /* ---------------- 概览 ---------------- */
  getOverview: () => apiGet<OverviewResponse>("/api/overview", getOverview),

  /* ---------------- 商品 ---------------- */
  listProducts: (query: ProductQuery) =>
    apiGet<Paginated<Product>>(`/api/products${qs(query)}`, () => queryProducts(query)),

  getProduct: (id: string) =>
    apiGet<Product | null>(`/api/products/${encodeURIComponent(id)}`, () =>
      getProductById(id) ?? null
    ),

  createProduct: (input: ProductInput) =>
    apiSend<Product>("/api/products", "POST", input, () => createProduct(input)),

  updateProduct: (id: string, input: ProductInput) =>
    apiSend<Product>(`/api/products/${encodeURIComponent(id)}`, "PUT", input, () => {
      const updated = updateProduct(id, input);
      if (!updated) throw new ApiError(`商品不存在: ${id}`, 404);
      return updated;
    }),

  deleteProduct: (id: string) =>
    apiSend<{ ok: boolean }>(`/api/products/${encodeURIComponent(id)}`, "DELETE", undefined, () => {
      if (!deleteProduct(id)) throw new ApiError(`商品不存在: ${id}`, 404);
      return { ok: true };
    }),

  batchProducts: (
    ids: string[],
    action: "activate" | "deactivate" | "delete"
  ) =>
    apiSend<{ affected: number }>("/api/products/batch", "POST", { ids, action }, () => {
      if (action === "delete") return { affected: batchDeleteProducts(ids) };
      const status: ProductStatus = action === "activate" ? "on_sale" : "off_shelf";
      return { affected: batchUpdateProductStatus(ids, status) };
    }),

  /* ---------------- 类目 ---------------- */
  listCategories: () =>
    apiGet<{ items: Category[] }>("/api/categories", () => ({ items: getCategoryTree() })),

  /* ---------------- 库存 ---------------- */
  listInventory: (query: InventoryQuery) =>
    apiGet<Paginated<InventoryRecord>>(`/api/inventory${qs(query)}`, () =>
      queryInventory(query)
    ),

  getInventorySummary: () =>
    apiGet<InventorySummary>("/api/inventory/summary", getInventorySummary),

  listMovements: (query: MovementQuery) =>
    apiGet<Paginated<StockMovement>>(`/api/inventory/movements${qs(query)}`, () =>
      queryMovements(query)
    ),

  adjustStock: (input: AdjustStockInput) =>
    apiSend<{ record: InventoryRecord; movement: StockMovement }>(
      "/api/inventory/adjust",
      "POST",
      input,
      () => adjustStock(input)
    ),

  /* ---------------- 采购 ---------------- */
  listPurchaseOrders: (query: PurchaseQuery) =>
    apiGet<Paginated<PurchaseOrder>>(`/api/purchase-orders${qs(query)}`, () =>
      queryPurchaseOrders(query)
    ),

  getPurchaseOrder: (id: string) =>
    apiGet<PurchaseOrder | null>(`/api/purchase-orders/${encodeURIComponent(id)}`, () =>
      getPurchaseOrderById(id) ?? null
    ),

  createPurchaseOrder: (input: PurchaseOrderInput) =>
    apiSend<PurchaseOrder>("/api/purchase-orders", "POST", input, () =>
      createPurchaseOrder(input)
    ),

  transitionPurchaseOrder: (id: string, status: PurchaseStatus) =>
    apiSend<PurchaseOrder>(
      `/api/purchase-orders/${encodeURIComponent(id)}/transition`,
      "POST",
      { status },
      () => {
        const order = transitionPurchaseOrder(id, status);
        if (!order) throw new ApiError(`采购单不存在: ${id}`, 404);
        return order;
      }
    ),

  /* ---------------- 货源采集 ----------------
   * 这一域全部走 noOfflineSourcing：数据只存在于服务端 SQLite，浏览器端没有
   * 等价实现。接口不可达时如实报错，不伪造数据。详见 noOfflineSourcing 的注释。
   */
  listSourcingOffers: (query: SourcingQuery) =>
    apiGet<Paginated<SourcingOfferSummary>>(
      `/api/sourcing/offers${qs(query)}`,
      noOfflineSourcing
    ),

  getSourcingOffer: (id: string) =>
    apiGet<SourcingOfferDetail>(
      `/api/sourcing/offers/${encodeURIComponent(id)}`,
      noOfflineSourcing
    ),

  getSourcingStats: () =>
    apiGet<SourcingStats>("/api/sourcing/stats", noOfflineSourcing),

  /** 重跑图片转存。返回被重置为 pending 的图片数 */
  reingestSourcingImages: (id: string) =>
    apiSend<{ ok: boolean; resetImages: number }>(
      `/api/sourcing/offers/${encodeURIComponent(id)}/reingest`,
      "POST",
      undefined,
      noOfflineSourcing
    ),

  deleteSourcingOffer: (id: string) =>
    apiSend<{ ok: boolean }>(
      `/api/sourcing/offers/${encodeURIComponent(id)}`,
      "DELETE",
      undefined,
      noOfflineSourcing
    ),

  batchDeleteSourcingOffers: (ids: string[]) =>
    apiSend<{ affected: number }>(
      "/api/sourcing/offers/batch-delete",
      "POST",
      { ids },
      noOfflineSourcing
    ),

  /* ---------------- 竞品分析 ----------------
   * 与采集域同理：数据只在服务端 SQLite，全部走 noOfflineCompetitor 不兜底。
   */
  listCompetitorProducts: (query: CompetitorQuery) =>
    apiGet<Paginated<CompetitorProductSummary>>(
      `/api/competitor/products${qs(query)}`,
      noOfflineCompetitor
    ),

  getCompetitorProduct: (shopId: string, itemId: string) =>
    apiGet<CompetitorProductDetail>(
      `/api/competitor/products/${encodeURIComponent(shopId)}/${encodeURIComponent(itemId)}`,
      noOfflineCompetitor
    ),
};

/** 仓库选项，供筛选下拉复用 */
export const WAREHOUSE_OPTIONS: { value: WarehouseCode; label: string }[] = [
  { value: "cn_main", label: "国内主仓" },
  { value: "us_west", label: "美西海外仓" },
  { value: "de_central", label: "德国海外仓" },
];
