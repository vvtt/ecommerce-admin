/**
 * 库存接口：/api/inventory
 * 注意路由注册顺序：/movements 与 /summary 要先于可能的动态段。
 */
import { Router } from "express";
import type { InventoryQuery, MovementQuery } from "../../shared/queries";
import {
  getInventorySummary,
  queryInventory,
  queryMovements,
} from "../../shared/queries";
import { adjustStock } from "../../shared/mutations";
import type { AdjustStockInput } from "../../shared/mutations";
import { handle, int, str } from "../lib/params";

export const inventoryRouter = Router();

inventoryRouter.get(
  "/",
  handle((req, res) => {
    res.json(
      queryInventory({
        q: str(req.query.q),
        warehouse: str(req.query.warehouse) as InventoryQuery["warehouse"],
        health: str(req.query.health) as InventoryQuery["health"],
        sortBy: str(req.query.sortBy) as InventoryQuery["sortBy"],
        sortDir: str(req.query.sortDir) as InventoryQuery["sortDir"],
        page: int(req.query.page),
        pageSize: int(req.query.pageSize),
      })
    );
  })
);

inventoryRouter.get(
  "/summary",
  handle((_req, res) => {
    res.json(getInventorySummary());
  })
);

inventoryRouter.get(
  "/movements",
  handle((req, res) => {
    res.json(
      queryMovements({
        q: str(req.query.q),
        type: str(req.query.type) as MovementQuery["type"],
        warehouse: str(req.query.warehouse) as MovementQuery["warehouse"],
        page: int(req.query.page),
        pageSize: int(req.query.pageSize),
      })
    );
  })
);

inventoryRouter.post(
  "/adjust",
  handle((req, res) => {
    res.json(adjustStock(req.body as AdjustStockInput));
  })
);
