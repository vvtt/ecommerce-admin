/**
 * SQLite 连接（采集域专用）。
 *
 * 驱动用 Node 24 内置的 `node:sqlite`，不是 better-sqlite3。原因有二：
 *  1. 原生模块在 Windows + Node 24 上要现编译，本机 npm 源当时不通；
 *  2. 内置驱动零依赖，且同样是同步 API，与本项目手写 SQL 的风格一致。
 * 代价是 Node 会打一条 ExperimentalWarning —— 可接受，因为所有 SQL 都收敛在
 * 本文件与 repository.ts，将来换驱动（含换 Postgres）只改这两处，上层无感。
 *
 * 注意：本文件是 Node 专有的，绝不能被前端引用。采集域因此不提供离线兜底。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema";

/**
 * 数据落盘位置。
 *
 * 默认放在 server/sourcing/ 下，由 process.cwd() 推导 —— dev（tsx）与
 * start（node dist/server.cjs）都以项目根为 cwd，所以两种模式指向同一份数据。
 * 需要换位置（如容器里挂卷）时用环境变量覆盖。
 */
const DATA_DIR = process.env.SOURCING_DATA_DIR
  ? path.resolve(process.env.SOURCING_DATA_DIR)
  : path.join(process.cwd(), "server", "sourcing");

/** 采集域的运行时数据根目录。db、uploads、令牌文件都落在这里 */
export const SOURCING_DATA_DIR = DATA_DIR;

export const DB_PATH = process.env.SOURCING_DB_PATH
  ? path.resolve(process.env.SOURCING_DB_PATH)
  : path.join(DATA_DIR, "db.sqlite");

/** 图片转存根目录，通过 /uploads 静态暴露 */
export const UPLOAD_DIR = process.env.SOURCING_UPLOAD_DIR
  ? path.resolve(process.env.SOURCING_UPLOAD_DIR)
  : path.join(DATA_DIR, "uploads");

let db: DatabaseSync | null = null;

/**
 * 取连接（单例）。首次调用时建目录、开库、建表。
 *
 * 用单例而不是每次新建：SQLite 的 WAL 模式下一个进程只应有少量连接，
 * 而 Express 是单进程串行处理，一个连接足够，也避免了写锁竞争。
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const instance = new DatabaseSync(DB_PATH);

  // WAL：读写不互相阻塞，且崩溃后不易损坏。better-sqlite3 时代的常识，通用。
  instance.exec("PRAGMA journal_mode = WAL");
  // 外键默认是关的，级联删除依赖它，必须显式打开
  instance.exec("PRAGMA foreign_keys = ON");
  // 写操作不必每次都 fsync，采集这种量级丢最后一次写无妨，换来明显更快的批量插入
  instance.exec("PRAGMA synchronous = NORMAL");

  instance.exec(SCHEMA_SQL);

  db = instance;
  return db;
}

/**
 * 事务包装。回调内抛异常则整体回滚。
 *
 * node:sqlite 没有现成的 transaction() 辅助（better-sqlite3 有），所以自己写一个。
 * 注意嵌套调用会报 "cannot start a transaction within a transaction" ——
 * 约定：只有最外层的写操作使用本函数，内部函数不自行开事务。
 */
export function withTransaction<T>(fn: () => T): T {
  const instance = getDb();
  instance.exec("BEGIN");
  try {
    const result = fn();
    instance.exec("COMMIT");
    return result;
  } catch (error) {
    instance.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 关连接。仅用于测试与优雅退出。
 */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}
