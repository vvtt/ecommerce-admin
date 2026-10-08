/**
 * 采集域读写 —— 所有 SQL 的唯一出入口。
 *
 * 上层（routes/sourcing.ts）只调本文件的函数，不写 SQL；将来换驱动
 * （better-sqlite3 / Postgres）只改 `client.ts` 与本文件内部，上层无感。
 *
 * 与 shared/mutations.ts 相同的契约：校验失败 throw Error（路由映射 400），
 * 找不到目标返回 undefined / false（路由映射 404）。
 */
import { createHash } from "node:crypto";
import type {
  CollectedOffer,
  ImageKind,
  ImageStatus,
  Paginated,
  SourcingImage,
  SourcingOfferDetail,
  SourcingOfferSummary,
  SourcingQuery,
  SourcingStats,
} from "../../src/types";
import { getDb, withTransaction } from "./client";
import type {
  AttributeRow,
  ImageRow,
  OfferRow,
  PriceTierRow,
  SkuRow,
  SpecDimensionRow,
} from "./schema";

const nowIso = () => new Date().toISOString();

/** 短哈希，用于生成图片 id / 文件名。同 URL 必然同哈希 → 天然去重 */
export function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/**
 * offer 主键。用 (platform, offerId) 派生而非随机 UUID：
 * 同一商品重复采集必然命中同一 id，详情页 URL 稳定，也便于排查。
 */
function makeOfferId(platform: string, offerId: string): string {
  const safe = offerId.replace(/[^A-Za-z0-9_-]/g, "");
  return `so_${platform}_${safe}`;
}

/**
 * 图片 id = offer + 用途 + 源 URL 的哈希。
 *
 * 必须带上 offerId：同一张图完全可能出现在多条货源上（同供应商共用详情图、
 * 同一 listing 的不同 offer），若只用 (kind, url) 派生，第二条货源入库时会
 * 撞主键。文件名的去重是另一回事，见 images.ts —— 那边只用 URL 哈希，
 * 让磁盘上的同一张图只存一份。
 */
const makeImageId = (offerId: string, kind: string, sourceUrl: string) =>
  `img_${shortHash(`${offerId}|${kind}|${sourceUrl}`)}`;

/**
 * 宽松 JSON 解析。
 *
 * raw_json 与 *_json 列都是我们自己写进去的，理论上不会坏；但一旦坏了，
 * 整条记录读不出来会连累列表页。所以解析失败退化成默认值，不抛。
 */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * 价格区间 = 阶梯价与 SKU 价的**并集**，不是二选一。
 *
 * 两者是不同维度（数量档 vs 规格变体），但对扫列表的人来说，
 * 「价格区间」要回答的是「我可能付多少」。只看阶梯价会漏掉高配变体的
 * 价格（如降噪版 36 vs 标准版最低 22.4），把区间显示得比实际窄。
 */
function derivePriceRange(
  tiers: { price: number }[],
  skus: { price?: number }[],
): { min?: number; max?: number } {
  const prices = [
    ...tiers.map((t) => t.price),
    ...skus.map((s) => s.price).filter((p): p is number => typeof p === "number"),
  ].filter((p) => Number.isFinite(p));

  if (!prices.length) return {};
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/* ------------------------------------------------------------------ *
 * 行 → 对外结构
 * ------------------------------------------------------------------ */

/** 列表行附带的派生列，见 LIST_SELECT 里的子查询 */
interface OfferListRow extends OfferRow {
  sku_count: number;
  image_ok_count: number;
  image_fail_count: number;
  thumbnail: string | null;
}

function toSummary(row: OfferListRow): SourcingOfferSummary {
  return {
    id: row.id,
    platform: row.platform as SourcingOfferSummary["platform"],
    offerId: row.offer_id,
    url: row.url,
    title: row.title,
    supplierName: row.supplier_name ?? undefined,
    supplierLocation: row.supplier_location ?? undefined,
    moq: row.moq ?? undefined,
    priceMin: row.price_min ?? undefined,
    priceMax: row.price_max ?? undefined,
    skuCount: row.sku_count,
    thumbnail: row.thumbnail ?? "",
    imageStatus: row.image_status as ImageStatus,
    imageOkCount: row.image_ok_count,
    imageFailCount: row.image_fail_count,
    extractorVersion: row.extractor_version,
    collectedAt: row.collected_at,
    updatedAt: row.updated_at,
  };
}

function toImage(row: ImageRow): SourcingImage {
  return {
    id: row.id,
    kind: row.kind as ImageKind,
    sourceUrl: row.source_url,
    localPath: row.local_path,
    status: row.status as ImageStatus,
    error: row.error ?? undefined,
    bytes: row.bytes ?? undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 归一化后的待写入图片 */
interface ImageDraft {
  id: string;
  kind: ImageKind;
  sourceUrl: string;
  position: number;
}

/**
 * 把上报载荷摊平成图片清单。
 *
 * SKU 图与主图常有重叠（同一个 URL），这里按 (kind, url) 去重 ——
 * 不同 kind 之间不去重，因为主图墙与 SKU 明细需要各自完整。
 */
function buildImageDrafts(offerId: string, payload: CollectedOffer): ImageDraft[] {
  const drafts: ImageDraft[] = [];
  const push = (kind: ImageKind, url: string, position: number) => {
    const trimmed = url?.trim();
    if (!trimmed) return;
    drafts.push({ id: makeImageId(offerId, kind, trimmed), kind, sourceUrl: trimmed, position });
  };

  payload.images?.main?.forEach((url, i) => push("main", url, i));
  payload.images?.detail?.forEach((url, i) => push("detail", url, i));
  payload.skus?.forEach((sku, i) => {
    if (sku.imageUrl) push("sku", sku.imageUrl, i);
  });

  // 同 kind 同 URL 只留一条（保留首次出现的位置）
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = `${d.kind}|${d.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 同步图片清单，保留已成功的转存结果。
 *
 * 重复采集时若把图片行全删重建，已下载好的图会被判定为 pending 而重新下载，
 * 既浪费带宽又让状态回退。所以按 (kind, sourceUrl) 对账：
 *  - 已存在且转存成功 → 只更新 position，保留 local_path / bytes
 *  - 已存在但失败或未完成 → 重置为 pending，让它重试
 *  - 不存在 → 新增 pending
 *  - 本次未出现 → 删除记录
 *
 * 已知小缺口：被删记录对应的磁盘文件不会一并清理，会留下孤儿文件。
 * 文件名是内容哈希，不影响正确性，留待后续做一次清理任务。
 */
function syncImages(offerId: string, drafts: ImageDraft[]): void {
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT id, offer_id, kind, source_url, local_path, status, error, bytes, position FROM sourcing_images WHERE offer_id = ?",
    )
    .all(offerId) as unknown as ImageRow[];

  const byKey = new Map(existing.map((r) => [`${r.kind}|${r.source_url}`, r]));
  const kept = new Set<string>();

  const insert = db.prepare(
    `INSERT INTO sourcing_images (id, offer_id, kind, source_url, local_path, status, error, bytes, position)
     VALUES (?, ?, ?, ?, '', 'pending', NULL, NULL, ?)`,
  );
  const bumpPosition = db.prepare("UPDATE sourcing_images SET position = ? WHERE id = ?");
  const resetToPending = db.prepare(
    "UPDATE sourcing_images SET status = 'pending', error = NULL, position = ? WHERE id = ?",
  );
  const remove = db.prepare("DELETE FROM sourcing_images WHERE id = ?");

  for (const draft of drafts) {
    const key = `${draft.kind}|${draft.sourceUrl}`;
    const prior = byKey.get(key);
    kept.add(key);

    if (!prior) {
      insert.run(draft.id, offerId, draft.kind, draft.sourceUrl, draft.position);
    } else if (prior.local_path) {
      // 已转存成功：保住结果，只把顺序对齐最新的上报
      bumpPosition.run(draft.position, prior.id);
    } else {
      // 上次失败或还没跑完：重置，等这一轮重新下载
      resetToPending.run(draft.position, prior.id);
    }
  }

  for (const [key, row] of byKey) {
    if (!kept.has(key)) remove.run(row.id);
  }
}

/**
 * 依据图片行重算主表的转存状态与成功/失败计数。
 *
 * 规则：任一 pending → pending（还在跑，以它为准）；
 * 否则全成功 → ok；全失败 → failed；混合 → partial。
 * 零图片视为 ok —— 否则「没有图的货源」会永远停在 pending。
 */
function recomputeImageStatus(offerId: string): void {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS fail_count,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
       FROM sourcing_images WHERE offer_id = ?`,
    )
    .get(offerId) as unknown as {
    total: number;
    ok_count: number | null;
    fail_count: number | null;
    pending_count: number | null;
  };

  const total = counts?.total ?? 0;
  const pending = counts?.pending_count ?? 0;
  const okCount = counts?.ok_count ?? 0;
  const failCount = counts?.fail_count ?? 0;

  let status: ImageStatus;
  if (pending > 0) status = "pending";
  else if (total === 0 || failCount === 0) status = "ok";
  else if (okCount === 0) status = "failed";
  else status = "partial";

  db.prepare("UPDATE sourcing_offers SET image_status = ? WHERE id = ?").run(status, offerId);
}

/** 记录一次采集动作。货源删除后这些日志仍保留 */
function logCollect(offerId: string, action: string, source: string): void {
  getDb()
    .prepare("INSERT INTO sourcing_collect_logs (offer_id, action, source, created_at) VALUES (?, ?, ?, ?)")
    .run(offerId, action, source, nowIso());
}

export interface SaveOfferResult {
  id: string;
  action: "created" | "updated";
}

/**
 * 上报入库。按 (platform, offerId) upsert，重复采集不会产生新行。
 *
 * 整体在一个事务里：主表 + 4 张明细表 + 图片清单要么全成要么全不成，
 * 避免出现「主表更新了但 SKU 还是上一版」这种半截状态。
 *
 * collected_at 语义 = **最近一次采集时间**（重复采集会刷新）。
 * 首次采集时间不去主表里找，而是保留在 sourcing_collect_logs 中。
 */
export function saveOffer(payload: CollectedOffer, source = "extension"): SaveOfferResult {
  const db = getDb();

  const platform = payload.platform?.trim();
  const offerId = payload.offerId?.trim();
  if (!platform) throw new Error("platform 不能为空");
  if (!offerId) throw new Error("offerId 不能为空");
  if (!payload.url?.trim()) throw new Error("url 不能为空");

  const title = payload.title?.trim() || `1688 货源 ${offerId}`;
  const tiers = Array.isArray(payload.priceLadder) ? payload.priceLadder : [];
  const skus = Array.isArray(payload.skus) ? payload.skus : [];
  const attributes = Array.isArray(payload.attributes) ? payload.attributes : [];
  const dimensions = Array.isArray(payload.specDimensions) ? payload.specDimensions : [];
  const { min, max } = derivePriceRange(tiers, skus);

  return withTransaction(() => {
    const existing = db
      .prepare("SELECT id FROM sourcing_offers WHERE platform = ? AND offer_id = ?")
      .get(platform, offerId) as unknown as { id: string } | undefined;

    const id = existing?.id ?? makeOfferId(platform, offerId);
    const action: "created" | "updated" = existing ? "updated" : "created";
    const timestamp = nowIso();
    const supplier = payload.supplier ?? {};

    db.prepare(
      `INSERT INTO sourcing_offers (
         id, platform, offer_id, url, title,
         supplier_name, supplier_login_id, supplier_location, supplier_shop_url,
         moq, price_min, price_max, weight_gram, dimensions_json,
         raw_json, extractor_version, image_status, collected_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, offer_id) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         supplier_name = excluded.supplier_name,
         supplier_login_id = excluded.supplier_login_id,
         supplier_location = excluded.supplier_location,
         supplier_shop_url = excluded.supplier_shop_url,
         moq = excluded.moq,
         price_min = excluded.price_min,
         price_max = excluded.price_max,
         weight_gram = excluded.weight_gram,
         dimensions_json = excluded.dimensions_json,
         raw_json = excluded.raw_json,
         extractor_version = excluded.extractor_version,
         collected_at = excluded.collected_at,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      platform,
      offerId,
      payload.url.trim(),
      title,
      supplier.name ?? null,
      supplier.loginId ?? null,
      supplier.location ?? null,
      supplier.shopUrl ?? null,
      payload.moq ?? null,
      min ?? null,
      max ?? null,
      payload.weightGram ?? null,
      payload.dimensions ? JSON.stringify(payload.dimensions) : null,
      // raw_json 存的是**我们构造的 CollectedOffer 原始版本**，
      // 用于 1688 改版后离线重解析。绝不要把 window.context 整个 dump 进来 ——
      // 页面对象里含用户身份与站点内部 token，那是数据最小化原则禁止的。
      JSON.stringify(payload),
      payload.extractorVersion || "unknown",
      "pending",
      timestamp,
      timestamp,
    );

    // 明细整体重建。条数少（几十条），比逐条 diff 简单且不会漏改
    const wipe = [
      "DELETE FROM sourcing_price_tiers WHERE offer_id = ?",
      "DELETE FROM sourcing_spec_dimensions WHERE offer_id = ?",
      "DELETE FROM sourcing_skus WHERE offer_id = ?",
      "DELETE FROM sourcing_attributes WHERE offer_id = ?",
    ];
    for (const sql of wipe) db.prepare(sql).run(id);

    const insertTier = db.prepare(
      "INSERT INTO sourcing_price_tiers (offer_id, begin_amount, end_amount, price, position) VALUES (?, ?, ?, ?, ?)",
    );
    tiers.forEach((tier, i) => {
      insertTier.run(id, tier.beginAmount ?? 1, tier.endAmount ?? null, tier.price ?? 0, i);
    });

    const insertDim = db.prepare(
      "INSERT INTO sourcing_spec_dimensions (offer_id, name, values_json, position) VALUES (?, ?, ?, ?)",
    );
    dimensions.forEach((dim, i) => {
      insertDim.run(id, dim.name ?? "", JSON.stringify(dim.values ?? []), i);
    });

    const insertSku = db.prepare(
      "INSERT INTO sourcing_skus (offer_id, sku_code, spec_json, price, stock, image_url, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    skus.forEach((sku, i) => {
      insertSku.run(
        id,
        sku.skuId ?? `sku-${i + 1}`,
        JSON.stringify(sku.specValues ?? {}),
        sku.price ?? null,
        sku.stock ?? null,
        sku.imageUrl ?? null,
        i,
      );
    });

    const insertAttr = db.prepare(
      "INSERT INTO sourcing_attributes (offer_id, name, value, position) VALUES (?, ?, ?, ?)",
    );
    attributes.forEach((attr, i) => {
      insertAttr.run(id, attr.name ?? "", attr.value ?? "", i);
    });

    syncImages(id, buildImageDrafts(id, payload));
    recomputeImageStatus(id);
    logCollect(id, action, source);

    return { id, action };
  });
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/** ORDER BY 的列白名单 —— 排序字段来自 query string，绝不能直接拼进 SQL */
const SORT_COLUMNS: Record<NonNullable<SourcingQuery["sortBy"]>, string> = {
  collectedAt: "o.collected_at",
  priceMin: "o.price_min",
  moq: "o.moq",
  title: "o.title",
};

/**
 * 列表查询里反复用到的派生列。
 * 缩略图取「转存成功的第一张主图」，没有主图才退回任意一张成功的图；
 * `(i.kind <> 'main')` 对主图求值为 0，因此主图排在最前。
 */
const LIST_SELECT = `
  SELECT
    o.*,
    (SELECT COUNT(*) FROM sourcing_skus s WHERE s.offer_id = o.id) AS sku_count,
    (SELECT COUNT(*) FROM sourcing_images i WHERE i.offer_id = o.id AND i.status = 'ok') AS image_ok_count,
    (SELECT COUNT(*) FROM sourcing_images i WHERE i.offer_id = o.id AND i.status = 'failed') AS image_fail_count,
    (SELECT i.local_path FROM sourcing_images i
      WHERE i.offer_id = o.id AND i.status = 'ok' AND i.local_path <> ''
      ORDER BY (i.kind <> 'main'), i.position LIMIT 1) AS thumbnail
  FROM sourcing_offers o
`;

export function querySourcingOffers(query: SourcingQuery): Paginated<SourcingOfferSummary> {
  const db = getDb();

  const where: string[] = [];
  const params: (string | number)[] = [];

  const q = query.q?.trim();
  if (q) {
    where.push("(o.title LIKE ? OR o.offer_id LIKE ? OR IFNULL(o.supplier_name, '') LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (query.platform && query.platform !== "all") {
    where.push("o.platform = ?");
    params.push(query.platform);
  }
  if (query.imageStatus && query.imageStatus !== "all") {
    where.push("o.image_status = ?");
    params.push(query.imageStatus);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM sourcing_offers o ${whereSql}`).get(...params) as unknown as {
      n: number;
    }
  ).n;

  // 与 shared/queries.ts 的 paginate() 保持同一套默认值与钳制范围
  const size = Math.min(Math.max(Math.trunc(query.pageSize ?? 10) || 10, 1), 200);
  const current = Math.max(Math.trunc(query.page ?? 1) || 1, 1);
  const offset = (current - 1) * size;

  // 排序字段走白名单映射，方向只有 ASC/DESC 两种取值，无注入面。
  // NULLS LAST：没抓到价格的排在最后，而不是霸占榜首。末位补 id 保证翻页稳定。
  const column = SORT_COLUMNS[query.sortBy ?? "collectedAt"] ?? SORT_COLUMNS.collectedAt;
  const direction = query.sortDir === "asc" ? "ASC" : "DESC";

  const rows = db
    .prepare(
      `${LIST_SELECT} ${whereSql} ORDER BY ${column} ${direction} NULLS LAST, o.id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, size, offset) as unknown as OfferListRow[];

  return { items: rows.map(toSummary), total, page: current, pageSize: size };
}

/** 详情：主表 + 五张明细表 */
export function getSourcingOfferById(id: string): SourcingOfferDetail | undefined {
  const db = getDb();

  const row = db.prepare(`${LIST_SELECT} WHERE o.id = ?`).get(id) as unknown as
    | OfferListRow
    | undefined;
  if (!row) return undefined;

  const tiers = db
    .prepare(
      "SELECT begin_amount, end_amount, price FROM sourcing_price_tiers WHERE offer_id = ? ORDER BY position",
    )
    .all(id) as unknown as PriceTierRow[];

  const dims = db
    .prepare(
      "SELECT name, values_json FROM sourcing_spec_dimensions WHERE offer_id = ? ORDER BY position",
    )
    .all(id) as unknown as SpecDimensionRow[];

  const skus = db
    .prepare(
      "SELECT sku_code, spec_json, price, stock, image_url FROM sourcing_skus WHERE offer_id = ? ORDER BY position",
    )
    .all(id) as unknown as SkuRow[];

  const attrs = db
    .prepare("SELECT name, value FROM sourcing_attributes WHERE offer_id = ? ORDER BY position")
    .all(id) as unknown as AttributeRow[];

  const images = db
    .prepare(
      "SELECT id, offer_id, kind, source_url, local_path, status, error, bytes, position FROM sourcing_images WHERE offer_id = ? ORDER BY (kind <> 'main'), kind, position",
    )
    .all(id) as unknown as ImageRow[];

  return {
    ...toSummary(row),
    supplier: {
      name: row.supplier_name ?? undefined,
      loginId: row.supplier_login_id ?? undefined,
      location: row.supplier_location ?? undefined,
      shopUrl: row.supplier_shop_url ?? undefined,
    },
    priceLadder: tiers.map((t) => ({
      beginAmount: t.begin_amount,
      endAmount: t.end_amount ?? undefined,
      price: t.price,
    })),
    specDimensions: dims.map((d) => ({ name: d.name, values: parseJson<string[]>(d.values_json, []) })),
    skus: skus.map((s) => ({
      skuId: s.sku_code,
      specValues: parseJson<Record<string, string>>(s.spec_json, {}),
      price: s.price ?? undefined,
      stock: s.stock ?? undefined,
      imageUrl: s.image_url ?? undefined,
    })),
    attributes: attrs.map((a) => ({ name: a.name, value: a.value })),
    images: images.map(toImage),
    weightGram: row.weight_gram ?? undefined,
    dimensions: parseJson<{ length: number; width: number; height: number } | undefined>(
      row.dimensions_json,
      undefined,
    ),
  };
}

/** 扩展上报前查重用：只回 id 与采集时间，不拉明细 */
export function findOfferByPlatformOffer(
  platform: string,
  offerId: string,
): { id: string; collectedAt: string } | undefined {
  const row = getDb()
    .prepare("SELECT id, collected_at FROM sourcing_offers WHERE platform = ? AND offer_id = ?")
    .get(platform, offerId) as unknown as { id: string; collected_at: string } | undefined;
  return row ? { id: row.id, collectedAt: row.collected_at } : undefined;
}

/** 原始上报载荷，用于 1688 改版后的离线重解析 */
export function getRawPayload(id: string): CollectedOffer | undefined {
  const row = getDb()
    .prepare("SELECT raw_json FROM sourcing_offers WHERE id = ?")
    .get(id) as unknown as { raw_json: string } | undefined;
  return row ? parseJson<CollectedOffer | undefined>(row.raw_json, undefined) : undefined;
}

export function deleteSourcingOffer(id: string): boolean {
  // 外键 ON DELETE CASCADE 会带走五张明细表；日志表无外键，保留
  const result = getDb().prepare("DELETE FROM sourcing_offers WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function getSourcingStats(): SourcingStats {
  const db = getDb();

  // 「今日新增」按本地时区当天零点算。collected_at 存的是 UTC ISO，
  // 所以把本地零点换算成 UTC 时刻再做字符串比较，避免拿 UTC 日期当本地日期。
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const base = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN collected_at >= ? THEN 1 ELSE 0 END) AS today_new,
         SUM(CASE WHEN image_status = 'failed' THEN 1 ELSE 0 END) AS image_failed,
         SUM(CASE WHEN image_status = 'pending' THEN 1 ELSE 0 END) AS image_pending
       FROM sourcing_offers`,
    )
    .get(dayStart.toISOString()) as unknown as {
    total: number;
    today_new: number | null;
    image_failed: number | null;
    image_pending: number | null;
  };

  return {
    total: base?.total ?? 0,
    todayNew: base?.today_new ?? 0,
    imageFailed: base?.image_failed ?? 0,
    imagePending: base?.image_pending ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * 图片转存（供 images.ts 调用）
 * ------------------------------------------------------------------ */

/** 待转存的图片，按 offer 分组前先摊平 */
export function listPendingImages(): ImageRow[] {
  return getDb()
    .prepare(
      "SELECT id, offer_id, kind, source_url, local_path, status, error, bytes, position FROM sourcing_images WHERE status = 'pending'",
    )
    .all() as unknown as ImageRow[];
}

export function listImagesByOffer(offerId: string): ImageRow[] {
  return getDb()
    .prepare(
      "SELECT id, offer_id, kind, source_url, local_path, status, error, bytes, position FROM sourcing_images WHERE offer_id = ? ORDER BY (kind <> 'main'), kind, position",
    )
    .all(offerId) as unknown as ImageRow[];
}

/**
 * 把某个 offer 的图片全部打回 pending。
 *
 * 用于「重新转存」：转存逻辑只挑 pending 的图处理，所以重试前必须先重置，
 * 否则失败的图永远不会被再次尝试。
 */
export function resetImagesToPending(offerId: string): number {
  return withTransaction(() => {
    const result = getDb()
      .prepare(
        "UPDATE sourcing_images SET status = 'pending', error = NULL WHERE offer_id = ?",
      )
      .run(offerId);
    getDb().prepare("UPDATE sourcing_offers SET image_status = 'pending' WHERE id = ?").run(offerId);
    return Number(result.changes);
  });
}

/** 写回单张图片的转存结果 */
export function markImageResult(
  imageId: string,
  result: { status: ImageStatus; localPath?: string; bytes?: number; error?: string },
): void {
  getDb()
    .prepare("UPDATE sourcing_images SET status = ?, local_path = ?, bytes = ?, error = ? WHERE id = ?")
    .run(
      result.status,
      result.localPath ?? "",
      result.bytes ?? null,
      result.error ? result.error.slice(0, 500) : null,
      imageId,
    );
}

/** 转存跑完后刷新该 offer 的汇总状态 */
export function refreshOfferImageStatus(offerId: string): void {
  recomputeImageStatus(offerId);
}

/** 启动时捞回上次进程退出时卡在 pending 的 records */
export function listOffersWithPendingImages(): { id: string }[] {
  return getDb()
    .prepare("SELECT DISTINCT offer_id AS id FROM sourcing_images WHERE status = 'pending'")
    .all() as unknown as { id: string }[];
}
