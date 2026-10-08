/**
 * 服务入口。
 *
 * 开发：用 tsx 直跑本文件，挂 Vite middleware 提供 HMR + SPA 路由回退。
 * 生产：esbuild 打包为 dist/server.cjs，改由 express.static 提供 dist/ 静态资源。
 *
 * 启动：npm run dev（tsx server/index.ts）
 */
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { getOverview } from "../shared/queries";
import { categoriesRouter } from "./routes/categories";
import { authRouter, requireApiAuth } from "./routes/auth";
import { competitorRouter } from "./routes/competitor";
import { inventoryRouter } from "./routes/inventory";
import { productsRouter } from "./routes/products";
import { purchaseRouter } from "./routes/purchase";
import { sourcingRouter } from "./routes/sourcing";
import { describeCollectToken } from "./sourcing/auth";
import { UPLOAD_DIR } from "./sourcing/client";
import { ingestStuckPending } from "./sourcing/images";

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const app = express();

  // 采集载荷带 SKU 明细与图片 URL 列表，比普通表单大得多，默认 100kb 会截断
  app.use(express.json({ limit: "2mb" }));

  /* ---------------- API ---------------- */

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/overview", (_req, res) => {
    res.json(getOverview());
  });

  app.use("/api/auth", authRouter);

  // 全局 API 鉴权：除豁免名单（探活/登录/插件上报面）外都要 Bearer token。
  // 必须挂在各业务路由之前才能拦得住 —— 顺序就是权限。
  app.use("/api", requireApiAuth);

  app.use("/api/products", productsRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/inventory", inventoryRouter);
  app.use("/api/purchase-orders", purchaseRouter);
  app.use("/api/sourcing", sourcingRouter);
  app.use("/api/competitor", competitorRouter);

  // 未匹配到的 /api/* 返回 404 JSON，避免被下面的 SPA 回退吞成 index.html
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "接口不存在" });
  });

  /* ---------------- 采集图片 ---------------- */

  // 文件名是源 URL 的哈希，内容永不改变，所以可以长缓存 + immutable。
  // fallthrough: false 让缺失的图片老实返回 404 —— 默认的 true 会让它掉进
  // 下面的 SPA 回退，变成 200 + index.html，前端看到的是一个"成功但解不开"的响应。
  app.use(
    "/uploads",
    express.static(UPLOAD_DIR, { maxAge: "365d", immutable: true, fallthrough: false })
  );

  /* ---------------- 前端 ---------------- */

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`跨境电商后台已启动 → http://localhost:${PORT}`);
    console.log(`[sourcing] ${describeCollectToken()}`);

    // 上次进程如果在图片下完之前被杀，主表会停在 pending 且不会再有上报来触发。
    // 启动时补跑一轮即可自愈。异步执行，不阻塞启动。
    void ingestStuckPending().catch((error) => {
      console.error("[sourcing] 启动补跑图片转存失败", error);
    });
  });
}

startServer();
