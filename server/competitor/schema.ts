/**
 * 竞品域 SQLite DDL（Shopee 竞品商品库）。
 *
 * 表结构移植自独立 Python 接收脚本（script/shopee/backend/receive.py）的
 * DB_SCHEMA，列名与约束刻意保持一致 —— 旧脚本目录里的 shopee.db 若将来
 * 要并进来，靠「文件是源头」的 rebuild 流程即可原样重建，不需要写迁移 SQL。
 *
 * 与采集域同样的取舍：一张宽表、手写 DDL、不用 ORM。评论大字段
 * （reviews_json）按 receive.py 的习惯存 JSON 数组，量级（单商品几千条）
 * 还不到拆表的程度，拆表反而让「文件重建」变复杂。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id              INTEGER NOT NULL,                    -- 店铺 id ┐ 商品唯一键
    item_id              INTEGER NOT NULL,                    -- 商品 id ┘ UNIQUE(shop,item)
    name                 TEXT,                                -- 商品名称
    cat_id               INTEGER,                             -- 叶子分类 id
    category_path        TEXT,                                -- 分类链（后端树）"居家生活 > ..."
    fe_category_path     TEXT,                                -- 分类链（前端面包屑树）
    attributes_json      TEXT,                                -- 商品规格 [{name,value}]
    description_text     TEXT,                                -- 商品描述（纯文本）
    url                  TEXT,                                -- 商品链接
    price                REAL,                                -- 价格（已按 1e5 缩放换算，见 ingest.ts）
    price_min            REAL,
    price_max            REAL,
    currency             TEXT,
    rating_star          REAL,                                -- 评分汇总星级
    tier_variations_json TEXT,                                -- 变体维度 [{name,options}]
    models_json          TEXT,                                -- SKU 列表 [{modelid,name,price}]
    model_count          INTEGER,
    reviews_json         TEXT NOT NULL DEFAULT '[]',          -- 评论大字段（JSON 数组，去重合并）
    review_count         INTEGER NOT NULL DEFAULT 0,
    shop_name            TEXT,
    shop_location        TEXT,                                -- 发货地
    is_cross_border      INTEGER,                             -- cb_option 1=跨境
    item_status          TEXT,                                -- normal / banned / ...
    listed_at            INTEGER,                             -- 上架时间（unix 秒）
    captured_at          TEXT,                                -- 首次采集时间
    updated_at           TEXT,                                -- 最近更新时间
    UNIQUE(shop_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_products_cat  ON products(cat_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- 搜索批量采集的标签表：tag = 搜索关键字，同一商品可被多个关键字命中（多对多）。
-- UNIQUE 让重复抓取/重复打标天然幂等（INSERT OR IGNORE）。
CREATE TABLE IF NOT EXISTS product_tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id     INTEGER NOT NULL,
    item_id     INTEGER NOT NULL,
    tag         TEXT NOT NULL,
    created_at  TEXT,
    UNIQUE(shop_id, item_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_product_tags_tag ON product_tags(tag);

-- 批量采集任务表：跑批从内存状态机升级为 DB 持久化，
-- 前端刷新 / server 重启后历史任务与进度依然可查。
-- kind：ratings = 商品详情 + 评论一起采（PDP 接口在采评论的窗口里顺带截获）。
CREATE TABLE IF NOT EXISTS collect_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,                     -- ratings（预留 search/full）
    tag          TEXT,                              -- 过滤标签（= 搜索关键字），null = 全部
    max_pages    INTEGER,                           -- 每商品翻页上限
    status       TEXT NOT NULL DEFAULT 'running',   -- running / done / stopped / failed
    total        INTEGER NOT NULL DEFAULT 0,        -- 计划商品数
    done         INTEGER NOT NULL DEFAULT 0,        -- 已处理（含失败）
    success      INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    reviews      INTEGER NOT NULL DEFAULT 0,        -- 本任务累计新增评论文数
    current_item TEXT,                              -- 正在采的商品（展示用）
    current_step TEXT,                              -- 当前步骤（打开页面/滚动加载/翻页…）
    error        TEXT,
    created_at   TEXT,
    updated_at   TEXT,
    finished_at  TEXT
);

-- 任务明细：每个商品一行，能逐条看到谁成了谁败了、采到多少条评论。
CREATE TABLE IF NOT EXISTS collect_task_items (
    task_id  INTEGER NOT NULL,
    shop_id  TEXT NOT NULL,
    item_id  TEXT NOT NULL,
    name     TEXT,
    status   TEXT NOT NULL DEFAULT 'pending',       -- pending / running / done / failed
    reviews  INTEGER NOT NULL DEFAULT 0,            -- 该商品新增评论文数
    pdp_saved INTEGER NOT NULL DEFAULT 0,           -- 商品详情是否顺带补全
    error    TEXT,
    PRIMARY KEY (task_id, shop_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_task_items_task ON collect_task_items(task_id);
`;
