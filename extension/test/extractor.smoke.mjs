/**
 * extractor 冒烟测试。
 *
 * **这份 fixture 是照 docs/1688-probe.md 的 §9 字段映射表手工搭的**，
 * 不是从 main-world.js 反推的 —— 否则就是拿代码测代码，什么都测不出来。
 * 它验的是「extractor 有没有按 §9 的表去读」，**不是**「§9 的表对不对」。
 * 表本身的正确性只能靠真机页面，那一步在联调时做。
 *
 * 能抓到的问题：路径写错、键名拼错、类型没转、禁止采集的字段漏出去。
 * 抓不到的问题：1688 改版、§9 记错。
 *
 * 跑法：node extension/test/extractor.smoke.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_WORLD = join(here, "..", "main-world.js");

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

const check = (name, condition, detail = "") => {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  → ${detail}` : ""}`);
  }
};

const eq = (name, actual, expected) =>
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);

/* ------------------------------------------------------------------ *
 * fixture —— 严格照 §9 的表构造
 * ------------------------------------------------------------------ */

const SPEC_A = "【水果-菠萝】USB充电款";
const SPEC_B = "【小花--粉色】USB充电款";
const SPEC_C = "充电款风扇【随机1个】";

/** 采集者本人的标识，§9.7 规定一律不得出现在载荷里 */
const COLLECTOR_LOGIN = "amusement11";
const COLLECTOR_IP = "38.46.220.45";

const windowContext = {
  result: {
    // §9.8 来源 1：属性在 result.global，**不在** result.data
    global: {
      globalData: {
        model: {
          offerDetail: {
            featureAttributes: [
              { fid: 21594, name: "附加功能", value: "静音", values: ["静音"] },
              { fid: 1001, name: "材质", value: "塑料", values: ["塑料"] },
              { fid: 1002, name: "货号", value: "F001", values: ["F001"] },
            ],
          },
        },
      },
    },
    data: {
      // §9.2 价格模式
      mainPrice: {
        fields: {
          priceModel: {
            priceDisplayType: "skuPrice",
            // ⚠️ 这两项是 [最低价, 最高价] 端点，不是数量阶梯。beginAmount 恒为 1
            currentPrices: [
              { price: "2.21", beginAmount: 1 },
              { price: "5.37", beginAmount: 1 },
            ],
            originalPrices: [
              { price: "2.80", beginAmount: 1 },
              { price: "6.80", beginAmount: 1 },
            ],
          },
          // ⚠️ 这里的 beginAmount 是 **string**，与上面 number 的不同（§9.6）
          originalPricesWithoutPromotion: [{ price: "2.80", beginAmount: "1" }],
        },
      },

      // §9.1 标题**不在 dataJson 下**
      productTitle: {
        fields: {
          title: "跨境爆款手持小风扇 USB充电迷你风扇 学生宿舍便携静音",
          saleNum: "10万+", // ⚠️ 展示文本，不能用
          unit: "件",
          shopInfo: { companyName: "广州胜丰玩具有限公司" },
        },
      },

      // §9.4 详情长图入口
      description: { fields: { detailUrl: "https://itemcdn.tmall.com/1688offer/icossfaketest", detailVideoId: "" } },

      // §9.5 重量。⚠️ 顶层 unitWeight 是 0，是废字段
      productPackInfo: {
        fields: {
          unitWeight: 0,
          pieceWeightScale: {
            pieceWeightScaleInfo: [
              { volume: 0, sku1: SPEC_A, length: 0, width: 0, weight: 120, skuId: 6046825856964, height: 0 },
              { volume: 0, sku1: SPEC_B, length: 0, width: 0, weight: 95, skuId: 6046825856956, height: 0 },
              { volume: 0, sku1: SPEC_C, length: 0, width: 0, weight: 141, skuId: 6046825856900, height: 0 },
            ],
          },
        },
      },

      // §9.8 来源 2：属性也挂在图库模块下（名字有误导性）。这里放一份**不同**的，
      // 用来确认 extractor 优先取来源 1
      gallery: {
        fields: {
          CpvEnhance: {
            decisionCpv: [{ name: "不该被用到的来源2", values: ["x"] }],
            normalCpv: [],
          },
        },
      },

      Root: {
        fields: {
          // §9 的主数据源：接口原始响应
          dataJson: {
            offerId: 1031250827028,

            // §9.9 起批量。⚠️ 同处还有 limitParam.limitNum（限购 2 件），极易取错
            orderParamModel: {
              orderParam: {
                beginNum: 1,
                saledCount: 239397,
                canBookedAmount: 55616455,
                limitParam: { limitType: "canExc", limitNum: 2 },
                supportOnePieceRetail: false,
                skuParam: { skuPriceType: "skuPrice" },
              },
            },

            // §9.7 ⛔ 采集者本人的标识 —— 载荷里出现任何一个都算 bug
            offerBaseInfo: {
              sellerWinportUrl: "https://shop9073486o761a2.1688.com",
              catId: 1047889,
              buyerUserId: 998877,
              buyerLoginId: COLLECTOR_LOGIN,
              buyerMemberId: "b2b-fake-member-id",
            },

            // §9.4 主图。⚠️ 一个元素 = 同一张图的多种尺寸
            images: [
              {
                fullPathImageURI: "https://cbu01.alicdn.com/img/ibank/main1.jpg",
                imageURI: "img/ibank/main1.jpg",
                size220x220ImageURI: "img/ibank/main1_220.jpg",
                size310x310ImageURI: "img/ibank/main1_310.jpg",
                searchImageURI: "img/ibank/main1_search.jpg",
                summImageURI: "img/ibank/main1_summ.jpg",
              },
              {
                fullPathImageURI: "https://cbu01.alicdn.com/img/ibank/main2.jpg",
                imageURI: "img/ibank/main2.jpg",
              },
              {
                // 只有相对路径（连 // 都没有）—— 测 absUrl 的兜底分支
                imageURI: "img/ibank/main3.jpg",
              },
            ],

            // §9.3 SKU。⚠️ 是 map 不是数组，键是中文规格名
            skuModel: {
              // ⚠️ 区间字符串，不是阶梯数组。extractor 不该读它
              skuPriceScale: "2.21-5.37",
              skuPriceScaleOriginal: "2.80-6.80",
              skuProps: [
                {
                  fid: 404,
                  prop: "颜色",
                  value: [
                    { name: SPEC_A, imageUrl: "//cbu01.alicdn.com/img/ibank/sku_a.jpg" },
                    { name: SPEC_B, imageUrl: "img/ibank/sku_b.jpg" },
                    { name: SPEC_C, imageUrl: "https://cbu01.alicdn.com/img/ibank/sku_c.jpg" },
                  ],
                },
              ],
              skuInfoMap: {
                [SPEC_A]: {
                  skuId: 6046825856964,
                  specAttrs: SPEC_A,
                  price: "2.90",
                  discountPrice: "2.29", // ← 应当取这个
                  canBookCount: 9873019, // ⚠️ 库存字段不是 amount
                  saleCount: 0,
                  specId: "d8bcba46aa",
                  retailPrice: "",
                  priceAmount: 1,
                  isPromotionSku: true,
                },
                [SPEC_B]: {
                  skuId: 6046825856956,
                  specAttrs: SPEC_B,
                  price: "3.50",
                  discountPrice: "", // ← 空串，应当回退到 price
                  canBookCount: 500,
                  saleCount: 0,
                  specId: "d8bcba46bb",
                  retailPrice: "",
                  priceAmount: 1,
                  isPromotionSku: false,
                },
                [SPEC_C]: {
                  skuId: 6046825856900,
                  specAttrs: SPEC_C,
                  price: "5.37",
                  discountPrice: "4.99",
                  canBookCount: 0,
                  saleCount: 0,
                  specId: "d8bcba46cc",
                  retailPrice: "",
                  priceAmount: 1,
                  isPromotionSku: true,
                },
              },
            },
          },
        },
      },
    },
  },
};

const feGlobals = {
  offerId: 1031250827028, // number，上报前要 String()
  offerLoginId: "广州胜丰玩具有限公司", // ✅ 供应商
  loginId: COLLECTOR_LOGIN, // ⛔ 采集者本人，绝不能当供应商
  clientIP: COLLECTOR_IP, // ⛔ 采集者的出口 IP
  clientDeviceId: "",
  timestamp: {},
};

/* ------------------------------------------------------------------ *
 * 最小浏览器环境
 * ------------------------------------------------------------------ */

const fakeDocument = new EventTarget();
fakeDocument.body = null;

const makeImg = (attrs) => ({ getAttribute: (name) => attrs[name] ?? null });

globalThis.window = globalThis;
globalThis.document = fakeDocument;
globalThis.location = { href: "https://detail.1688.com/offer/1031250827028.html?src=zhanwai&spm=fake" };
globalThis.window.context = windowContext;
globalThis.window.FE_GLOBALS = feGlobals;

/**
 * 详情接口的真实响应 —— 2026-09-20 实测抓回来的原文形状。
 *
 * ⚠️ 它**不是 HTML，是一段 JS**：图片 HTML 被塞在 JSON 的 content 字段里，
 * 而且中间那层引号是 **JS 转义过的**（`\"`）。首版 extractor 就是把它直接
 * 当 HTML 喂给 DOMParser，属性值里留下了 `\"`，拼出一堆必然 404 的详情图地址。
 *
 * 这份 fixture 必须**逐字保留 `\"`**，不能图省事写成普通引号 ——
 * 写成普通引号就等于把这个 bug 从测试里抹掉了（首版正是如此）。
 */
const DETAIL_BODY =
  'var offer_details={"content":"' +
  '<div id=\\"offer-template-0\\"></div>' +
  '<img style=\\"display: block;width: 100.0%;height: auto;\\" ' +
  'src=\\"https://cbu01.alicdn.com/img/ibank/detail1.jpg\\" usemap=\\"#_sdmap_0\\"/>' +
  '<img data-src=\\"img/ibank/detail2.jpg\\" usemap=\\"#_sdmap_1\\"/>' +
  '<img src=\\"https://cbu01.alicdn.com/img/ibank/detail1.jpg\\" usemap=\\"#_sdmap_2\\"/>' +
  '"}';

const detailBody = (body) => ({ ok: true, text: async () => body });

globalThis.fetch = async () => detailBody(DETAIL_BODY);

/**
 * 极简 HTML 解析器 —— 但有一点必须**如实**：不做任何 JS 反转义。
 *
 * 真正的 HTML 解析器就是这样：`\` 在 HTML 里不是转义符，所以
 * `<img src=\"https://…\">` 的属性值是 `\"https://…\"`（连反斜杠带引号）。
 * 如果这个桩"顺手"把 `\"` 解成 `"`，那它就比真浏览器善良，
 * 上面那个坑在测试里永远重现不出来。
 *
 * 同时支持无引号和单双引号三种属性写法 —— 上面那个 `\"` 走的正是
 * **无引号**分支（`src=` 后面紧跟的不是引号，而是反斜杠）。
 */
globalThis.DOMParser = class {
  parseFromString(html) {
    /** @type {Array<Record<string, string>>} */
    const attrsList = [];
    for (const tag of String(html).matchAll(/<img\b([^>]*)>/gi)) {
      /** @type {Record<string, string>} */
      const attrs = {};
      for (const a of tag[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? "";
      }
      attrsList.push(attrs);
    }
    return { querySelectorAll: () => attrsList.map(makeImg) };
  }
};

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

console.log("加载 main-world.js …");
vm.runInThisContext(readFileSync(MAIN_WORLD, "utf8"), { filename: MAIN_WORLD });

const TOKEN = "test-token-123";
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("等不到解析结果（10 秒超时）")), 10_000);
  fakeDocument.addEventListener(`__sc_data_${TOKEN}__`, (event) => {
    clearTimeout(timer);
    resolve(event.detail);
  });
  fakeDocument.dispatchEvent(new CustomEvent("__sc_sourcing_bootstrap__", { detail: { token: TOKEN } }));
});

const { offer, summary, warnings, ok } = result;

console.log("\n--- 解析结果 ---");
console.log(`ok=${ok}  title=${offer?.title ?? "(无)"}`);
console.log(`warnings=${JSON.stringify(warnings)}`);

console.log("\n--- 主体 ---");
check("ok === true", ok === true, JSON.stringify(warnings));
eq("offerId 是字符串", typeof offer.offerId, "string");
eq("offerId 值正确", offer.offerId, "1031250827028");
eq("platform", offer.platform, "1688");
check("标题取自 productTitle.fields.title（不在 dataJson 下）", offer.title.startsWith("跨境爆款手持小风扇"), offer.title);
eq("URL 丢掉 query", offer.url, "https://detail.1688.com/offer/1031250827028.html");
eq("extractorVersion", offer.extractorVersion, "1688/2");
eq("moq 取 orderParam.beginNum（不是 limitParam.limitNum）", offer.moq, 1);
check("capturedAt 是 ISO 串", /^\d{4}-\d{2}-\d{2}T/.test(offer.capturedAt), offer.capturedAt);

console.log("\n--- 数据最小化（§9.7）---");
eq("供应商取 offerLoginId", offer.supplier.name, "广州胜丰玩具有限公司");
eq("supplier.loginId 留空（拒绝采集者本人的账号）", offer.supplier.loginId, undefined);
eq("shopUrl 取 offerBaseInfo.sellerWinportUrl", offer.supplier.shopUrl, "https://shop9073486o761a2.1688.com");
const payload = JSON.stringify(offer);
check("载荷不含采集者登录名 ", !payload.includes(COLLECTOR_LOGIN));
check("载荷不含采集者 IP", !payload.includes(COLLECTOR_IP));
check("载荷不含 buyerMemberId", !payload.includes("b2b-fake-member-id"));
check("载荷不含 buyerUserId", !payload.includes("998877"));

console.log("\n--- 价格（§9.2）---");
eq("skuPrice 模式下不发阶梯价（不把端点当档位）", offer.priceLadder.length, 0);
eq("总价格区间下限", summary.priceMin, 2.29);
eq("总价格区间上限", summary.priceMax, 4.99);
eq("priceMode 记录正确", summary.priceMode, "skuPrice");
check("没有出现把 skuPriceScale 字符串当数组的低级错误", !warnings.some((w) => w.includes("阶梯")), JSON.stringify(warnings));

console.log("\n--- SKU（§9.3）---");
eq("SKU 数量", offer.skus.length, 3);
const skuA = offer.skus.find((s) => s.specValues["颜色"] === SPEC_A);
const skuB = offer.skus.find((s) => s.specValues["颜色"] === SPEC_B);
check("specValues 按维度名索引", Boolean(skuA), JSON.stringify(offer.skus.map((s) => s.specValues)));
eq("skuId 是字符串", typeof skuA.skuId, "string");
eq("价格取 discountPrice", skuA.price, 2.29);
eq("discountPrice 为空串时回退到 price", skuB.price, 3.5);
eq("库存取 canBookCount（不是 amount）", skuA.stock, 9873019);
eq("库存 0 不被当成缺失", offer.skus.find((s) => s.skuId === "6046825856900").stock, 0);
eq("SKU 图取 skuProps.value[].imageUrl", skuA.imageUrl, "https://cbu01.alicdn.com/img/ibank/sku_a.jpg");

console.log("\n--- 规格维度 ---");
eq("维度数", offer.specDimensions.length, 1);
eq("维度名", offer.specDimensions[0].name, "颜色");
eq("选项数", offer.specDimensions[0].values.length, 3);

console.log("\n--- 属性（§9.8）---");
eq("属性条数", offer.attributes.length, 3);
eq("属性优先取 featureAttributes", offer.attributes[0].name, "附加功能");
eq("属性值", offer.attributes[0].value, "静音");
check(
  "没有误取 gallery.CpvEnhance（来源 2）",
  !offer.attributes.some((a) => a.name.includes("来源2")),
  JSON.stringify(offer.attributes),
);

console.log("\n--- 图片（§9.4）---");
eq("主图数量（每元素 1 张，不按尺寸裂开）", offer.images.main.length, 3);
eq("主图取 fullPathImageURI", offer.images.main[0], "https://cbu01.alicdn.com/img/ibank/main1.jpg");
eq("缺 fullPathImageURI 时补 host", offer.images.main[2], "https://cbu01.alicdn.com/img/ibank/main3.jpg");
eq("详情图数量", offer.images.detail.length, 2);
eq("详情图 1", offer.images.detail[0], "https://cbu01.alicdn.com/img/ibank/detail1.jpg");
eq("详情图走 data-src 兜底", offer.images.detail[1], "https://cbu01.alicdn.com/img/ibank/detail2.jpg");

// ⚠️ 这几条是回归守卫，针对首次联调踩的那个坑：
// 详情接口返回的是 JS（content 里是**转义过的** HTML），
// 若直接当 HTML 解析，属性值会残留 `\"`，被 absUrl 当成相对路径拼成
// `https://cbu01.alicdn.com/\"https://…\"` —— 形似而必然 404。
check(
  "详情图地址无 JS 转义残留（不含引号/反斜杠）",
  offer.images.detail.every((u) => !/["'\\]/.test(u)),
  JSON.stringify(offer.images.detail),
);
check(
  "详情图地址都是干净的 http(s) URL",
  offer.images.detail.every((u) => /^https:\/\/[^\s"'\\<>]+$/.test(u)),
  JSON.stringify(offer.images.detail),
);
check(
  "没有误报「详情接口格式变了」",
  !warnings.some((w) => w.includes("格式变了")),
  JSON.stringify(warnings),
);

console.log("\n--- 重量（§9.5）---");
eq("取 pieceWeightScaleInfo 的最大值（不是废字段 unitWeight=0）", offer.weightGram, 141);

console.log("\n--- 摘要 ---");
eq("供应商摘要", summary.supplierName, "广州胜丰玩具有限公司");
eq("SKU 数摘要", summary.skuCount, 3);
eq("属性数摘要", summary.attributeCount, 3);
eq("主图数摘要", summary.mainCount, 3);
eq("详情图数摘要", summary.detailCount, 2);

/* ------------------------------------------------------------------ *
 * 边界：页面数据结构变了要说实话，不能假装成功
 * ------------------------------------------------------------------ */

/** 再解析一遍（refresh:true）。边界场景要先换掉 window.context / fetch 再跑 */
const reExtract = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等不到解析结果（20 秒超时）")), 20_000);
    fakeDocument.addEventListener(`__sc_data_${TOKEN}__`, (event) => {
      clearTimeout(timer);
      resolve(event.detail);
    });
    fakeDocument.dispatchEvent(
      new CustomEvent("__sc_sourcing_bootstrap__", { detail: { token: TOKEN, refresh: true } }),
    );
  });

console.log("\n--- 边界：拿不到商品数据 ---");
globalThis.window.context = { result: { data: {} } };
const emptyResult = await reExtract();
eq("拿不到 dataJson 时 ok === false", emptyResult.ok, false);
eq("并且 offer 为 null", emptyResult.offer, null);
check("给出了可读的原因", emptyResult.warnings[0].includes("没等到商品数据"), JSON.stringify(emptyResult.warnings));

/* ------------------------------------------------------------------ *
 * 边界：没实测过的价格模式必须告警，不许猜
 *
 * 这是 §9.2 那条决策的回归测试。数量阶梯的数组形状我们**从未采到过实例**，
 * 一旦 encounter 到，唯一正确的行为是发空阶梯 + 告警 —— 而不是把它当成
 * 两档批发价照存。后者在列表页看不出问题，只在详情页显出凭空多出的档位。
 * ------------------------------------------------------------------ */

console.log("\n--- 边界：未知的 priceDisplayType ---");
globalThis.window.context = windowContext; // 换回好数据
windowContext.result.data.mainPrice.fields.priceModel.priceDisplayType = "quantityPrice";

const unknownMode = await reExtract();

eq("仍然解析成功（只是不解析价格）", unknownMode.ok, true);
eq("阶梯价发空数组", unknownMode.offer.priceLadder.length, 0);
eq("priceMode 如实记录未知取值", unknownMode.summary.priceMode, "quantityPrice");
check(
  "明确告警而不是静默",
  unknownMode.warnings.some((w) => w.includes("quantityPrice")),
  JSON.stringify(unknownMode.warnings),
);

/* ------------------------------------------------------------------ *
 * 边界：详情接口换了外壳 —— 必须空手上报 + 告警，不能拼出坏 URL
 *
 * 这是「详情图全 404」那个坑的回归测试。详情接口不写进任何契约，
 * 一旦它不再是小壳包 JSON，剥壳就会失败。此时正确的行为是**一张详情图都不产出**，
 * 而不是把带 `\"` 的原文当 HTML 解析 —— 后者拼出来的地址看着像模像样，
 * 一路到后端下载才以 404 暴露。
 * ------------------------------------------------------------------ */

console.log("\n--- 边界：详情接口外壳变了（剥不出 JSON）---");
globalThis.fetch = async () => detailBody('<img src=\\"https://cbu01.alicdn.com/img/ibank/x.jpg\\">');
const brokenShell = await reExtract();

eq("主体仍然解析成功", brokenShell.ok, true);
eq("详情图发空数组", brokenShell.offer.images.detail.length, 0);
check(
  "明确告警「格式变了」而不是静默",
  brokenShell.warnings.some((w) => w.includes("格式变了")),
  JSON.stringify(brokenShell.warnings),
);

console.log("\n--- 边界：详情接口返回的就是纯 HTML（老格式 / 别的实现）---");
globalThis.fetch = async () =>
  detailBody('<img src="//cbu01.alicdn.com/img/ibank/plain.jpg"><img data-src="img/ibank/plain2.jpg">');
const plainHtml = await reExtract();

eq("仍然能取到 2 张", plainHtml.offer.images.detail.length, 2);
eq("协议相对地址补 https:", plainHtml.offer.images.detail[0], "https://cbu01.alicdn.com/img/ibank/plain.jpg");
eq("相对地址补 CDN host", plainHtml.offer.images.detail[1], "https://cbu01.alicdn.com/img/ibank/plain2.jpg");
check(
  "无「格式变了」告警",
  !plainHtml.warnings.some((w) => w.includes("格式变了")),
  JSON.stringify(plainHtml.warnings),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log(`\n${"=".repeat(52)}`);
if (failures.length) {
  console.log(`FAILED —— ${passed} 通过, ${failures.length} 失败`);
  for (const name of failures) console.log(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`PASSED —— ${passed} 项全部通过`);
