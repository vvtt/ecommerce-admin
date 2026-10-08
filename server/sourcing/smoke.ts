/**
 * 采集域仓储层冒烟测试 —— `npm run test:sourcing`。
 *
 * 存在的理由：`tsc --noEmit` 查不出 SQL 的语法、约束、外键与聚合错误，
 * 而这些恰恰是这一层最容易出错的地方。本脚本在临时目录里开一个真库，
 * 跑完整生命周期（入库 → 幂等重采 → 状态重算 → 查询筛选 → 级联删除）。
 * 首次运行即抓出两个 bug：图片行未按 offer 隔离导致撞主键、
 * 价格区间漏算了 SKU 价。
 *
 * 用临时目录而不是项目里的 db.sqlite —— 不能碰开发数据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sourcing-smoke-"));
process.env.SOURCING_DATA_DIR = tmp;

const { saveOffer, querySourcingOffers, getSourcingOfferById, getSourcingStats, deleteSourcingOffer, listImagesByOffer, markImageResult, refreshOfferImageStatus, getRawPayload } =
  await import("./repository.ts");
const { getDb, closeDb } = await import("./client.ts");

const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "docs/fixtures/offer-sample.json"), "utf8"),
);

/** 详情必须存在，不存在就直接失败 —— 省得每条断言后面都挂个 `!` */
const mustGet = (id: string) => {
  const offer = getSourcingOfferById(id);
  if (!offer) throw new Error(`详情缺失: ${id}`);
  return offer;
};

/** 原始载荷必须存在 */
const mustGetRaw = (id: string) => {
  const payload = getRawPayload(id);
  if (!payload) throw new Error(`原始载荷缺失: ${id}`);
  return payload;
};

/** 取下标，越界即失败 */
const at = <T,>(list: T[], index: number): T => {
  const value = list[index];
  if (value === undefined) throw new Error(`下标越界: ${index}`);
  return value;
};

/** 查找，找不到即失败 */
const mustFind = <T,>(list: T[], predicate: (item: T) => boolean, label: string): T => {
  const found = list.find(predicate);
  if (found === undefined) throw new Error(`找不到: ${label}`);
  return found;
};

/** 跑形如 SELECT COUNT(*) AS n 的聚合查询 */
const countOf = (sql: string, ...params: (string | number)[]): number => {
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  if (!row) throw new Error("聚合查询无返回");
  return row.n;
};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        期望 ${e}\n        实际 ${a}`}`);
}

try {
  // ---- 1. 首次入库 ----
  const first = saveOffer(fixture);
  check("首次入库 action", first.action, "created");

  const detail = mustGet(first.id);
  check("不存在的 id 返回 undefined", getSourcingOfferById("so_1688_nope"), undefined);
  check("阶梯价条数", detail.priceLadder.length, 3);
  check("末档无 endAmount", detail.priceLadder[2].endAmount, undefined);
  check("规格维度", detail.specDimensions.map((d) => d.name), ["颜色", "规格"]);
  check("规格取值", detail.specDimensions[0].values, ["黑色", "白色", "粉色"]);
  check("SKU 数", detail.skus.length, 4);
  check("SKU 规格值", detail.skus[0].specValues, { 颜色: "黑色", 规格: "标准版" });
  check("属性数", detail.attributes.length, 6);
  // 主图 3 + 详情图 2 + SKU 图 3（第 4 个 SKU 无图）= 8
  check("图片总数", detail.images.length, 8);
  check("主图排最前", detail.images.slice(0, 3).every((i) => i.kind === "main"), true);
  check("价格区间", [detail.priceMin, detail.priceMax], [22.4, 36]);
  check("起订量", detail.moq, 2);
  check("初始转存状态", detail.imageStatus, "pending");
  check("缩略图为空(尚未转存)", detail.thumbnail, "");
  check("供应商", detail.supplier.name, "深圳市恒通电子有限公司");

  // ---- 2. 幂等：同载荷再采一次 ----
  const second = saveOffer(fixture);
  check("重复采集 action", second.action, "updated");
  check("重复采集 id 不变", second.id, first.id);
  check("列表总数仍为 1", getSourcingStats().total, 1);
  check("明细未重复(SKU)", mustGet(first.id).skus.length, 4);
  check("明细未重复(图片)", listImagesByOffer(first.id).length, 8);

  // ---- 3. 转存状态重算 ----
  const images = listImagesByOffer(first.id);
  markImageResult(at(images, 0).id, { status: "ok", localPath: "/uploads/sourcing/x/a.jpg", bytes: 1024 });
  refreshOfferImageStatus(first.id);
  check("一成一待 → pending", mustGet(first.id).imageStatus, "pending");

  // 其余全标失败（最后一张标 ok，以构造 partial）
  images.slice(1).forEach((img, i) => {
    if (i === 0) markImageResult(img.id, { status: "ok", localPath: "/uploads/sourcing/x/b.jpg", bytes: 2048 });
    else markImageResult(img.id, { status: "failed", error: "HTTP 403" });
  });
  refreshOfferImageStatus(first.id);
  const afterPartial = mustGet(first.id);
  check("有成有败 → partial", afterPartial.imageStatus, "partial");
  check("成功计数", afterPartial.imageOkCount, 2);
  check("失败计数", afterPartial.imageFailCount, 6);
  check("缩略图取首张成功主图", afterPartial.thumbnail, "/uploads/sourcing/x/a.jpg");
  check("失败原因留存", mustFind(afterPartial.images, (i) => i.status === "failed", "失败图").error, "HTTP 403");

  // ---- 4. 全失败 → failed ----
  images.forEach((img) => markImageResult(img.id, { status: "failed", error: "boom" }));
  refreshOfferImageStatus(first.id);
  check("全失败 → failed", mustGet(first.id).imageStatus, "failed");

  // ---- 5. 重复采集时已成功的图不该被打回 ----
  const okImages = listImagesByOffer(first.id);
  markImageResult(at(okImages, 0).id, { status: "ok", localPath: "/uploads/sourcing/x/keep.jpg", bytes: 999 });
  refreshOfferImageStatus(first.id);
  saveOffer(fixture); // 重新采集
  const afterRecollect = listImagesByOffer(first.id);
  check("重采后图片数不变", afterRecollect.length, 8);
  check(
    "已转存成功的图保住了 local_path",
    afterRecollect.filter((i) => i.local_path === "/uploads/sourcing/x/keep.jpg").length,
    1,
  );
  check(
    "失败的图被打回 pending 重试",
    afterRecollect.filter((i) => i.status === "pending").length,
    7,
  );

  // ---- 6. 原始载荷可回读 ----
  const raw = mustGetRaw(first.id);
  check("raw_json 可回读且是我们自己的结构", raw.offerId, fixture.offerId);
  check("raw_json 不含页面对象特征字段", "window" in raw || "cookie" in raw, false);

  // ---- 7. 列表查询 ----
  // B 故意沿用同一批图片 URL：同供应商的多条货源共用详情图是常态，
  // 图片行必须按 offer 隔离，否则第二条入库就撞主键。
  const shared = saveOffer({
    ...fixture,
    offerId: "700000000001",
    title: "折叠收纳箱 大容量 户外露营",
    moq: 50,
    priceLadder: [{ beginAmount: 50, price: 88 }],
    skus: [],
  });
  check("共用图片 URL 的第二条货源可入库", shared.action, "created");
  // B 的 skus 为空，故没有 SKU 图：主图 3 + 详情图 2 = 5
  check("第二条货源有自己的图片行", listImagesByOffer(shared.id).length, 5);
  check("两条货源的图片行互不相同", (() => {
    const a = new Set(listImagesByOffer(first.id).map((i) => i.id));
    return listImagesByOffer(shared.id).every((i) => !a.has(i.id));
  })(), true);

  // C 与前两条完全不同：别的供应商、无图、无 SKU。用途有两个 ——
  // 让筛选/排序真正有区分度（而不是碰巧选中所有行），
  // 以及覆盖「零图片不该永远卡在 pending」。
  const noImg = saveOffer({
    ...fixture,
    offerId: "800000000001",
    title: "硅胶厨具套装 耐高温",
    supplier: { name: "义乌市博远家居用品厂", location: "浙江 义乌" },
    moq: 10,
    priceLadder: [{ beginAmount: 10, price: 5.5 }],
    skus: [],
    images: { main: [], detail: [] },
  });
  check("无图货源状态为 ok", mustGet(noImg.id).imageStatus, "ok");

  const list = querySourcingOffers({});
  check("列表总数", list.total, 3);
  check("默认分页", [list.page, list.pageSize], [1, 10]);

  check("关键词命中标题", querySourcingOffers({ q: "蓝牙" }).total, 1);
  check("关键词命中 offerId", querySourcingOffers({ q: "700000000001" }).total, 1);
  check("关键词命中供应商", querySourcingOffers({ q: "恒通" }).total, 2);
  check("关键词命中另一供应商", querySourcingOffers({ q: "博远" }).total, 1);
  check("关键词无命中", querySourcingOffers({ q: "不存在的词" }).total, 0);
  check("平台筛选", querySourcingOffers({ platform: "1688" }).total, 3);
  check("图片状态筛选 pending", querySourcingOffers({ imageStatus: "pending" }).total, 2);
  check("图片状态筛选 ok", querySourcingOffers({ imageStatus: "ok" }).total, 1);
  check("图片状态筛选 failed", querySourcingOffers({ imageStatus: "failed" }).total, 0);

  // 三条的价格互不相同（5.5 / 22.4 / 88），排序结果才有判别力
  const byPrice = querySourcingOffers({ sortBy: "priceMin", sortDir: "asc" });
  check("按最低价升序", byPrice.items.map((i) => i.priceMin), [5.5, 22.4, 88]);
  const byPriceDesc = querySourcingOffers({ sortBy: "priceMin", sortDir: "desc" });
  check("按最低价降序", byPriceDesc.items.map((i) => i.priceMin), [88, 22.4, 5.5]);
  const byMoq = querySourcingOffers({ sortBy: "moq", sortDir: "desc" });
  check("按起订量降序", byMoq.items.map((i) => i.moq), [50, 10, 2]);
  check("按标题升序", querySourcingOffers({ sortBy: "title", sortDir: "asc" }).items.length, 3);

  check("筛选与关键词叠加", querySourcingOffers({ q: "恒通", imageStatus: "pending" }).total, 2);
  check("分页切片", querySourcingOffers({ pageSize: 1, page: 2 }).items.length, 1);
  check("分页超出范围返回空", querySourcingOffers({ pageSize: 10, page: 99 }).items.length, 0);

  // ---- 8. 统计 ----
  const stats = getSourcingStats();
  check("统计总数", stats.total, 3);
  check("今日新增", stats.todayNew, 3);
  check("图片待转存数", stats.imagePending, 2);
  check("图片失败数", stats.imageFailed, 0);

  // ---- 9. 级联删除 + 日志留存 ----
  // A 创建 + A 两次更新（重采 + 步骤 5 的重采）+ B 创建 + C 创建 = 5
  const logsBefore = countOf("SELECT COUNT(*) AS n FROM sourcing_collect_logs");
  check("已记录 5 次采集日志", logsBefore, 5);
  check("删除返回 true", deleteSourcingOffer(first.id), true);
  check("删除不存在返回 false", deleteSourcingOffer("so_1688_nope"), false);
  check("删除后列表减一", getSourcingStats().total, 2);
  check(
    "明细行被级联清掉",
    countOf("SELECT COUNT(*) AS n FROM sourcing_skus WHERE offer_id = ?", first.id),
    0,
  );
  check(
    "图片行被级联清掉",
    countOf("SELECT COUNT(*) AS n FROM sourcing_images WHERE offer_id = ?", first.id),
    0,
  );
  check(
    "采集日志未随货源删除",
    countOf("SELECT COUNT(*) AS n FROM sourcing_collect_logs"),
    logsBefore,
  );

  // ---- 10. 图片转存 ----
  // 用本地 HTTP 服务模拟 CDN 的几种响应，不依赖外网，也就能稳定跑。
  // 重点验证「200 + HTML 错误页」这种防盗链情形不会被当成图片存下来。
  const { createServer } = await import("node:http");
  const { ingestOfferImages, normalizeImageUrl } = await import("./images.ts");
  const { UPLOAD_DIR } = await import("./client.ts");

  const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);

  let sawReferer: string | undefined;
  let sawUserAgent: string | undefined;
  const server = createServer((req, res) => {
    sawReferer = req.headers.referer;
    sawUserAgent = req.headers["user-agent"];
    if (req.url === "/ok.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG);
    } else if (req.url === "/ok.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(JPEG);
    } else if (req.url === "/blocked") {
      // 防盗链最常见的样子：200，但返回的是一页 HTML
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>forbidden</body></html>");
    } else if (req.url === "/forbidden.jpg") {
      res.writeHead(403);
      res.end("nope");
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const imgOffer = saveOffer({
    ...fixture,
    offerId: "900000000001",
    title: "图片转存验证",
    images: {
      main: [`${base}/ok.jpg`, `${base}/blocked`, `${base}/forbidden.jpg`],
      detail: [`${base}/ok.png`],
    },
    skus: [],
  });

  const imgResult = await ingestOfferImages(imgOffer.id);
  check("转存成功 2 张", imgResult.ok, 2);
  check("转存失败 2 张", imgResult.failed, 2);
  check("下载时带了 Referer", sawReferer, "https://detail.1688.com/");
  check("下载时带了桌面 UA", (sawUserAgent ?? "").includes("Chrome"), true);

  const imgDetail = mustGet(imgOffer.id);
  check("有成有败 → partial", imgDetail.imageStatus, "partial");

  const blocked = mustFind(imgDetail.images, (i) => i.sourceUrl.endsWith("/blocked"), "防盗链图");
  check("200+HTML 的防盗链响应被判为失败", blocked.status, "failed");
  check("并给出可读的失败原因", (blocked.error ?? "").includes("防盗链"), true);
  check(
    "403 记为失败",
    mustFind(imgDetail.images, (i) => i.sourceUrl.endsWith("/forbidden.jpg"), "403 图").status,
    "failed",
  );

  const okJpg = mustFind(imgDetail.images, (i) => i.sourceUrl.endsWith("/ok.jpg"), "ok.jpg");
  const okPng = mustFind(imgDetail.images, (i) => i.sourceUrl.endsWith("/ok.png"), "ok.png");
  check(
    "localPath 形如 /uploads/{offerId}/{hash}.jpg",
    /^\/uploads\/so_1688_900000000001\/[0-9a-f]{16}\.jpg$/.test(okJpg.localPath),
    true,
  );
  check("扩展名按 content-type 判定而非 URL", okPng.localPath.endsWith(".png"), true);
  check("记录了文件体积", okJpg.bytes, JPEG.length);

  const diskFile = path.join(UPLOAD_DIR, "so_1688_900000000001", path.basename(okJpg.localPath));
  check("文件真的落到了磁盘", fs.existsSync(diskFile), true);
  check("落盘内容与响应一致", fs.readFileSync(diskFile).length, JPEG.length);

  // 重复转存不该重新下载已经成功的图（inFlight 之外还要看状态是否被打回）
  const again = await ingestOfferImages(imgOffer.id);
  check("已完成的图不会被重复下载", again.ok, 0);

  // 协议相对地址的补全
  check("// 开头补 https:", normalizeImageUrl("//cbu01.alicdn.com/a.jpg"), "https://cbu01.alicdn.com/a.jpg");
  check("已是 https 的不动", normalizeImageUrl("https://x/a.jpg"), "https://x/a.jpg");

  // 孤儿文件清理：重采后只剩一张图，磁盘上不再被引用的应被删掉
  const dir = path.join(UPLOAD_DIR, "so_1688_900000000001");
  check("重采前磁盘上有 2 个文件", fs.readdirSync(dir).length, 2);
  saveOffer({
    ...fixture,
    offerId: "900000000001",
    title: "图片转存验证",
    images: { main: [`${base}/ok.jpg`], detail: [] },
    skus: [],
  });
  await ingestOfferImages(imgOffer.id);
  check("重采后孤儿文件被清理", fs.readdirSync(dir).length, 1);

  server.close();
} catch (error) {
  failures++;
  console.log("FATAL", error);
} finally {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
