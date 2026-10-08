/**
 * 共享写入层 —— 所有业务变更的唯一实现。
 *
 * 服务端包成 POST/PUT/DELETE 接口；前端在接口不可达时直接调用同一批函数，
 * 因此离线兜底不是「假装成功」，而是真的改了同一份内存状态。
 *
 * 约定：校验失败抛 Error（服务端映射为 400），找不到目标返回 undefined（映射为 404）。
 */
import type {
  InventoryRecord,
  Product,
  ProductAttribute,
  ProductChannel,
  ProductStatus,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseStatus,
  Sku,
  StockMovement,
  WarehouseCode,
} from "../src/types";
import { CHANNEL_CODES, OPERATORS, PURCHASE_TRANSITIONS } from "../src/lib/labels";
import { db, refreshDerived } from "./db";

const nowIso = () => new Date().toISOString();

const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/** 取一组编号里最大的数字后缀 + 1，格式化为固定宽度 */
function nextSeq(existing: string[], prefix: string, width: number): string {
  const max = existing.reduce((acc, id) => {
    const n = Number(id.slice(prefix.length));
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

const pickOperator = (explicit?: string) =>
  explicit || OPERATORS[Math.floor(Math.random() * OPERATORS.length)];

/* ------------------------------------------------------------------ *
 * 商品
 * ------------------------------------------------------------------ */

export interface SkuInput {
  id?: string;
  specValues: Record<string, string>;
  barcode?: string;
  price: number;
  costPrice: number;
  weightGram: number;
  safetyStock: number;
}

export interface ProductInput {
  title: string;
  titleEn: string;
  categoryId: string;
  brand: string;
  status: ProductStatus;
  attributes?: ProductAttribute[];
  tags?: string[];
  channels?: ProductChannel[];
  skus: SkuInput[];
}

function validateProductInput(input: ProductInput): void {
  if (!input.title?.trim()) throw new Error("商品标题不能为空");
  if (!input.titleEn?.trim()) throw new Error("英文标题不能为空");
  if (!input.categoryId) throw new Error("必须选择类目");
  if (!db.categories.some((c) => c.id === input.categoryId)) {
    throw new Error(`类目不存在: ${input.categoryId}`);
  }
  if (!input.skus?.length) throw new Error("至少需要一个 SKU");
  for (const sku of input.skus) {
    if (!Object.values(sku.specValues).some((v) => v?.trim())) {
      throw new Error("每个 SKU 都必须填写规格值");
    }
    if (!(sku.price > 0)) throw new Error("售价必须大于 0");
    if (!(sku.costPrice >= 0)) throw new Error("成本价不能为负");
  }
}

function normalizeChannels(
  input: ProductInput,
  fallback: ProductChannel[]
): ProductChannel[] {
  if (!input.channels?.length) return fallback;
  return CHANNEL_CODES.map(
    (code) => input.channels!.find((c) => c.code === code) ?? { code, status: "not_listed" as const }
  );
}

function buildSkus(spu: string, skuInputs: SkuInput[]): Sku[] {
  return skuInputs.map((s, i) => {
    const skuCode = `${spu}-${i + 1}`;
    return {
      id: skuCode,
      skuCode,
      productId: spu,
      specValues: s.specValues,
      barcode: s.barcode?.trim() || `69${String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999))}`,
      price: s.price,
      costPrice: s.costPrice,
      weightGram: s.weightGram,
      image: `https://picsum.photos/seed/${skuCode}/200/200`,
      stock: 0,
      lockedStock: 0,
      safetyStock: s.safetyStock,
    };
  });
}

/** 新 SKU 在目的仓建立 0 库存记录，使其立刻出现在库存列表里 */
function seedInventoryFor(product: Product, warehouse: WarehouseCode = "cn_main"): void {
  for (const sku of product.skus) {
    db.inventory.push({
      id: `${sku.skuCode}@${warehouse}`,
      skuId: sku.id,
      skuCode: sku.skuCode,
      productId: product.id,
      productTitle: product.title,
      specText: Object.values(sku.specValues).join(" / "),
      image: sku.image ?? product.mainImage,
      warehouse,
      onHand: 0,
      locked: 0,
      available: 0,
      safetyStock: sku.safetyStock,
      health: "out",
      lastInboundAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
}

export function createProduct(input: ProductInput): Product {
  validateProductInput(input);

  const spu = nextSeq(
    db.products.map((p) => p.spu),
    "SPU-",
    5
  );
  const skus = buildSkus(spu, input.skus);

  const product: Product = {
    id: spu,
    spu,
    title: input.title.trim(),
    titleEn: input.titleEn.trim(),
    categoryId: input.categoryId,
    brand: input.brand?.trim() || "自有品牌",
    mainImage: `https://picsum.photos/seed/${spu}/400/400`,
    status: input.status,
    attributes: input.attributes ?? [],
    tags: input.tags ?? [],
    channels: normalizeChannels(
      input,
      CHANNEL_CODES.map((code) => ({ code, status: "not_listed" as const }))
    ),
    skus,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    operator: pickOperator(),
  };

  db.products.unshift(product);
  seedInventoryFor(product);
  refreshDerived();
  return product;
}

export function updateProduct(id: string, input: ProductInput): Product | undefined {
  validateProductInput(input);

  const product = db.products.find((p) => p.id === id || p.spu === id);
  if (!product) return undefined;

  const previousSkuIds = new Set(product.skus.map((s) => s.id));
  const skus = buildSkus(product.spu, input.skus);

  // 保留下来的 SKU 要继承既有库存，避免编辑商品把库存清零
  for (const sku of skus) {
    const old = product.skus.find((s) => s.skuCode === sku.skuCode);
    if (old) {
      sku.stock = old.stock;
      sku.lockedStock = old.lockedStock;
    }
  }

  product.title = input.title.trim();
  product.titleEn = input.titleEn.trim();
  product.categoryId = input.categoryId;
  product.brand = input.brand?.trim() || product.brand;
  product.status = input.status;
  product.attributes = input.attributes ?? [];
  product.tags = input.tags ?? [];
  product.channels = normalizeChannels(input, product.channels);
  product.skus = skus;
  product.updatedAt = nowIso();

  // 清掉被删掉的 SKU 残留的库存记录
  const keptSkuIds = new Set(skus.map((s) => s.id));
  db.inventory = db.inventory.filter(
    (r) => !previousSkuIds.has(r.skuId) || keptSkuIds.has(r.skuId)
  );

  // 同步库存记录上的冗余展示字段
  for (const rec of db.inventory) {
    if (rec.productId !== product.id) continue;
    rec.productTitle = product.title;
    const sku = skus.find((s) => s.id === rec.skuId);
    if (sku) rec.specText = Object.values(sku.specValues).join(" / ");
  }

  refreshDerived();
  return product;
}

export function deleteProduct(id: string): boolean {
  const idx = db.products.findIndex((p) => p.id === id || p.spu === id);
  if (idx < 0) return false;

  const [removed] = db.products.splice(idx, 1);
  const skuIds = new Set(removed.skus.map((s) => s.id));
  db.inventory = db.inventory.filter((r) => !skuIds.has(r.skuId));
  refreshDerived();
  return true;
}

/** 批量上下架 */
export function batchUpdateProductStatus(ids: string[], status: ProductStatus): number {
  let changed = 0;
  for (const product of db.products) {
    if (!ids.includes(product.id)) continue;
    product.status = status;
    product.updatedAt = nowIso();
    changed++;
  }
  return changed;
}

export function batchDeleteProducts(ids: string[]): number {
  let changed = 0;
  for (const id of ids) {
    if (deleteProduct(id)) changed++;
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * 库存
 * ------------------------------------------------------------------ */

export interface AdjustStockInput {
  inventoryId: string;
  /** 调整后的在手量 */
  onHand: number;
  reason: string;
  operator?: string;
}

export function adjustStock(input: AdjustStockInput): {
  record: InventoryRecord;
  movement: StockMovement;
} {
  const record = db.inventory.find((r) => r.id === input.inventoryId);
  if (!record) throw new Error(`库存记录不存在: ${input.inventoryId}`);

  const target = Math.trunc(input.onHand);
  if (!Number.isFinite(target) || target < 0) throw new Error("在手库存不能为负数");
  if (target < record.locked) {
    throw new Error(`在手库存不能低于已占用数量 ${record.locked}`);
  }
  if (!input.reason?.trim()) throw new Error("必须填写调整原因");

  const before = record.onHand;
  const delta = target - before;
  if (delta === 0) throw new Error("调整后的数量与原数量相同，无需变更");

  const movement: StockMovement = {
    id: nextSeq(
      db.movements.map((m) => m.id),
      "MV-",
      4
    ),
    skuCode: record.skuCode,
    productTitle: record.productTitle,
    specText: record.specText,
    warehouse: record.warehouse,
    type: "adjust",
    quantity: delta,
    beforeQty: before,
    afterQty: target,
    refNo: `ADJ-${stamp()}-${String(db.movements.filter((m) => m.type === "adjust").length + 1).padStart(4, "0")}`,
    operator: pickOperator(input.operator),
    remark: input.reason.trim(),
    createdAt: nowIso(),
  };

  record.onHand = target;
  record.updatedAt = nowIso();
  db.movements.unshift(movement);
  refreshDerived();

  return { record, movement };
}

/* ------------------------------------------------------------------ *
 * 采购
 * ------------------------------------------------------------------ */

export interface PurchaseOrderInput {
  supplier: string;
  warehouse: WarehouseCode;
  expectedAt: string;
  remark?: string;
  operator?: string;
  items: { skuId: string; quantity: number; unitCost: number }[];
}

export function createPurchaseOrder(input: PurchaseOrderInput): PurchaseOrder {
  if (!input.supplier?.trim()) throw new Error("必须选择供应商");
  if (!input.warehouse) throw new Error("必须选择目的仓");
  if (!input.items?.length) throw new Error("至少需要一行采购明细");

  const items: PurchaseOrderItem[] = [];
  input.items.forEach((line, i) => {
    const quantity = Math.trunc(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`第 ${i + 1} 行采购数量必须大于 0`);
    }
    if (!(line.unitCost >= 0)) throw new Error(`第 ${i + 1} 行单价不能为负`);

    const found = db.products
      .flatMap((p) => p.skus.map((s) => ({ sku: s, product: p })))
      .find((entry) => entry.sku.id === line.skuId);
    if (!found) throw new Error(`SKU 不存在: ${line.skuId}`);

    items.push({
      id: "",
      skuId: found.sku.id,
      skuCode: found.sku.skuCode,
      productTitle: found.product.title,
      specText: Object.values(found.sku.specValues).join(" / "),
      quantity,
      receivedQty: 0,
      unitCost: line.unitCost,
      amount: quantity * line.unitCost,
    });
  });

  const today = db.purchaseOrders.filter((po) => po.poNo.includes(stamp()));
  const poNo = `PO-${stamp()}-${String(today.length + 1).padStart(3, "0")}`;
  items.forEach((item, i) => (item.id = `${poNo}-${i + 1}`));

  const order: PurchaseOrder = {
    id: poNo,
    poNo,
    supplier: input.supplier.trim(),
    warehouse: input.warehouse,
    status: "draft",
    items,
    totalAmount: items.reduce((s, i) => s + i.amount, 0),
    totalQuantity: items.reduce((s, i) => s + i.quantity, 0),
    currency: "CNY",
    expectedAt: input.expectedAt || nowIso(),
    operator: pickOperator(input.operator),
    remark: input.remark?.trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  db.purchaseOrders.unshift(order);
  return order;
}

/**
 * 采购单状态流转。
 * 流转到 received 时会真实入库：增加目的仓库存并写入采购入库流水。
 */
export function transitionPurchaseOrder(
  id: string,
  next: PurchaseStatus,
  operator?: string
): PurchaseOrder | undefined {
  const order = db.purchaseOrders.find((po) => po.id === id || po.poNo === id);
  if (!order) return undefined;

  if (!PURCHASE_TRANSITIONS[order.status].includes(next)) {
    throw new Error(`采购单当前状态为「${order.status}」，不能流转到「${next}」`);
  }

  if (next === "received") {
    const op = pickOperator(operator);
    for (const item of order.items) {
      const remaining = item.quantity - item.receivedQty;
      if (remaining <= 0) continue;

      let rec = db.inventory.find(
        (r) => r.skuId === item.skuId && r.warehouse === order.warehouse
      );
      if (!rec) {
        const product = db.products.find((p) =>
          p.skus.some((s) => s.id === item.skuId)
        );
        const sku = product?.skus.find((s) => s.id === item.skuId);
        rec = {
          id: `${item.skuCode}@${order.warehouse}`,
          skuId: item.skuId,
          skuCode: item.skuCode,
          productId: product?.id ?? "—",
          productTitle: item.productTitle,
          specText: item.specText,
          image: sku?.image ?? product?.mainImage ?? "",
          warehouse: order.warehouse,
          onHand: 0,
          locked: 0,
          available: 0,
          safetyStock: sku?.safetyStock ?? 30,
          health: "out",
          lastInboundAt: nowIso(),
          updatedAt: nowIso(),
        };
        db.inventory.push(rec);
      }

      const before = rec.onHand;
      rec.onHand = before + remaining;
      rec.lastInboundAt = nowIso();
      rec.updatedAt = nowIso();

      db.movements.unshift({
        id: nextSeq(
          db.movements.map((m) => m.id),
          "MV-",
          4
        ),
        skuCode: item.skuCode,
        productTitle: item.productTitle,
        specText: item.specText,
        warehouse: order.warehouse,
        type: "inbound",
        quantity: remaining,
        beforeQty: before,
        afterQty: before + remaining,
        refNo: order.poNo,
        operator: op,
        remark: "采购单确认入库",
        createdAt: nowIso(),
      });

      item.receivedQty = item.quantity;
    }
  }

  order.status = next;
  order.updatedAt = nowIso();
  refreshDerived();
  return order;
}
