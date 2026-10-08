/**
 * 采集域表结构（DDL + 行类型）。
 *
 * 为什么不用 ORM：本项目的 shared/queries.ts 全是手写 SQL，零 ORM。
 * 采集域只有 7 张表，引 drizzle 会让它成为全项目唯一的异类，收益不抵复杂度。
 * 计划里原本选 drizzle-orm，因网络原因装不上（ECONNRESET），顺理成章落到手写。
 *
 * 表间关系：sourcing_offers 是主表，其余 5 张明细表以 offer_id 外键级联删除。
 * sourcing_collect_logs 刻意不设外键 —— 采集日志是审计轨迹，货源被删后仍应保留。
 */

/**
 * 建表语句。全部 IF NOT EXISTS，每次启动幂等执行。
 *
 * 关于 `position` 列：SQLite 不保证 SELECT 的返回顺序，而阶梯价、SKU、
 * 属性、图片的顺序是页面语义的一部分（第一张主图要当缩略图）。所以显式
 * 存一列序号，读取时一律 ORDER BY position。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sourcing_offers (
  id                  TEXT PRIMARY KEY,
  platform            TEXT NOT NULL,
  offer_id            TEXT NOT NULL,
  url                 TEXT NOT NULL,
  title               TEXT NOT NULL,
  supplier_name       TEXT,
  supplier_login_id   TEXT,
  supplier_location   TEXT,
  supplier_shop_url   TEXT,
  moq                 INTEGER,
  price_min           REAL,
  price_max           REAL,
  weight_gram         INTEGER,
  dimensions_json     TEXT,
  raw_json            TEXT NOT NULL,
  extractor_version   TEXT NOT NULL,
  image_status        TEXT NOT NULL DEFAULT 'pending',
  collected_at        TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 去重键：同一平台的同一个 offer 只允许一行，采集接口据此 UPSERT
CREATE UNIQUE INDEX IF NOT EXISTS idx_offers_platform_offer
  ON sourcing_offers (platform, offer_id);

CREATE INDEX IF NOT EXISTS idx_offers_collected_at
  ON sourcing_offers (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_offers_price_min
  ON sourcing_offers (price_min);

CREATE TABLE IF NOT EXISTS sourcing_price_tiers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id      TEXT NOT NULL REFERENCES sourcing_offers (id) ON DELETE CASCADE,
  begin_amount  INTEGER NOT NULL,
  end_amount    INTEGER,
  price         REAL NOT NULL,
  position      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tiers_offer ON sourcing_price_tiers (offer_id, position);

CREATE TABLE IF NOT EXISTS sourcing_spec_dimensions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id      TEXT NOT NULL REFERENCES sourcing_offers (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  values_json   TEXT NOT NULL,
  position      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dims_offer ON sourcing_spec_dimensions (offer_id, position);

CREATE TABLE IF NOT EXISTS sourcing_skus (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id      TEXT NOT NULL REFERENCES sourcing_offers (id) ON DELETE CASCADE,
  sku_code      TEXT NOT NULL,
  spec_json     TEXT NOT NULL,
  price         REAL,
  stock         INTEGER,
  image_url     TEXT,
  position      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skus_offer ON sourcing_skus (offer_id, position);

CREATE TABLE IF NOT EXISTS sourcing_attributes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id      TEXT NOT NULL REFERENCES sourcing_offers (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  position      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attrs_offer ON sourcing_attributes (offer_id, position);

CREATE TABLE IF NOT EXISTS sourcing_images (
  id            TEXT PRIMARY KEY,
  offer_id      TEXT NOT NULL REFERENCES sourcing_offers (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  local_path    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  bytes         INTEGER,
  position      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_offer ON sourcing_images (offer_id, kind, position);

-- 故意不设外键：货源删掉后，谁在什么时候采过它这件事仍要留痕
CREATE TABLE IF NOT EXISTS sourcing_collect_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_offer ON sourcing_collect_logs (offer_id, created_at DESC);
`;

/* ------------------------------------------------------------------ *
 * 行类型
 *
 * 与上表一一对应，字段名用下划线（跟列名一致），避免查询时还要做映射。
 * 对外暴露前由 repository.ts 转成 src/types.ts 里的驼峰结构。
 * ------------------------------------------------------------------ */

export interface OfferRow {
  id: string;
  platform: string;
  offer_id: string;
  url: string;
  title: string;
  supplier_name: string | null;
  supplier_login_id: string | null;
  supplier_location: string | null;
  supplier_shop_url: string | null;
  moq: number | null;
  price_min: number | null;
  price_max: number | null;
  weight_gram: number | null;
  dimensions_json: string | null;
  raw_json: string;
  extractor_version: string;
  image_status: string;
  collected_at: string;
  updated_at: string;
}

export interface PriceTierRow {
  begin_amount: number;
  end_amount: number | null;
  price: number;
}

export interface SpecDimensionRow {
  name: string;
  values_json: string;
}

export interface SkuRow {
  sku_code: string;
  spec_json: string;
  price: number | null;
  stock: number | null;
  image_url: string | null;
}

export interface AttributeRow {
  name: string;
  value: string;
}

export interface ImageRow {
  id: string;
  offer_id: string;
  kind: string;
  source_url: string;
  local_path: string;
  status: string;
  error: string | null;
  bytes: number | null;
  position: number;
}
