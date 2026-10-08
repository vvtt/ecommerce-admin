/**
 * 竞品域数据访问层。
 *
 * 与采集域同样的分工：SQL 全部收敛在本文件，ingest.ts 只负责解析与落盘。
 * 所有写操作都围绕「文件是源头，DB 是索引」—— upsert 幂等、评论合并去重，
 * 就算同一条上报重放多次也不会产生脏数据。
 */
import { getDb } from "./client";
import type { PdpRecord } from "./ingest";
import type { CompetitorProductDetail, CompetitorProductSummary, CompetitorQuery, CompetitorReview, Paginated } from "../../src/types";

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/**
 * 商品详情写入/更新。
 *
 * ON CONFLICT 的更新列表里故意没有 captured_at —— 保留首次采集时间，
 * 重采不覆盖；最新时间由 updated_at 承载。评论字段（reviews_json /
 * review_count）同样不在更新列表，pdp 到达不会抹掉已合并的评论。
 *
 * @returns 是否成功写入（缺 item_id 时拒绝，与 Python 版行为一致）
 */
export function upsertProduct(record: PdpRecord): boolean {
  const itemId = Number(record.item_id);
  const shopId = Number(record.shop_id);
  if (!Number.isFinite(itemId) || itemId <= 0) return false;

  const db = getDb();
  const ratingStar = (record.rating_summary as { rating_star?: unknown }).rating_star;
  db.prepare(
    `
    INSERT INTO products (
        shop_id, item_id, name, cat_id, category_path, fe_category_path,
        attributes_json, description_text, url,
        price, price_min, price_max, currency,
        rating_star, tier_variations_json, models_json, model_count,
        reviews_json, review_count,
        shop_name, shop_location, is_cross_border, item_status,
        listed_at, captured_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, item_id) DO UPDATE SET
        name=excluded.name,
        cat_id=excluded.cat_id,
        category_path=excluded.category_path,
        fe_category_path=excluded.fe_category_path,
        attributes_json=excluded.attributes_json,
        description_text=excluded.description_text,
        url=COALESCE(NULLIF(excluded.url,''), products.url),
        price=excluded.price, price_min=excluded.price_min,
        price_max=excluded.price_max, currency=excluded.currency,
        rating_star=excluded.rating_star,
        tier_variations_json=excluded.tier_variations_json,
        models_json=excluded.models_json,
        model_count=excluded.model_count,
        shop_name=excluded.shop_name,
        shop_location=excluded.shop_location,
        is_cross_border=excluded.is_cross_border,
        item_status=excluded.item_status,
        listed_at=excluded.listed_at,
        updated_at=excluded.updated_at
    `,
  ).run(
    shopId,
    itemId,
    record.name,
    record.category.cat_id ?? null,
    record.category.path,
    record.category.fe_path,
    JSON.stringify(record.attributes),
    record.description_text,
    record.source_url,
    record.price.price ?? null,
    record.price.price_min ?? null,
    record.price.price_max ?? null,
    record.price.currency,
    typeof ratingStar === "number" ? ratingStar : null,
    JSON.stringify(record.tier_variations),
    JSON.stringify(record.models),
    record.models.length,
    record.shop_name,
    record.shop_location ?? null,
    typeof record.cb_option === "number" ? record.cb_option : null,
    record.item_status,
    record.listed_at ?? null,
    record.captured_at,
    nowStamp(),
  );
  return true;
}
/**
 * 新评论批次合并进 reviews_json（按 _key 去重，按 ctime 倒序）。
 * 商品详情还没到时先建占位行 —— 插件可能先滚评论再打开详情页。
 */
export function mergeReviews(
  shopId: string,
  itemId: string,
  rows: Record<string, unknown>[]
): { total: number; added: number } {
  const shop = Number(shopId);
  const item = Number(itemId);
  if (!Number.isFinite(shop) || !Number.isFinite(item)) return { total: 0, added: 0 };

  const db = getDb();
  const existingRow = db
    .prepare("SELECT reviews_json FROM products WHERE shop_id = ? AND item_id = ?")
    .get(shop, item) as { reviews_json: string | null } | undefined;

  let existing: Record<string, unknown>[] = [];
  if (!existingRow) {
    db.prepare(
      "INSERT INTO products (shop_id, item_id, reviews_json, review_count, updated_at) VALUES (?, ?, '[]', 0, ?)",
    ).run(shop, item, nowStamp());
  } else {
    try {
      existing = JSON.parse(existingRow.reviews_json ?? "[]") as Record<string, unknown>[];
    } catch {
      existing = [];
    }
  }

  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of existing) {
    const k = r["_key"] as string | undefined;
    if (k) byKey.set(k, r);
  }
  let added = 0;
  for (const r of rows) {
    const k = r["_key"] as string | undefined;
    // 没有去重键的评论直接丢弃 —— 无法幂等，宁缺毋滥
    if (!k || byKey.has(k)) continue;
    byKey.set(k, r);
    added += 1;
  }

  const merged = [...byKey.values()].sort(
    (a, b) => (Number(b["ctime"]) || 0) - (Number(a["ctime"]) || 0),
  );
  db.prepare("UPDATE products SET reviews_json = ?, review_count = ?, updated_at = ? WHERE shop_id = ? AND item_id = ?").run(
    JSON.stringify(merged),
    merged.length,
    nowStamp(),
    shop,
    item,
  );
  return { total: merged.length, added };
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

interface ProductRow {
  shop_id: number;
  item_id: number;
  name: string | null;
  cat_id: number | null;
  category_path: string | null;
  fe_category_path: string | null;
  attributes_json: string | null;
  description_text: string | null;
  url: string | null;
  price: number | null;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  rating_star: number | null;
  tier_variations_json: string | null;
  models_json: string | null;
  model_count: number | null;
  reviews_json: string | null;
  review_count: number | null;
  shop_name: string | null;
  shop_location: string | null;
  is_cross_border: number | null;
  item_status: string | null;
  listed_at: number | null;
  captured_at: string | null;
  updated_at: string | null;
}

const SUMMARY_COLUMNS = `
    shop_id, item_id, name, category_path, fe_category_path,
    price, price_min, price_max, currency, url,
    rating_star, model_count, review_count,
    shop_name, is_cross_border, item_status, captured_at, updated_at`;

function parseJsonArray<T>(text: string | null | undefined): T[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * reviews_json 里行的存储形状（ingest.ts 写入时的字段名，snake_case 沿袭
 * Python 版落盘格式）。缺字段容忍 —— 手工编辑过的落盘文件也要能读。
 */
interface StoredReview {
  _key?: string;
  author_username?: string;
  author_name?: string;
  rating_star?: number;
  comment?: string;
  comment_tag?: string | null;
  ctime?: number;
  captured_at?: string;
}

const toReview = (r: StoredReview): CompetitorReview => ({
  _key: r._key ?? "",
  authorUsername: r.author_username ?? "",
  authorName: r.author_name || undefined,
  ratingStar: r.rating_star ?? undefined,
  comment: r.comment ?? "",
  commentTag: r.comment_tag ?? undefined,
  ctime: r.ctime ?? undefined,
  capturedAt: r.captured_at ?? "",
});

function toSummary(row: ProductRow): CompetitorProductSummary {
  return {
    shopId: String(row.shop_id),
    itemId: String(row.item_id),
    name: row.name ?? "",
    categoryPath: row.category_path ?? "",
    feCategoryPath: row.fe_category_path ?? "",
    price: row.price ?? undefined,
    priceMin: row.price_min ?? undefined,
    priceMax: row.price_max ?? undefined,
    currency: row.currency ?? "",
    ratingStar: row.rating_star ?? undefined,
    modelCount: row.model_count ?? undefined,
    reviewCount: row.review_count ?? 0,
    shopName: row.shop_name ?? "",
    isCrossBorder: row.is_cross_border ?? undefined,
    itemStatus: row.item_status ?? "",
    url: row.url ?? "",
    capturedAt: row.captured_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

/**
 * 分页查询竞品商品。
 *
 * 按需求只做轻字段列表（商品id/名称/分类/价格 + 少量辅助列），评论与
 * SKU 大字段只在详情接口返回，列表查询不拖 JSON 大字段。
 */
export function queryProducts(query: CompetitorQuery): Paginated<CompetitorProductSummary> {
  const db = getDb();
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 10)));

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.q) {
    // 按需求只做商品名模糊匹配（分类检索是另一个需求，等真出现再加字段）
    where.push("name LIKE ?");
    params.push(`%${query.q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM products ${whereSql}`).get(...params) as { n: number };
  const rows = db.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM products ${whereSql}
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize) as unknown as ProductRow[];

  return {
    items: rows.map(toSummary),
    total: Number(totalRow?.n ?? 0),
    page,
    pageSize,
  };
}

/** 单条完整详情（导出 txt 的数据源）。找不到返回 null */
export function getProduct(shopId: string, itemId: string): CompetitorProductDetail | null {
  const db = getDb();
  const shop = Number(shopId);
  const item = Number(itemId);
  if (!Number.isFinite(shop) || !Number.isFinite(item)) return null;

  const row = db.prepare(
    `SELECT * FROM products WHERE shop_id = ? AND item_id = ?`,
  ).get(shop, item) as unknown as ProductRow | undefined;
  if (!row) return null;

  return {
    ...toSummary(row),
    catId: row.cat_id ?? undefined,
    descriptionText: row.description_text ?? "",
    attributes: parseJsonArray<{ name: string; value: string }>(row.attributes_json),
    tierVariations: parseJsonArray<{ name: string; options: string[] }>(row.tier_variations_json),
    models: parseJsonArray<{ modelid?: number; name: string; price?: number; normal_stock?: number }>(row.models_json),
    shopLocation: row.shop_location ?? "",
    listedAt: row.listed_at ?? undefined,
    reviews: parseJsonArray<StoredReview>(row.reviews_json).map(toReview),
  };
}
