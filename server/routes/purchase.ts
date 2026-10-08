/** 采购补货接口：/api/purchase-orders */
import { Router } from "express";
import type { PurchaseQuery } from "../../shared/queries";
import { getPurchaseOrderById, queryPurchaseOrders } from "../../shared/queries";
import { createPurchaseOrder, transitionPurchaseOrder } from "../../shared/mutations";
import type { PurchaseOrderInput } from "../../shared/mutations";
import type { PurchaseStatus } from "../../src/types";
import { handle, int, str } from "../lib/params";

export const purchaseRouter = Router();

purchaseRouter.get(
  "/",
  handle((req, res) => {
    res.json(
      queryPurchaseOrders({
        q: str(req.query.q),
        status: str(req.query.status) as PurchaseQuery["status"],
        warehouse: str(req.query.warehouse) as PurchaseQuery["warehouse"],
        page: int(req.query.page),
        pageSize: int(req.query.pageSize),
      })
    );
  })
);

purchaseRouter.post(
  "/",
  handle((req, res) => {
    res.status(201).json(createPurchaseOrder(req.body as PurchaseOrderInput));
  })
);

purchaseRouter.get(
  "/:id",
  handle((req, res) => {
    const order = getPurchaseOrderById(req.params.id);
    if (!order) {
      res.status(404).json({ error: `采购单不存在: ${req.params.id}` });
      return;
    }
    res.json(order);
  })
);

purchaseRouter.post(
  "/:id/transition",
  handle((req, res) => {
    const next = str(req.body?.status) as PurchaseStatus | undefined;
    if (!next) {
      res.status(400).json({ error: "必须提供目标状态 status" });
      return;
    }
    const order = transitionPurchaseOrder(req.params.id, next, str(req.body?.operator));
    if (!order) {
      res.status(404).json({ error: `采购单不存在: ${req.params.id}` });
      return;
    }
    res.json(order);
  })
);
