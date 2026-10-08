/**
 * 插件上报处理器：把 Shopee 插件 POST 过来的各类截获数据落盘 + 写库。
 *
 * 逻辑移植自独立 Python 接收脚本 receive.py（script/shopee/backend），协议
 * 保持兼容：同样的 POST /ingest 入口、同样的 body.type 分发、同样的落盘
 * 目录结构。这样插件端除了上报地址什么都不用改。
 *
 * 移植时保留的核心原则：
 *  1. 文件是源头，DB 是索引 —— 先落盘 JSON 再写库，库可随时从文件重建；
 *  2. 采集时间（captured_at）只在首采时写入，重采不覆盖，最新时间由
 *     updated_at 承载（幂等性要求）；
 *  3. Cookie 凭证等同账号令牌 —— 只落盘，不进 DB，日志绝不打印内容。
 */
import fs from "node:fs";
import path from "node:path";
import {
  CRED_DIR,
  PRODUCT_DIR,
  RAW_DIR,
  REVIEW_DIR,
} from "./client";
import { mergeReviews, upsertProduct } from "./repository";

/** 插件上报载荷。type 决定走哪个 handler，其余字段按 type 各取所需 */
export interface IngestBody {
  type: "pdp" | "ratings" | "ldjson" | "cookie" | "page_html";
  shopId?: string | number;
  itemId?: string | number;
  url?: string;
  data?: unknown;
  cookies?: string;
  names?: string[];
  html?: string;
}

/**
 * pdp 落盘记录的形状（与 Python 版 record 对象逐字段对齐）。
 * repository 的 upsert 以此为唯一输入，保证文件与 DB 内容可互推。
 */
export interface PdpRecord {
  type: "pdp";
  shop_id: string;
  item_id: string;
  name: string;
  description_html: string;
  description_text: string;
  attributes: { name: string; value: string }[];
  category: {
    cat_id?: number;
    path: string;
    categories: { cat_id: number; name: string }[];
    fe_path: string;
    fe_categories: { cat_id: number; name: string }[];
  };
  global_item_id?: unknown;
  rating_summary: Record<string, unknown>;
  price: {
    price?: number;
    price_min?: number;
    price_max?: number;
    price_before_discount?: number;
    raw: Record<string, unknown>;
    currency: string;
  };
  tier_variations: { name: string; options: string[] }[];
  models: { modelid?: number; name: string; price?: number; normal_stock?: number }[];
  stock?: unknown;
  sold?: unknown;
  shop_name: string;
  shop_location?: string;
  cb_option?: unknown;
  item_status: string;
  listed_at?: number;
  captured_at: string;
  source_url: string;
}

/* ------------------------------------------------------------------ *
 * HTML 转纯文本
 * ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "section"]);

/** 常见命名实体。Shopee 描述里出现频率极低，小表够用，不值得为它装依赖 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, code: string) => {
    if (code.startsWith("#")) {
      const num =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * HTML 抠纯文本。Python 版用 html.parser 的状态机（跳过 script/style、
 * 块级标签转换行），这里用等价的正则流水线实现，行为一致：
 * script/style 整块剔除 → 块级标签转换行 → 剩余标签剥掉 → 实体解码 → 压空白。
 */
export function html2text(s: string): string {
  if (!s) return "";
  const text = decodeEntities(
    s
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<(?:\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, tag: string) =>
        BLOCK_TAGS.has(tag.toLowerCase()) ? "\n" : ""
      )
  );
  return text.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function productPath(shop: string, item: string): string {
  return path.join(PRODUCT_DIR, `${shop}_${item}.json`);
}

function reviewPath(shop: string, item: string): string {
  return path.join(REVIEW_DIR, `${shop}_${item}.jsonl`);
}

/** Shopee 价格字段是整数（真实值 × 100000）：30900000 = NT$309 */
const PRICE_SCALE = 100000;

const toPrice = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v / PRICE_SCALE : undefined;

const toStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function nowStamp(): string {
  // 与 Python time.strftime("%Y-%m-%d %H:%M:%S") 同格式，保持数据口径一致
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 从 Shopee 分类链（[{catid, display_name}]，文档顺序=面包屑顺序）抓名称链 */
function catChain(lst: unknown): { cat_id: number; name: string }[] {
  if (!Array.isArray(lst)) return [];
  return lst
    .map((c) => (c as { catid?: unknown; display_name?: unknown }) ?? {})
    .filter((c) => typeof c.catid === "number" || typeof c.catid === "string")
    .map((c) => ({ cat_id: Number(c.catid), name: toStr(c.display_name) }))
    .filter((c) => c.name !== "" || Number.isFinite(c.cat_id));
}

/* ------------------------------------------------------------------ *
 * 各类型处理
 * ------------------------------------------------------------------ */

/** 商品详情截获：解析 v4 get_pc 响应 → 落盘 products/*.json → upsert DB */
export function handlePdp(body: IngestBody): { ok: boolean; saved?: string; note?: string } {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const node = ((data.data as Record<string, unknown>) ?? data) as Record<string, unknown>;
  const it = (node.item as Record<string, unknown> | undefined) ?? {};

  if (!Object.keys(it).length && !body.shopId) {
    return { ok: false, note: "no item payload" };
  }

  // 原始响应先完整落盘 raw/ —— 以后要补字段直接从这里分析，不用重抓
  const rawShop = toStr(body.shopId || it.shopid);
  const rawItem = toStr(body.itemId || it.itemid);
  if (Object.keys(data).length) {
    try {
      fs.writeFileSync(
        path.join(RAW_DIR, `${rawShop}_${rawItem}_pdp.json`),
        JSON.stringify(data, null, 2),
        "utf-8",
      );
    } catch (error) {
      console.error(`[competitor/pdp] 原始响应落盘失败:`, error);
    }
  }

  const itemId = toStr(it.itemid ?? body.itemId);
  const shopId = toStr(it.shopid ?? body.shopId);
  const descHtml = toStr(it.description);

  // 商品名：v4 get_pc 响应里叫 title，旧版接口才叫 name
  const name = toStr(it.title || it.name);

  // v4 响应带两套分类树：categories = 后端/SEO 树（cat_id 是它的叶子 id），
  // fe_categories = 前端面包屑树
  const cats = catChain(it.categories);
  const feCats = catChain(it.fe_categories);
  const leafCatId =
    typeof it.cat_id === "number" ? it.cat_id : (cats.at(-1)?.cat_id ?? undefined);

  const models = (Array.isArray(it.models) ? it.models : []).map(
    (m) =>
      (m as Record<string, unknown>) && {
        modelid: (m as Record<string, unknown>).modelid as number | undefined,
        name: toStr((m as Record<string, unknown>).name),
        price: toPrice((m as Record<string, unknown>).price),
        normal_stock: (m as Record<string, unknown>).normal_stock as number | undefined,
      }
  );

  const ratingSummary =
    it.item_rating && typeof it.item_rating === "object" ? (it.item_rating as Record<string, unknown>) : {};

  const record: PdpRecord = {
    type: "pdp",
    shop_id: shopId,
    item_id: itemId,
    name,
    description_html: descHtml,
    description_text: html2text(descHtml),
    attributes: (Array.isArray(it.attributes) ? it.attributes : [])
      .map((a) => {
        const r = (a as Record<string, unknown>) ?? {};
        return { name: toStr(r.name), value: toStr(r.value) };
      })
      .filter((a) => a.name || a.value),
    category: {
      cat_id: leafCatId,
      path: cats.map((c) => c.name).join(" > "),
      categories: cats,
      fe_path: feCats.map((c) => c.name).join(" > "),
      fe_categories: feCats,
    },
    global_item_id: it.global_item_id,
    rating_summary: ratingSummary,
    price: {
      price: toPrice(it.price),
      price_min: toPrice(it.price_min),
      price_max: toPrice(it.price_max),
      price_before_discount: toPrice(it.price_before_discount),
      raw: { price: it.price, price_min: it.price_min, price_max: it.price_max },
      currency: toStr(it.currency) || "TWD",
    },
    tier_variations: (Array.isArray(it.tier_variations) ? it.tier_variations : []).map((tv) => {
      const r = (tv as Record<string, unknown>) ?? {};
      return {
        name: toStr(r.name),
        options: Array.isArray(r.options) ? r.options.map(toStr) : [],
      };
    }),
    models,
    stock: it.stock ?? it.normal_stock,
    sold: it.historical_sold ?? it.sold,
    shop_name: toStr((node.shop_info as Record<string, unknown> | undefined)?.name),
    shop_location: toStr(it.shop_location) || undefined,
    cb_option: it.cb_option,
    item_status: toStr(it.item_status),
    listed_at: typeof it.ctime === "number" ? it.ctime : undefined,
    captured_at: nowStamp(),
    source_url: toStr(body.url),
  };

  fs.writeFileSync(productPath(shopId, itemId), JSON.stringify(record, null, 2), "utf-8");
  console.log(
    `[competitor/pdp] shop ${shopId} item ${itemId}  ${record.name.slice(0, 36)}\n` +
      `      规格 ${record.attributes.length} 项 · 分类 ${record.category.path || "(未取到)"}` +
      ` · 描述 ${record.description_text.length} 字 · SKU ${models.length} 个`
  );

  // 写库失败不影响文件落盘 —— 文件是源头，下次 rebuild 能补回来
  try {
    upsertProduct(record);
  } catch (error) {
    console.error("[competitor/db] 商品写入失败:", error);
  }
  return { ok: true, saved: productPath(shopId, itemId) };
}

/** 评论批次截获：_key 去重 → JSONL 追加 → 合并进 DB 的 reviews_json */
export function handleRatings(body: IngestBody): { ok: boolean; batch?: number; new?: number; total?: number } {
  const shop = toStr(body.shopId);
  const item = toStr(body.itemId);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const node = ((data.data as Record<string, unknown>) ?? data) as Record<string, unknown>;
  const ratings = (node.ratings as Record<string, unknown>[] | undefined) ?? [];

  if (!ratings.length) {
    return { ok: true };
  }

  const rPath = reviewPath(shop, item);
  // 评论量级几千行，全量读键集合足够快（与 Python 版同策略）
  const keys = new Set<string>();
  if (fs.existsSync(rPath)) {
    for (const line of fs.readFileSync(rPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        keys.add(((JSON.parse(line) as Record<string, unknown>)["_key"] as string) ?? "");
      } catch {
        // 坏行跳过，不影响其余评论
        continue;
      }
    }
  }

  const newRows: Record<string, unknown>[] = [];
  for (const r of ratings) {
    const comment = toStr(r.comment);
    const key = `${toStr(r.author_username)}|${toStr(r.ctime)}|${comment.slice(0, 80)}`;
    if (keys.has(key)) continue;
    keys.add(key);
    newRows.push({
      _key: key,
      author_username: toStr(r.author_username),
      author_name: toStr(r.author_name),
      rating_star: r.rating_star,
      comment,
      comment_tag: r.comment_tag ?? null,
      ctime: r.ctime,
      orderid: r.orderid,
      captured_at: nowStamp(),
    });
  }

  if (newRows.length) {
    fs.appendFileSync(
      rPath,
      newRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf-8",
    );
  }

  console.log(
    `[competitor/ratings] shop ${shop} item ${item}  本批 ${ratings.length} 条，新增 ${newRows.length} 条，累计 ${keys.size} 条`
  );

  const merged = mergeReviews(shop, item, newRows);
  if (merged.added) {
    console.log(`[competitor/db] 评论合并：+${merged.added} 条，DB 累计 ${merged.total} 条`);
  }
  return { ok: true, batch: ratings.length, new: newRows.length, total: keys.size };
}

/** JSON-LD 兜底：只补缺，不覆盖已从 pdp 抓到的正主数据（与 Python 版一致，只改文件不进库） */
export function handleLdjson(body: IngestBody): { ok: boolean; saved?: string; note?: string } {
  const shop = toStr(body.shopId);
  const item = toStr(body.itemId);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const ld = (data.ld as Record<string, unknown> | undefined) ?? {};

  if (!Object.keys(ld).length && !data.h1) {
    return { ok: false, note: "no ld+json found" };
  }

  const pPath = productPath(shop, item);
  const existing: Record<string, unknown> = fs.existsSync(pPath)
    ? (() => {
        try {
          return JSON.parse(fs.readFileSync(pPath, "utf-8")) as Record<string, unknown>;
        } catch {
          return {};
        }
      })()
    : {};

  let changed = false;
  if (ld.name && !existing.name) {
    existing.name = ld.name;
    changed = true;
  }
  if (ld.description && !existing.description_text) {
    existing.description_text = html2text(toStr(ld.description));
    changed = true;
  }
  if (ld.aggregateRating && !existing.rating_summary) {
    existing.rating_summary = { aggregateRating: ld.aggregateRating };
    changed = true;
  }
  if (data.h1 && !existing.name) {
    existing.name = data.h1;
    changed = true;
  }

  existing.type ??= "ldjson-fallback";
  existing.item_id ??= item;
  existing.shop_id ??= shop;
  existing.captured_at ??= nowStamp();

  if (changed || !fs.existsSync(pPath)) {
    fs.writeFileSync(pPath, JSON.stringify(existing, null, 2), "utf-8");
    console.log(`[competitor/ldjson] shop ${shop} item ${item}  兜底字段已写入`);
  }
  return { ok: true, saved: pPath };
}

/** 登录凭证：只落盘，不进 DB。凭证等同账号令牌，日志绝不打印内容 */
export function handleCookie(body: IngestBody): { ok: boolean; saved: string } {
  const shop = toStr(body.shopId);
  const item = toStr(body.itemId);
  // 文件名时间戳格式与 Python 版一致：20260927_114800
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const pPath = path.join(CRED_DIR, `cookie_${shop}_${item}_${ts}.txt`);
  fs.writeFileSync(
    pPath,
    `# url: ${toStr(body.url)}\n` +
      `# captured_at: ${nowStamp()}\n` +
      `# cookie 名单: ${(body.names ?? []).join(", ")}\n\n` +
      `${body.cookies ?? ""}\n`,
    "utf-8",
  );
  console.log(`[competitor/cookie] 已保存 ${(body.names ?? []).length} 个 Cookie 到 ${path.basename(pPath)}`);
  return { ok: true, saved: pPath };
}

/** 完整页面 HTML：落盘 raw/ 并从分类链接里抠分类（href 形如 /xxx-cat.11013267） */
export function handlePageHtml(body: IngestBody): { ok: boolean; kb: number; categories: number } {
  const shop = toStr(body.shopId);
  const item = toStr(body.itemId);
  const html = toStr(body.html);

  fs.writeFileSync(path.join(RAW_DIR, `${shop}_${item}_page.html`), html, "utf-8");

  // 文档顺序即面包屑顺序（顶层分类在前，叶子在后）
  const cats: { cat_id: string; name: string; href: string }[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]+href="([^"]*?cat\.(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(linkRe)) {
    const [, href, catid, inner] = m;
    if (seen.has(catid)) continue;
    seen.add(catid);
    const name = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    cats.push({ cat_id: catid, name: name.slice(0, 60), href: href.slice(0, 160) });
  }

  fs.writeFileSync(
    path.join(RAW_DIR, `${shop}_${item}_categories.json`),
    JSON.stringify(
      { shop_id: shop, item_id: item, url: toStr(body.url), captured_at: nowStamp(), categories_from_links: cats },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(
    `[competitor/html] shop ${shop} item ${item}  页面 ${Math.floor(html.length / 1024)} KB，链接里抠到 ${cats.length} 个分类`
  );
  return { ok: true, kb: Math.floor(html.length / 1024), categories: cats.length };
}

/** 统一分发。返回 null 表示未知 type（由路由层报 400） */
export function dispatchIngest(body: IngestBody): Record<string, unknown> {
  switch (body.type) {
    case "pdp":
      return handlePdp(body);
    case "ratings":
      return handleRatings(body);
    case "ldjson":
      return handleLdjson(body);
    case "cookie":
      return handleCookie(body);
    case "page_html":
      return handlePageHtml(body);
    default:
      return { ok: false, note: `unknown type: ${String(body.type)}` };
  }
}
