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
import { collectOfferFromUrl, resolveOfferId } from "../sourcing/autocollect";
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
 * 鉴权：collect 不再要求 X-Collect-Token（2026-10-24 用户决策）。
 *
 * 本服务只在 localhost 单人使用，与其他写入接口（/api/products 的删除等）
 * 保持一致的开放策略；载荷敏感字段校验（findSensitiveKey）仍然保留。
 * 等将来服务暴露公网或加了登录鉴权，再给写入路由统一挂中间件。
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

/**
 * APP 链接自动采集 → 妙手 ERP（2026-10-28）：丢一个 1688 分享链接进来，
 * 服务端解析 offerId → 比特指纹窗口开新标签打开 PC 详情页 →
 * 自动点妙手 ERP 插件采集条的「采集此商品」按钮，商品进妙手采集箱。
 * 用户拍板（同日）：不点工具箱「采集到货源库」、不直连接口，走按钮点击。
 * 耗时约 40~90 秒（等页面渲染+妙手远程包挂载），HTTP 请求挂起至跑完才返回。
 *
 * 设计与坑见 server/sourcing/autocollect.ts 顶部注释。
 */
sourcingRouter.post(
  "/collect-from-url",
  handle((req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "缺少 url 字段（支持 qr.1688.com 短链 / m.1688.com / detail.1688.com 链接）" });
      return;
    }
    // 先快速解析 offerId，链接不合法当场报错，不浪费一次浏览器拉起
    resolveOfferId(url)
      .then(({ offerId }) => {
        console.log(`[sourcing] 自动采集开始：offerId=${offerId}`);
        return collectOfferFromUrl(url);
      })
      .then((result) => {
        console.log(
          `[sourcing] 自动采集完成：offerId=${result.offerId} ` +
            `妙手=${result.mishou.clicked ? result.mishou.feedback ?? "已点击" : "未点击"}`,
        );
        res.json({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("[sourcing] 自动采集失败：", error instanceof Error ? error.message : error);
        res.status(502).json({ error: error instanceof Error ? error.message : "自动采集失败" });
      });
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
