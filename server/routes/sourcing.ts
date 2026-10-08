/**
 * 采集接口：/api/sourcing
 *
 * 逻辑全部委托给 server/sourcing/ 下的仓储与转存模块，本文件只做 HTTP 编解码。
 * 注意路径顺序：静态段（/offers、/stats、/lookup）与动态段（/offers/:id）
 * 分属不同前缀，不存在 products.ts 里那种 "batch 必须排在 :id 之前" 的问题。
 */
import { Router } from "express";
import type { CollectedOffer, SourcingQuery } from "../../src/types";
import { arr, handle, int, str } from "../lib/params";
import { requireCollectToken } from "../sourcing/auth";
import { awaitInFlight, ingestOfferImages, removeOfferFiles, scheduleIngest } from "../sourcing/images";
import {
  deleteSourcingOffer,
  findOfferByPlatformOffer,
  getSourcingOfferById,
  getSourcingStats,
  querySourcingOffers,
  resetImagesToPending,
  saveOffer,
} from "../sourcing/repository";

/**
 * 鉴权范围：**只有 collect 需要 X-Collect-Token**。
 *
 * 理由：collect 是唯一暴露给浏览器扩展的外部写入面，token 挡的是
 * 「任何能访问到这个服务的人往库里灌数据」。
 *
 * 其余写入（reingest / delete）是管理端操作，不设 token，因为这在本项目里
 * 是**一致的**选择 —— 现有 /api/products、/api/categories 的删除同样裸奔，
 * 整个后台目前没有登录态。而且把 token 塞进前端 JS 并不构成安全边界：
 * 能加载页面的人就能从源码里读到它，那只是安全表演。
 *
 * 等将来给后台加了真正的登录鉴权，这些路由一并纳入即可。
 */
export const sourcingRouter = Router();

/**
 * 载荷里禁止出现的字段名。
 *
 * 这是数据最小化原则的**兜底防线**，不是主要防线 —— 主要防线在扩展侧
 * （不申请 cookies 权限、逐字段构造载荷）。但接口是唯一入口，一旦有人
 * 图省事把整个页面对象 postMessage 过来，这里必须拦住，而不是默默存进库。
 */
const FORBIDDEN_KEY =
  /cookie|set-cookie|session|authorization|passwd|password|secret|csrf|_m_h5_tk|^token$|access_token|refresh_token/i;

/** 递归找载荷里有没有不该出现的字段，返回命中的键名 */
function findSensitiveKey(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSensitiveKey(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) return key;
    const hit = findSensitiveKey(child, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/**
 * 扩展上报入口。
 *
 * 立即返回、不等图片下载完 —— 一个商品十几张图，同步下载会把扩展的请求
 * 挂十几秒。图片在后台跑，状态先落 pending。
 */
sourcingRouter.post(
  "/collect",
  requireCollectToken,
  handle((req, res) => {
    const body = req.body as CollectedOffer | undefined;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "请求体必须是 JSON 对象" });
      return;
    }

    const hit = findSensitiveKey(body);
    if (hit) {
      console.warn(`[sourcing] 拒绝采集载荷：含敏感字段 "${hit}"`);
      res.status(400).json({
        error: `载荷包含不该上报的字段「${hit}」。采集只应上报白名单字段，请勿整体上报页面对象。`,
      });
      return;
    }

    const result = saveOffer(body, "extension");
    scheduleIngest(result.id);

    const offer = getSourcingOfferById(result.id);
    console.log(
      `[sourcing] ${result.action === "created" ? "新增" : "更新"}货源 ${result.id}「${offer?.title ?? body.title ?? ""}」`,
    );

    res.status(result.action === "created" ? 201 : 200).json({ offer, action: result.action });
  }),
);

/** 重跑图片转存。用于失败重试，也用于服务器重启后捞回卡住的记录 */
sourcingRouter.post(
  "/offers/:id/reingest",
  handle((req, res) => {
    const offer = getSourcingOfferById(req.params.id);
    if (!offer) {
      res.status(404).json({ error: `货源不存在: ${req.params.id}` });
      return;
    }

    // 先等在跑的那次结束再重置 —— 否则它的结果会覆盖刚重置出的 pending，
    // 重试就静默失效了
    awaitInFlight(req.params.id)
      .then(() => {
        const reset = resetImagesToPending(req.params.id);
        scheduleIngest(req.params.id);
        res.json({ ok: true, resetImages: reset });
      })
      .catch((error) => {
        console.error("[sourcing] 重新转存失败", error);
        res.status(500).json({ error: "重新转存失败" });
      });
  }),
);

/** 同步版重跑，等图片真正下完再返回。供 curl 联调时确认结果用 */
sourcingRouter.post(
  "/offers/:id/reingest-sync",
  handle((req, res) => {
    const offer = getSourcingOfferById(req.params.id);
    if (!offer) {
      res.status(404).json({ error: `货源不存在: ${req.params.id}` });
      return;
    }

    awaitInFlight(req.params.id)
      .then(() => {
        resetImagesToPending(req.params.id);
        return ingestOfferImages(req.params.id);
      })
      // stats 里也有个 ok 字段（成功张数），所以显式改名，避免被展开覆盖
      .then((stats) => res.json({ ok: true, succeeded: stats.ok, failed: stats.failed }))
      .catch((error) => {
        console.error("[sourcing] 同步转存失败", error);
        res.status(500).json({ error: "图片转存失败" });
      });
  }),
);

sourcingRouter.delete(
  "/offers/:id",
  handle((req, res) => {
    if (!deleteSourcingOffer(req.params.id)) {
      res.status(404).json({ error: `货源不存在: ${req.params.id}` });
      return;
    }
    // 库里删干净了，磁盘上的图片目录也要一起清掉
    removeOfferFiles(req.params.id);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ *
 * 只读
 * ------------------------------------------------------------------ */

sourcingRouter.get(
  "/offers",
  handle((req, res) => {
    res.json(
      querySourcingOffers({
        q: str(req.query.q),
        platform: str(req.query.platform) as SourcingQuery["platform"],
        imageStatus: str(req.query.imageStatus) as SourcingQuery["imageStatus"],
        sortBy: str(req.query.sortBy) as SourcingQuery["sortBy"],
        sortDir: str(req.query.sortDir) as SourcingQuery["sortDir"],
        page: int(req.query.page),
        pageSize: int(req.query.pageSize),
      }),
    );
  }),
);

/**
 * 扩展上报前的查重。
 *
 * 单独开一个接口而不是复用 /offers?q=：q 会同时搜标题和供应商，
 * 用户采集一个标题里恰好含该数字串的商品时会误判「已采集」。
 * 这里按 (platform, offerId) 精确匹配，语义明确且便宜。
 */
sourcingRouter.get(
  "/lookup",
  handle((req, res) => {
    const offerId = str(req.query.offerId);
    if (!offerId) {
      res.status(400).json({ error: "缺少 offerId" });
      return;
    }
    const platform = str(req.query.platform) ?? "1688";
    const found = findOfferByPlatformOffer(platform, offerId);
    res.json({ exists: !!found, offer: found ?? null });
  }),
);

sourcingRouter.get(
  "/stats",
  handle((_req, res) => {
    res.json(getSourcingStats());
  }),
);

sourcingRouter.get(
  "/offers/:id",
  handle((req, res) => {
    const offer = getSourcingOfferById(req.params.id);
    if (!offer) {
      res.status(404).json({ error: `货源不存在: ${req.params.id}` });
      return;
    }
    res.json(offer);
  }),
);

/** 批量删除，形状对齐 products 的 /batch */
sourcingRouter.post(
  "/offers/batch-delete",
  handle((req, res) => {
    const ids = arr(req.body?.ids);
    if (!ids.length) {
      res.status(400).json({ error: "ids 不能为空" });
      return;
    }
    const affected = ids.filter((id) => {
      const ok = deleteSourcingOffer(id);
      if (ok) removeOfferFiles(id);
      return ok;
    }).length;
    res.json({ affected });
  }),
);
