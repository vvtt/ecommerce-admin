/**
 * 竞品分析接口：/api/competitor
 *
 * 插件上报入口沿用 Python 接收脚本的协议（POST + body.type 分发），插件端
 * 只改上报地址即可切换到本服务。按既定决策 ingest 不设鉴权（仅本机使用，
 * 与现有 /api/products 的裸奔口径一致；sourcing 的 X-Collect-Token 也已移除）。
 * 日后要上公网时，给写入路由统一加登录/中间件即可。
 *
 * 逻辑全部委托给 server/competitor/，本文件只做 HTTP 编解码。
 */
import { Router } from "express";
import type { IngestBody } from "../competitor/ingest";
import { dispatchIngest } from "../competitor/ingest";
import { deleteProduct, getProduct, queryProducts } from "../competitor/repository";
import { handle, int, str } from "../lib/params";

export const competitorRouter = Router();

/** 插件统一上报入口。未知 type 由 dispatchIngest 返回 note，这里报 400 */
competitorRouter.post(
  "/ingest",
  handle((req, res) => {
    const body = req.body as IngestBody | undefined;
    if (!body || typeof body !== "object" || !body.type) {
      res.status(400).json({ error: "请求体必须包含 type 字段" });
      return;
    }

    // 载荷里商品详情可能很大（描述 HTML + SKU 明细），不再压一道，信任 json 中间件的 2mb 上限
    const result = dispatchIngest(body);
    if (result.ok) {
      res.json(result);
    } else {
      res.status(400).json({ error: String(result.note ?? "处理失败") });
    }
  }),
);

competitorRouter.get(
  "/products",
  handle((req, res) => {
    res.json(
      queryProducts({
        q: str(req.query.q),
        tag: str(req.query.tag),
        page: int(req.query.page),
        pageSize: int(req.query.pageSize),
      }),
    );
  }),
);

competitorRouter.get(
  "/products/:shopId/:itemId",
  handle((req, res) => {
    const product = getProduct(req.params.shopId, req.params.itemId);
    if (!product) {
      res.status(404).json({ error: "竞品商品不存在" });
      return;
    }
    res.json(product);
  }),
);

/** 删除单条竞品（只删 DB 索引行，落盘原始文件保留，可从源头恢复） */
competitorRouter.delete(
  "/products/:shopId/:itemId",
  handle((req, res) => {
    if (!deleteProduct(req.params.shopId, req.params.itemId)) {
      res.status(404).json({ error: "竞品商品不存在" });
      return;
    }
    res.json({ ok: true });
  }),
);
