/**
 * 商品接口：/api/products
 * 逻辑全部委托给 shared/queries.ts 与 shared/mutations.ts，本文件只做 HTTP 编解码。
 */
import { Router } from "express";
import type { ProductQuery } from "../../shared/queries";
import { getProductById, queryProducts } from "../../shared/queries";
import {
  batchDeleteProducts,
  batchUpdateProductStatus,
  createProduct,
  deleteProduct,
  updateProduct,
} from "../../shared/mutations";
import type { ProductInput } from "../../shared/mutations";
import { arr, handle, int, str } from "../lib/params";

export const productsRouter = Router();

productsRouter.get(
  "/",
  handle((req, res) => {
    res.json(
      queryProducts({
        q: str(req.query.q),
        status: str(req.query.status) as ProductQuery["status"],
        categoryId: str(req.query.categoryId),
        sortBy: str(req.query.sortBy) as ProductQuery["sortBy"],
        sortDir: str(req.query.sortDir) as ProductQuery["sortDir"],
        page: int(req.query.page),
        pageSize: int(req.query.pageSize),
      })
    );
  })
);

productsRouter.post(
  "/",
  handle((req, res) => {
    res.status(201).json(createProduct(req.body as ProductInput));
  })
);

/** 批量操作，必须注册在 /:id 之前 */
productsRouter.post(
  "/batch",
  handle((req, res) => {
    const ids = arr(req.body?.ids);
    const action = str(req.body?.action);
    if (!ids.length) {
      res.status(400).json({ error: "ids 不能为空" });
      return;
    }

    if (action === "activate") {
      res.json({ affected: batchUpdateProductStatus(ids, "on_sale") });
    } else if (action === "deactivate") {
      res.json({ affected: batchUpdateProductStatus(ids, "off_shelf") });
    } else if (action === "delete") {
      res.json({ affected: batchDeleteProducts(ids) });
    } else {
      res.status(400).json({ error: `不支持的批量操作: ${action}` });
    }
  })
);

productsRouter.get(
  "/:id",
  handle((req, res) => {
    const product = getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: `商品不存在: ${req.params.id}` });
      return;
    }
    res.json(product);
  })
);

productsRouter.put(
  "/:id",
  handle((req, res) => {
    const product = updateProduct(req.params.id, req.body as ProductInput);
    if (!product) {
      res.status(404).json({ error: `商品不存在: ${req.params.id}` });
      return;
    }
    res.json(product);
  })
);

productsRouter.delete(
  "/:id",
  handle((req, res) => {
    if (!deleteProduct(req.params.id)) {
      res.status(404).json({ error: `商品不存在: ${req.params.id}` });
      return;
    }
    res.json({ ok: true });
  })
);
