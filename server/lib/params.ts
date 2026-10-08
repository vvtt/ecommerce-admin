/**
 * Express 请求处理小工具：query 参数取值 + 统一错误包装。
 */
import type { Request, RequestHandler, Response } from "express";

/** 取字符串型 query 参数，空串视为未提供 */
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** 取数字型 query 参数 */
export const int = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** 取数组型参数（batch 接口用） */
export const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" && v.length > 0 ? [v] : [];
};

/**
 * 把可能抛错的处理函数包成 Express handler。
 * 业务校验失败统一返回 400 + { error }，进程不会因为一个坏请求挂掉。
 */
export function handle(fn: (req: Request, res: Response) => void): RequestHandler {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "请求处理失败" });
    }
  };
}
