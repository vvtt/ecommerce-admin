/**
 * 竞品域 SQLite 连接。
 *
 * 与 sourcing/client.ts 同一套模式：Node 24 内置 node:sqlite、单连接、WAL。
 * 数据文件放在 server/competitor/ 下（可用 COMPETITOR_DATA_DIR 环境变量改位置），
 * 与采集域的 db.sqlite 完全分库 —— 两域生命周期不同（采集库有真实历史数据，
 * 竞品库允许随时清空重抓），分文件才不会误伤。
 *
 * 本文件是 Node 专有的，绝不能被前端 import。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema";

/**
 * 竞品域数据根目录。dev（tsx）与 start（node dist/server.cjs）都以项目根为
 * cwd，因此两种模式指向同一份数据。
 */
const DATA_DIR = process.env.COMPETITOR_DATA_DIR
  ? path.resolve(process.env.COMPETITOR_DATA_DIR)
  : path.join(process.cwd(), "server", "competitor");

export const COMPETITOR_DATA_DIR = DATA_DIR;

export const DB_PATH = process.env.COMPETITOR_DB_PATH
  ? path.resolve(process.env.COMPETITOR_DB_PATH)
  : path.join(DATA_DIR, "shopee.db");

/**
 * JSON 落盘根目录 —— 沿用 Python 版「文件是源头，DB 是索引」的原则：
 * ingest 先写文件再写库，库里数据丢了可以从文件全量重建。
 * 四个子目录的语义与 receive.py 完全一致。
 */
export const COMPETITOR_STORE_DIR = path.join(DATA_DIR, "data");

export const PRODUCT_DIR = path.join(COMPETITOR_STORE_DIR, "products");
export const REVIEW_DIR = path.join(COMPETITOR_STORE_DIR, "reviews");
export const CRED_DIR = path.join(COMPETITOR_STORE_DIR, "credentials");
export const RAW_DIR = path.join(COMPETITOR_STORE_DIR, "raw");

let db: DatabaseSync | null = null;

// 目录初始化放在模块加载时，而不是 getDb() 里 —— ingest 的落盘发生在首次
// 触达数据库之前（先写文件再写库），如果等 getDb() 才建目录，第一条上报
// 就会因目录不存在而失败。
for (const dir of [path.dirname(DB_PATH), PRODUCT_DIR, REVIEW_DIR, CRED_DIR, RAW_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 取连接（单例）。首次调用时开库、建表 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const instance = new DatabaseSync(DB_PATH);
  instance.exec("PRAGMA journal_mode = WAL");
  // 竞品采集丢最后一次写无妨，换来更快的批量插入（与采集域同款取舍）
  instance.exec("PRAGMA synchronous = NORMAL");
  instance.exec(SCHEMA_SQL);

  // 增量列迁移：CREATE TABLE IF NOT EXISTS 不会给存量表补新列。
  // review_file = 评论 JSONL 文件路径（相对 COMPETITOR_STORE_DIR）—— 评论改
  // 文件存储后，DB 只存索引不存内容。
  const cols = instance.prepare("PRAGMA table_info(products)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "review_file")) {
    instance.exec("ALTER TABLE products ADD COLUMN review_file TEXT");
  }

  db = instance;
  return db;
}

/** 关连接。仅用于测试与优雅退出 */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}
