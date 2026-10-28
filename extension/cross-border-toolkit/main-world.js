/**
 * Cross-Border Sourcing —— MAIN world 提取器
 *
 * 运行在页面自己的 JS 上下文中（manifest 里 `world: "MAIN"`），
 * 所以**不能使用任何 chrome.* API** —— 与扩展的通信全靠 DOM 事件，
 * 由 isolated.js 转发给 background。
 *
 * 字段映射的唯一依据是 docs/1688-probe.md 的 §9 表，全部经过真机实测。
 * 表里标 ⚠️ 的地方在本文件里都有对应注释 —— 那些是会**静默写错数据**的坑，
 * 改这个文件前请先读那一节。
 *
 * 数据最小化：只逐字段构造载荷，**从不整体 dump 页面对象**。
 * 特别地，以下字段一律不读（见 §9.7）：
 *   FE_GLOBALS.clientIP / FE_GLOBALS.loginId
 *   dataJson.offerBaseInfo.buyerUserId / buyerLoginId / buyerMemberId
 * 它们是**采集者本人**的标识，与所采商品无关。
 *
 * 载荷与结果的类型（CollectedOffer / ExtractResult / ExtractSummary）见
 * types.d.ts —— 那是全局声明，isolated.js 用的是同一份，不会漂移。
 */

(() => {
  "use strict";

  /* 防止重复注入（同一帧里脚本被执行两次时） */
  const MARK = "__SC_MAIN_WORLD_LOADED__";
  if (/** @type {any} */ (window)[MARK]) return;
  /** @type {any} */ (window)[MARK] = true;

  /**
   * 解析器版本。1688 改版 → 改映射表 → 这里 +1，据此能筛出用旧版解析的记录
   *
   * 1688/2：修正详情长图 —— 该接口返回的是 JS（content 里是转义过的 HTML），
   *         旧版直接当 HTML 解析，产出的地址必然 404。见 docs/1688-probe.md §9.4 更正。
   */
  const EXTRACTOR_VERSION = "1688/2";

  /** 握手事件名（固定）。真正的数据通道用它换来的随机 token 命名，见下方说明 */
  const EVT_BOOTSTRAP = "__sc_sourcing_bootstrap__";

  /** 等 window.context 出现的最长时间。广告落地页会先渲染一屏再跳转 */
  const CONTEXT_WAIT_MS = 15_000;

  const CDN_HOST = "https://cbu01.alicdn.com/";

  /** 首版只有 1688。用常量是为了让 `platform` 保持字面量类型（见 CollectedOffer） */
  const PLATFORM = "1688";

  /* ------------------------------------------------------------------ *
   * 安全取值
   *
   * 1688 的对象上有**会抛错的 getter** —— 探针 A 就被这种打断过一次，
   * 结果丢掉了一整段输出。所以所有属性访问都必须走这两层包装。
   * ------------------------------------------------------------------ */

  /**
   * @param {any} obj
   * @param {string} key
   * @returns {any}
   */
  const g = (obj, key) => {
    if (obj === null || obj === undefined) return undefined;
    try {
      return obj[key];
    } catch {
      return undefined;
    }
  };

  /**
   * 按 "a.b.c" 取深层属性，任一环取不到就返回 undefined
   *
   * @param {any} root
   * @param {string} path
   * @returns {any}
   */
  const at = (root, path) => {
    let cur = root;
    for (const key of path.split(".")) {
      cur = g(cur, key);
      if (cur === undefined) return undefined;
    }
    return cur;
  };

  /**
   * 转数字。
   *
   * ⚠️ **这个函数是必需的，不是保险。** 1688 的价格字段全是字符串
   * （`"2.90"`），而 `beginAmount` 在不同路径下**一会儿是 number 一会儿是
   * string**（见 §9.6）。忘了转换就会拿到 NaN，而 NaN 写进 SQLite 的 REAL 列
   * 会变成 NULL —— 不报错，静默丢数据。
   *
   * @param {unknown} v
   * @returns {number | undefined}
   */
  const num = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };

  /**
   * 转字符串并去空白；非字符串一律当空
   *
   * @param {unknown} v
   * @returns {string}
   */
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  /**
   * 不是数组就当空数组 —— 1688 的字段类型不稳定，不要假设
   *
   * @param {unknown} v
   * @returns {any[]}
   */
  const list = (v) => (Array.isArray(v) ? v : []);

  /**
   * 图片地址补全。
   *
   * 1688 的图片地址有三种形式，实测都出现过：
   *   "https://cbu01..."  完整
   *   "//cbu01..."        协议相对
   *   "img/ibank/..."     纯相对路径（**连 // 都没有**，最容易漏）
   *
   * @param {unknown} u
   * @returns {string}
   */
  const absUrl = (u) => {
    const s = text(u);
    if (!s) return "";
    if (s.startsWith("//")) return `https:${s}`;
    if (/^https?:\/\//i.test(s)) return s;
    return CDN_HOST + s.replace(/^\/+/, "");
  };

  /* ------------------------------------------------------------------ *
   * 各字段的提取
   * ------------------------------------------------------------------ */

  /**
   * 主图。⚠️ 一个元素是**同一张图的多种尺寸**，固定取 fullPathImageURI
   *
   * @param {any} dataJson
   * @returns {string[]}
   */
  function extractMainImages(dataJson) {
    /** @type {string[]} */
    const out = [];
    for (const item of list(g(dataJson, "images"))) {
      // fullPathImageURI 已是完整 URL；imageURI 是相对路径，必须补 host
      const url = absUrl(g(item, "fullPathImageURI")) || absUrl(g(item, "imageURI"));
      if (url && !out.includes(url)) out.push(url);
    }
    return out;
  }

  /**
   * 商品属性。
   *
   * ⚠️ 属性**不在** result.data.productAttributes 下（那里只有 uiType/label，是空的），
   * 也不在 offerBaseInfo 下。实测挂在两个地方，下面按可靠性排序。
   *
   * @param {any} result
   * @returns {CollectedAttribute[]}
   */
  function extractAttributes(result) {
    // 来源 1（首选）：featureAttributes，Array(19)，name + value 直接可用。
    // ⚠️ 路径是 result.global，**不是 result.data** —— 两者极易混淆。
    const fa = at(result, "global.globalData.model.offerDetail.featureAttributes");
    if (Array.isArray(fa)) {
      /** @type {CollectedAttribute[]} */
      const out = [];
      for (const item of fa) {
        const name = text(g(item, "name"));
        const value = text(g(item, "value"));
        if (name && value) out.push({ name, value });
      }
      if (out.length) return out;
    }

    // 来源 2：gallery 模块下的 CpvEnhance。
    // ⚠️ 属性挂在「图库」模块里 —— 名字有误导性，探针 A/C 都因此漏掉过它。
    const cpv = at(result, "data.gallery.fields.CpvEnhance");
    if (cpv) {
      /** @type {CollectedAttribute[]} */
      const out = [];
      for (const group of ["decisionCpv", "normalCpv"]) {
        for (const item of list(g(cpv, group))) {
          const name = text(g(item, "name"));
          const values = list(g(item, "values")).map(text).filter(Boolean);
          if (name && values.length) out.push({ name, value: values.join("、") });
        }
      }
      if (out.length) return out;
    }

    return [];
  }

  /**
   * 把 "红色>M" 这样的规格串拆成 { 颜色: "红色", 尺码: "M" }。
   *
   * ⚠️ **未验证**：实测商品只有 1 个规格维度，多维度时 1688 用什么分隔符
   * 没有数据（见 §10）。所以只在「拆出的段数恰好等于维度数」时才采用拆分，
   * 否则退化成把整个规格串挂到第一个维度下 —— **宁可少拆，不可拆错**。
   *
   * @param {string} specAttrs
   * @param {SpecDimension[]} specDimensions
   * @returns {Record<string, string>}
   */
  function splitSpecAttrs(specAttrs, specDimensions) {
    if (!specDimensions.length) return { 规格: specAttrs };
    if (specDimensions.length === 1) return { [specDimensions[0].name]: specAttrs };

    for (const sep of [">", "&"]) {
      const parts = specAttrs.split(sep).map((s) => s.trim());
      if (parts.length === specDimensions.length) {
        /** @type {Record<string, string>} */
        const out = {};
        specDimensions.forEach((dim, i) => {
          out[dim.name] = parts[i];
        });
        return out;
      }
    }
    return { [specDimensions[0].name]: specAttrs };
  }

  /**
   * SKU 列表与规格维度。
   *
   * ⚠️ skuInfoMap 是 **map 不是数组**，键是中文规格名（不是 skuId）。
   *
   * @param {any} dataJson
   * @returns {{ skus: CollectedSku[], specDimensions: SpecDimension[] }}
   */
  function extractSkus(dataJson) {
    const skuModel = g(dataJson, "skuModel");
    const skuMap = g(skuModel, "skuInfoMap");
    if (!skuMap || typeof skuMap !== "object") {
      return { skus: [], specDimensions: [] };
    }

    // 规格维度。顺带收一份「选项名 → 选项图」，那**就是该 SKU 的图**
    const specDimensions = [];
    const imageBySpec = new Map();
    for (const dim of list(g(skuModel, "skuProps"))) {
      const name = text(g(dim, "prop"));
      /** @type {string[]} */
      const values = [];
      for (const opt of list(g(dim, "value"))) {
        const optionName = text(g(opt, "name"));
        if (!optionName) continue;
        values.push(optionName);
        const image = absUrl(g(opt, "imageUrl"));
        if (image) imageBySpec.set(optionName, image);
      }
      if (name && values.length) specDimensions.push({ name, values });
    }

    /** @type {CollectedSku[]} */
    const skus = [];
    for (const key of Object.keys(skuMap)) {
      const raw = g(skuMap, key);
      if (!raw || typeof raw !== "object") continue;

      const specAttrs = text(g(raw, "specAttrs")) || key;

      // 价格取促销价优先，其次原价 —— 两者都是字符串
      const discount = num(g(raw, "discountPrice"));
      const original = num(g(raw, "price"));
      const price = discount !== undefined && discount > 0 ? discount : original;

      skus.push({
        skuId: String(g(raw, "skuId") ?? key),
        specValues: splitSpecAttrs(specAttrs, specDimensions),
        price,
        // ⚠️ 库存字段是 canBookCount，**不是 amount**（见 §9.3）
        stock: num(g(raw, "canBookCount")),
        imageUrl: imageBySpec.get(specAttrs) ?? undefined,
      });
    }

    return { skus, specDimensions };
  }

  /**
   * 阶梯价。
   *
   * ⚠️⚠️ 这是整个 extractor 里最容易出错的地方。
   *
   * `currentPrices` / `originalPricesWithoutPromotion` 这些数组**看起来**像
   * 数量阶梯，但在 `priceDisplayType === "skuPrice"` 时，它们是
   * **[最低价, 最高价] 两个端点**，`beginAmount` 恒为 1。
   * 把它们当成两档批发价存进 sourcing_price_tiers，列表页的价格区间仍然
   * 正确（所以看不出问题），只有详情页的阶梯表会凭空多出两档。
   *
   * 实测本商品（USB 小风扇）就是 `skuPrice` 模式，**根本没有数量阶梯**。
   *
   * 因此：只有确认了数量阶梯模式的形状之后才解析它。当前一律返回空数组，
   * 价格区间交给后端从各 SKU 的价格派生
   * （server/sourcing/repository.ts 的 derivePriceRange 同时看阶梯和 SKU）。
   *
   * @param {any} data
   * @returns {{ ladder: PriceTier[], warning: string | null }}
   */
  function extractPriceLadder(data) {
    const displayType = text(at(data, "mainPrice.fields.priceModel.priceDisplayType"));

    if (displayType !== "skuPrice") {
      return {
        ladder: [],
        warning: displayType
          ? `价格模式是「${displayType}」，不是已实测过的 skuPrice，已跳过阶梯价解析（见 docs/1688-probe.md §9.2）`
          : "没取到 priceDisplayType，已跳过阶梯价解析",
      };
    }

    // skuPrice：价格按规格变，不按数量变。没有阶梯可发。
    return { ladder: [], warning: null };
  }

  /**
   * 重量（克）。
   *
   * ⚠️ 顶层 `productPackInfo.fields.unitWeight` 实测是 `0`，是**废字段**。
   * 真实数据按 SKU 分段在 pieceWeightScaleInfo 里。
   *
   * @param {any} data
   * @returns {number | undefined}
   */
  function extractWeightGram(data) {
    const info = list(at(data, "productPackInfo.fields.pieceWeightScale.pieceWeightScaleInfo"));

    // 只有一个单值字段可用，取最大值：对运费估算是保守侧（不会低估）。
    // 用循环而不是 Math.max(...weights)，是为了让类型收窄自然发生 ——
    // filter 不会把 (number|undefined)[] 收成 number[]，硬转换会掩盖真问题。
    /** @type {number | undefined} */
    let heaviest;
    for (const item of info) {
      const weight = num(g(item, "weight"));
      if (typeof weight === "number" && weight > 0 && (heaviest === undefined || weight > heaviest)) {
        heaviest = weight;
      }
    }
    return heaviest;
  }

  /**
   * 合法的图片地址：http(s) 开头，且不含引号 / 反斜杠 / 尖括号 / 空白。
   *
   * 这条守卫是针对下面那个踩过的坑加的：**坏 URL 长得像模像样**，
   * 一路到后端下载才以 404 暴露。与其拼出一条看着对的地址，不如在这里拦掉。
   *
   * @param {string} u
   * @returns {boolean}
   */
  function isCleanUrl(u) {
    return /^https?:\/\/[^\s"'\\<>]+$/i.test(u);
  }

  /**
   * 详情接口的响应体 → HTML 字符串。必要时先剥掉外面那层 JS 壳。
   *
   * ⚠️⚠️ 实测（2026-09-20）这个接口**返回的不是 HTML，是一段 JS**：
   *
   *     var offer_details={"content":"<div…><img src=\"https://…\"/>"}
   *
   * 图片在 JSON 的 `content` 字段里，而 content 是一段**被 JS 转义过的 HTML 字符串**。
   * 直接把原文喂给 DOMParser 会**静默**出坏数据：HTML 解析器不认 `\` 是转义符，
   * 于是 `src=\"https://…\"` 的属性值会连反斜杠带引号一起留下来，得到 `\"https://…\"`；
   * 它不以 http 开头，absUrl 便当相对路径拼上 CDN 前缀，拼出一条**形似而必然 404**
   * 的地址。全程不报错、不告警，直到后端下载时才发现详情图全挂 —— 首次联调踩的就是这个。
   *
   * 剥不动就返回空串 + 告警，**不猜**。理由与 extractPriceLadder 处理未知
   * priceDisplayType 一致：猜出来的东西在列表页看不出问题，只有下游才会炸。
   *
   * @param {string} body
   * @returns {string} 解析不出返回空串（宁可没有详情图，也不要坏 URL）
   */
  function detailHtmlOf(body) {
    const source = text(body);
    if (!source) return "";

    // 壳有两种可能写法：`var xxx = {...}` 或裸 JSON。两种都试，谁先解出 content 用谁。
    const assignment = source.match(/^\s*(?:var|let|const)\s+[\w$]+\s*=\s*([\s\S]*?);?\s*$/);
    for (const candidate of [assignment ? assignment[1] : "", source]) {
      if (!candidate) continue;
      try {
        const content = text(g(JSON.parse(candidate), "content"));
        if (content) return content;
      } catch {
        // 不是 JSON —— 换下一种写法
      }
    }

    // 剩下的情况：响应本来就是 HTML（没有 JS 壳）。
    // 但只要发现 JS 转义残留，就说明上面剥壳失败了 —— 此时原文里的属性值是脏的，
    // 用它会重演那个 404 的坑，所以宁可返回空。
    return source.includes('\\"') ? "" : source;
  }

  /**
   * 详情长图。
   *
   * ⚠️ detailUrl 指向的不是图片，是一个**返回 JS 对象**的接口，域名是
   * itemcdn.tmall.com（不是 alicdn）。响应要先经 detailHtmlOf 剥壳，
   * 再用浏览器原生 DOMParser 解析 —— 浏览器本来就会解析 HTML，
   * 不需要 Cheerio / jsdom 这类库（计划里特意强调过这点）。
   *
   * 这一步失败不影响主流程：详情图是补充信息，主图才是列表缩略图的来源。
   *
   * @param {any} data
   * @returns {Promise<{ urls: string[], warning: string | null }>}
   */
  async function extractDetailImages(data) {
    const url = text(at(data, "description.fields.detailUrl"));
    if (!url) return { urls: [], warning: null };

    try {
      // credentials: "omit" —— 明确不带 cookie。跨域请求本来也不带，
      // 但写出来表明意图，避免以后有人改成 "include"。
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) return { urls: [], warning: null };

      const body = await response.text();
      const html = detailHtmlOf(body);
      if (!html) {
        return {
          urls: [],
          warning:
            "详情接口的响应格式变了：它不是预期的 HTML，也没能按 JS 对象剥出 content。" +
            "已跳过详情图，避免把转义残留拼成 404 地址（见 docs/1688-probe.md §9.4）。",
        };
      }

      const doc = new DOMParser().parseFromString(html, "text/html");

      /** @type {string[]} */
      const out = [];
      let dropped = 0;
      for (const img of doc.querySelectorAll("img")) {
        // 懒加载的图真实地址在 data-src 上，src 可能是占位图（data: URI 之类）。
        // 所以是「取第一个合法的」，而不是 src || data-src —— 后者只要 src
        // 非空就短路，占位图会把真正地址挡掉。
        const src =
          [img.getAttribute("src"), img.getAttribute("data-src")].map(absUrl).find(isCleanUrl) ?? "";
        if (!src) {
          dropped++;
          continue;
        }
        if (!out.includes(src)) out.push(src);
      }

      return {
        urls: out,
        warning: dropped
          ? `详情图有 ${dropped} 个 <img> 没解析出合法地址，已丢弃（共取到 ${out.length} 张）。`
          : null,
      };
    } catch {
      // 跨域被拦 / 网络失败都走这里。不是错误，是能力降级。
      return { urls: [], warning: null };
    }
  }

  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 等 window.context 挂上。广告落地页会先渲染一屏再跳转，跑太早会扑空
   *
   * @returns {Promise<boolean>}
   */
  async function waitForContext() {
    const deadline = Date.now() + CONTEXT_WAIT_MS;
    while (Date.now() < deadline) {
      if (g(window, "context") && at(g(window, "context"), "result.data.Root.fields.dataJson")) return true;
      await sleep(300);
    }
    return false;
  }

  /** @returns {Promise<ExtractResult>} */
  async function extract() {
    const warnings = [];

    if (!(await waitForContext())) {
      return { ok: false, offer: null, warnings: ["没等到商品数据（window.context 里没有 Root.fields.dataJson）。可能不是商品详情页，或页面结构变了。"] };
    }

    const context = g(window, "context");
    const result = g(context, "result");
    const data = g(result, "data");
    const dataJson = at(data, "Root.fields.dataJson");

    const feGlobals = g(window, "FE_GLOBALS");

    // offerId：FE_GLOBALS 最可靠，dataJson 兜底。实测是 number，统一转字符串
    const offerId =
      String(num(g(feGlobals, "offerId")) ?? num(g(dataJson, "offerId")) ?? num(at(dataJson, "tempModel.offerId")) ?? "") || "";

    const title =
      text(at(data, "productTitle.fields.title")) || text(at(dataJson, "tempModel.offerTitle")) || "";

    /**
     * ⚠️⚠️ 供应商一律取 offerLoginId。
     *
     * FE_GLOBALS.loginId 看起来像「供应商登录账号」，实测却是**采集者本人**
     * 的登录名（与 offerBaseInfo.buyerLoginId 同值）。照名字字面理解会把
     * 采集者自己的账号当成供应商写进库，而且很难发现 —— 只有在多个人
     * 共用一个后台采集时，供应商列里冒出同事的账号才会显形。
     * 详见 docs/1688-probe.md 第 2 节的更正。
     */
    const supplier = {
      name:
        text(g(feGlobals, "offerLoginId")) ||
        text(at(data, "productTitle.fields.shopInfo.companyName")) ||
        text(at(dataJson, "tempModel.companyName")) ||
        undefined,
      // loginId 故意留空：1688 没给供应商的登录账号（sellerLoginId 存的就是公司名）。
      // 唯一叫 loginId 的字段是采集者自己的，不能填。
      shopUrl:
        text(at(dataJson, "offerBaseInfo.sellerWinportUrl")) ||
        text(at(dataJson, "tempModel.winportUrl")) ||
        undefined,
      // location 留空：实测的几处数据里都没有供应商所在地（见 docs/1688-probe.md §10）
    };

    const { skus, specDimensions } = extractSkus(dataJson);
    const price = extractPriceLadder(data);
    if (price.warning) warnings.push(price.warning);

    const mainImages = extractMainImages(dataJson);
    const detail = await extractDetailImages(data);
    const detailImages = detail.urls;
    if (detail.warning) warnings.push(detail.warning);

    if (!skus.length) warnings.push("没解析到任何 SKU —— 可能是未登录，或该商品没有规格。");
    if (!mainImages.length) warnings.push("没解析到主图。");
    // warning 已经解释过为什么没有详情图了，不重复报
    if (!detailImages.length && !detail.warning) {
      warnings.push("没取到详情长图（多为跨域被拦，不影响主图）。");
    }
    if (!title) warnings.push("没解析到标题。");

    // ⚠️ 起批量是 orderParam.beginNum。**不要取 limitParam.limitNum** ——
    // 那是「限购 N 件」，语义与「至少买 N 件」正好相反，而两者就在隔壁。
    const moq = num(at(dataJson, "orderParamModel.orderParam.beginNum"));

    /**
     * 标上 CollectedOffer：这个对象字面量是**前后端的接缝**，
     * 拼错一个字段名（比如 stock 写成 amount、price 写成 priceText）
     * 后端不会报错，只会静默存空值。让编译器在这里替我们把关。
     *
     * @type {CollectedOffer}
     */
    const offer = {
      // 用常量而不是字面量：`platform: "1688"` 会被推断成 string，
      // 而 SourcePlatform 是字面量类型 "1688"，对不上
      platform: PLATFORM,
      offerId,
      /*
       * 归一化 URL，**丢掉 query**。
       * 采集时的地址常带着一大堆投放参数（src=zhanwai&spm=...&clickid=...），
       * 存下来既没用又长得吓人，还会让同一条货源因为入口不同而看起来是两个链接。
       */
      url: offerId ? `https://detail.1688.com/offer/${offerId}.html` : location.href.split("?")[0],
      title,
      supplier,
      moq,
      priceLadder: price.ladder,
      specDimensions,
      skus,
      attributes: extractAttributes(result),
      images: { main: mainImages, detail: detailImages },
      weightGram: extractWeightGram(data),
      // dimensions 不发：实测 length/width/height 全是 0，没有可用数据
      extractorVersion: EXTRACTOR_VERSION,
      capturedAt: new Date().toISOString(),
    };

    // 供浮层展示的摘要（不随载荷上报）
    const prices = skus.map((s) => s.price).filter((p) => typeof p === "number");
    const summary = {
      offerId,
      title,
      supplierName: supplier.name ?? "",
      moq,
      priceMin: prices.length ? Math.min(...prices) : undefined,
      priceMax: prices.length ? Math.max(...prices) : undefined,
      skuCount: skus.length,
      attributeCount: offer.attributes.length,
      mainCount: mainImages.length,
      detailCount: detailImages.length,
      weightGram: offer.weightGram,
      priceMode: text(at(data, "mainPrice.fields.priceModel.priceDisplayType")) || "unknown",
    };

    return { ok: true, offer, summary, warnings };
  }

  /* ------------------------------------------------------------------ *
   * 与 isolated.js 的桥
   *
   * MAIN world 拿不到 chrome.*，所以只能靠 DOM 事件通信。
   *
   * 关于事件名随机化：数据通道用 `前缀 + 随机 token` 而不是固定名字。
   * 要说清楚它**不是硬边界** —— 页面脚本与我们同处一个 JS 环境，能监听
   * document 上的任何事件，也就能从握手事件里读到 token。它挡的是
   * 「随手写一段脚本往这个后台灌数据」这类情况。真正兜底的是后端的
   * 载荷敏感字段校验（见 server/routes/sourcing.ts；X-Collect-Token 已移除）。
   * ------------------------------------------------------------------ */

  let bridgeToken = /** @type {string | null} */ (null);
  /** @type {ExtractResult | null} */
  let cachedResult = null;

  /** 只有这一个出站事件名带 token —— 采集结果只从这里出去 */
  const dataEventName = () => `__sc_data_${bridgeToken}__`;

  /**
   * @param {ExtractResult} result
   * @returns {void}
   */
  const publish = (result) => {
    if (!bridgeToken) return;
    try {
      document.dispatchEvent(new CustomEvent(dataEventName(), { detail: result }));
    } catch (error) {
      console.warn("[sourcing] 发送采集结果失败", error);
    }
  };

  async function runAndPublish() {
    try {
      cachedResult = await extract();
    } catch (error) {
      cachedResult = {
        ok: false,
        offer: null,
        warnings: [`解析出错: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    publish(cachedResult);
  }

  /**
   * 握手。isolated.js 发这个事件把 token 传进来，之后我们用它作为数据通道名。
   *
   * `detail.refresh === true` 表示「重新解析一遍」（用户点了浮层上的刷新）。
   * 复用同一个事件名而不是再开一个「拉取」事件：**出站只有一个带 token 的事件名**，
   * 审计的时候一眼能看全数据往哪去。
   */
  document.addEventListener(EVT_BOOTSTRAP, (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const token = detail ? text(detail.token) : "";
    if (!token) return;

    bridgeToken = token;

    if (detail.refresh === true || !cachedResult) void runAndPublish();
    else publish(cachedResult); // 已经解析过就直接给缓存（isolated 可能比我们晚注入）
  });
})();
