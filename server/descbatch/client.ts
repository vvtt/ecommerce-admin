/**
 * 描述改写域数据连接：独立 SQLite（node:sqlite，WAL）。
 *
 * 与采集/竞品域同等模式：一个域一个库文件，表结构手写 DDL 无 ORM。
 * 任务表 + 明细表一对多，删除任务级联删明细。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_DIR = path.join(process.cwd(), "server", "descbatch");
const DB_PATH = path.join(DB_DIR, "descbatch.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        title TEXT,
        category TEXT,
        original TEXT NOT NULL,
        rewritten TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT
    );
  `);
  return db;
}
