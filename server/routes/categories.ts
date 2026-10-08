/** 类目接口：/api/categories */
import { Router } from "express";
import { getCategoryTree } from "../../shared/queries";
import { handle } from "../lib/params";

export const categoriesRouter = Router();

categoriesRouter.get(
  "/",
  handle((_req, res) => {
    res.json({ items: getCategoryTree() });
  })
);
