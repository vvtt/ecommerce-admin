/**
 * 1688 探针 E：补齐最后几项未知
 *
 * 探针 C 已确认的（见 docs/1688-probe.md）：
 *   - skuModel.skuPriceScale 是**字符串** "2.21-5.37"，不是阶梯数组
 *   - onePiecePrice 是布尔 false，不是价格
 *   - dataJson.images 是主图数组（含 fullPathImageURI）
 *   - skuModel.skuInfoMap 按规格名索引，每个 SKU 是 Object{10}
 *
 * 本脚本补的是：
 *   1. **阶梯价到底在哪** —— 不猜路径，改为递归搜索「形如价格阶梯的数组」
 *   2. 单个 SKU 的 10 个字段是什么（探针 C 没展开，因为规格名不匹配 WANT）
 *   3. 商品属性、重量、MOQ、起批量在哪
 *   4. result.data.mainPrice.fields 的实际形状
 *
 * 用法：F12 → Console → 粘贴 → 回车 → copy(__PROBE_TEXT__)
 * 只读，不发请求。clientIP 等个人信息主动跳过。
 */
(async () => {
  const MAX_LINES = 420;
  const MAX_JSON_CHARS = 1500;

  /** 用词边界，避免误伤 consign / offerSign */
  const FORBIDDEN =
    /(cookie|token|session|passwd|password|secret|csrf|ticket|_m_h5|\bsign\b|signature|\bauth(orization)?\b)/i;
  /** 个人信息：能采但绝不该采，打印时就地拦掉 */
  const PII = /(clientip|client_ip|\bipaddr|latitude|longitude|phone|mobile|email|idcard)/i;

  const out = [];
  let truncated = false;
  const say = (s) => {
    if (out.length >= MAX_LINES) {
      if (!truncated) {
        truncated = true;
        out.push(`… 已达 ${MAX_LINES} 行上限，后续输出被省略`);
      }
      return;
    }
    out.push(s);
  };

  const get = (obj, key) => {
    try {
      return obj[key];
    } catch {
      return undefined;
    }
  };

  const keysOf = (o) => {
    try {
      return Object.keys(o);
    } catch {
      return [];
    }
  };

  const preview = (v) => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return `Array(${v.length})`;
    const t = typeof v;
    if (t === "string") return v.length > 70 ? `"${v.slice(0, 70)}…"` : `"${v}"`;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "object") return `Object{${keysOf(v).length}}`;
    return t;
  };

  /**
   * 脱敏序列化。
   *
   * 为什么不能只靠调用处逐键判断：段 6 会先按 PII 规则跳过 clientIP，
   * 紧接着又 `safeJson(整个对象)` 把原始数据 dump 一遍 —— 拦截被绕过去了。
   * 所以过滤器必须装在序列化层，覆盖所有 dump 路径。
   *
   * 返回字符串而不是 undefined，是为了让报告里看得见「这里有个被略过的字段」，
   * 直接省略会让人以为该字段不存在。
   */
  const redact = (key, value) =>
    key && (FORBIDDEN.test(key) || PII.test(key)) ? "[已略过]" : value;

  const safeJson = (v) => {
    let s;
    try {
      s = JSON.stringify(v, redact, 1);
    } catch {
      return "(无法序列化)";
    }
    if (s === undefined) return "(undefined)";
    return s.length > MAX_JSON_CHARS ? `${s.slice(0, MAX_JSON_CHARS)}\n  … 截断（原文 ${s.length} 字符）` : s;
  };

  /* ---------------- 等待数据就绪 ---------------- */
  const WAIT_MS = 10000;
  const startedAt = Date.now();
  const readContext = () => {
    if (!("context" in window)) return { state: "absent" };
    try {
      const v = window.context;
      return v ? { state: "ok", value: v } : { state: "empty" };
    } catch {
      return { state: "threw" };
    }
  };
  let probe = readContext();
  while ((probe.state === "absent" || probe.state === "empty") && Date.now() - startedAt < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 250));
    probe = readContext();
  }

  const ctx = probe.state === "ok" ? probe.value : undefined;
  const data = ctx && get(get(ctx, "result"), "data");
  const dataJson = data && get(get(get(data, "Root"), "fields"), "dataJson");

  say("### 0. 环境");
  say(`location.href : ${String(location.href).slice(0, 100)}`);
  say(`window.context: ${probe.state}${probe.state === "ok" ? "" : `（等了 ${Date.now() - startedAt}ms）`}`);
  say(`dataJson      : ${dataJson ? `Object{${keysOf(dataJson).length}}` : "(无)"}`);
  say("");

  if (!dataJson) {
    say("!! dataJson 取不到，后面都没法跑。先跑 docs/probe-1688-diag.js 定位。");
    const t = out.join("\n");
    window.__PROBE_TEXT__ = t;
    console.log(t);
    console.log("%c↑ 想一键复制：copy(__PROBE_TEXT__)", "font-weight:bold;color:#0a7");
    return t;
  }

  /* ---------------- 1. 阶梯价：递归搜索，不猜路径 ---------------- */
  say("### 1. 阶梯价定位（递归搜索「形如价格阶梯的数组」）");
  say('  判据：数组的第 0 项是对象，且带 price / beginAmount / startQuantity 之类键。');
  say("");

  const PRICEY_KEY = /^(price|priceText|beginAmount|startAmount|startQuantity|endAmount|endQuantity|amount|discountPrice|memberPrice|weight|volume)$/i;
  const hits = [];
  const seen = new WeakSet();

  const scan = (node, path, depth) => {
    if (hits.length >= 24 || depth > 9) return;
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      const first = get(node, 0);
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const ks = keysOf(first);
        const matched = ks.filter((k) => PRICEY_KEY.test(k));
        // 至少命中 2 个价格相关键，才认为这是价格阶梯而不是碰巧带 price 的对象
        if (matched.length >= 2) hits.push({ path, len: node.length, keys: ks, sample: first });
      }
      const probeCount = Math.min(node.length, 2);
      for (let i = 0; i < probeCount; i++) scan(get(node, i), `${path}[${i}]`, depth + 1);
      return;
    }

    for (const k of keysOf(node)) {
      if (FORBIDDEN.test(k)) continue;
      scan(get(node, k), `${path}.${k}`, depth + 1);
    }
  };

  scan(data, "result.data", 0);
  scan(dataJson, "dataJson", 0);

  if (!hits.length) {
    say("  (没搜到价格阶梯数组)");
  }
  for (const h of hits) {
    say(`★ ${h.path}  —— Array(${h.len})，元素键: ${h.keys.join(", ")}`);
    say(`   [0] = ${safeJson(h.sample)}`);
    say("");
  }
  say("");

  /* ---------------- 2. 单个 SKU 的完整字段 ---------------- */
  say("### 2. skuInfoMap 里的单个 SKU 全文");
  const skuMap = get(get(dataJson, "skuModel"), "skuInfoMap");
  if (skuMap) {
    const names = keysOf(skuMap);
    say(`  共 ${names.length} 个 SKU，取第 1 个：${names[0]}`);
    say(safeJson(get(skuMap, names[0])));
  } else {
    say("  (skuInfoMap 不存在)");
  }
  say("");

  /* ---------------- 3. 规格维度 ---------------- */
  say("### 3. skuModel.skuProps（规格维度，值截断到前 2 项）");
  const props = get(get(dataJson, "skuModel"), "skuProps");
  if (Array.isArray(props)) {
    for (const p of props) {
      const fid = get(p, "fid");
      const prop = get(p, "prop");
      const values = get(p, "value");
      say(`  fid=${fid} prop="${prop}" value: Array(${Array.isArray(values) ? values.length : "?"})`);
      if (Array.isArray(values)) {
        for (const v of values.slice(0, 2)) {
          say(`     - name="${get(v, "name")}"  imageUrl=${String(get(v, "imageUrl")).slice(0, 80)}`);
        }
        if (values.length > 2) say(`     … 还有 ${values.length - 2} 项`);
      }
    }
  } else {
    say("  (skuProps 不存在)");
  }
  say("");

  /* ---------------- 4. mainPrice.fields ---------------- */
  say("### 4. result.data.mainPrice.fields 关键子键");
  const mp = get(get(data, "mainPrice"), "fields");
  if (mp) {
    for (const k of keysOf(mp)) {
      if (FORBIDDEN.test(k)) continue;
      const v = get(mp, k);
      say("");
      say(`--- mainPrice.fields.${k} : ${preview(v)} ---`);
      if (v && typeof v === "object" && /(price|model|ladder|scale)/i.test(k)) say(safeJson(v));
    }
  } else {
    say("  (mainPrice 不存在)");
  }
  say("");

  /* ---------------- 5. 标题与销量 ---------------- */
  say("### 5. result.data.productTitle.fields");
  const pt = get(get(data, "productTitle"), "fields");
  if (pt) {
    for (const k of keysOf(pt)) {
      if (FORBIDDEN.test(k)) continue;
      if (/^(title|subject|saleNum|newSaleCount|saleCountDate|unit|isBestOffer)$/i.test(k)) {
        say(`  ${k} : ${preview(get(pt, k))}`);
      }
    }
    say(`  shopInfo : ${preview(get(pt, "shopInfo"))}`);
    const shop = get(pt, "shopInfo");
    if (shop && typeof shop === "object") {
      for (const k of keysOf(shop)) {
        if (FORBIDDEN.test(k)) continue;
        say(`    shopInfo.${k} : ${preview(get(shop, k))}`);
      }
    }
  } else {
    say("  (productTitle 不存在)");
  }
  say("");

  /* ---------------- 6. offerBaseInfo：属性 / MOQ / 重量 最可能的家 ---------------- */
  say("### 6. dataJson.offerBaseInfo 全文（属性/MOQ/重量的最可能来源）");
  const obi = get(dataJson, "offerBaseInfo");
  if (obi) {
    for (const k of keysOf(obi)) {
      if (FORBIDDEN.test(k)) continue;
      if (PII.test(k)) {
        say(`  ${k} : [已略过：个人信息]`);
        continue;
      }
      say(`  ${k} : ${preview(get(obi, k))}`);
    }
    say("");
    say("  --- 全文（截断） ---");
    say(safeJson(obi));
  } else {
    say("  (offerBaseInfo 不存在)");
  }
  say("");

  /* ---------------- 7. 主图 ---------------- */
  say("### 7. dataJson.images[0] 全文");
  const imgs = get(dataJson, "images");
  if (Array.isArray(imgs)) {
    say(`  共 ${imgs.length} 张`);
    say(safeJson(get(imgs, 0)));
  } else {
    say("  (images 不存在)");
  }
  say("");

  /* ---------------- 8. 重量 ---------------- */
  say("### 8. result.data.productPackInfo.fields（重量）");
  const ppi = get(get(data, "productPackInfo"), "fields");
  if (ppi) {
    for (const k of keysOf(ppi)) {
      if (FORBIDDEN.test(k)) continue;
      const v = get(ppi, k);
      say(`  ${k} : ${preview(v)}`);
      if (v && typeof v === "object") say(`      ${safeJson(v)}`);
    }
  } else {
    say("  (productPackInfo 不存在)");
  }
  say("");

  /* ---------------- 9. 详情长图入口 ---------------- */
  say("### 9. result.data.description.fields");
  const desc = get(get(data, "description"), "fields");
  if (desc) {
    for (const k of keysOf(desc)) {
      if (FORBIDDEN.test(k)) continue;
      if (/^(detailUrl|detailVideoId|leafCategoryId)$/i.test(k)) {
        say(`  ${k} : ${preview(get(desc, k))}`);
      }
    }
  } else {
    say("  (description 不存在)");
  }
  say("");

  /* ---------------- 10. 其余模块的键名 ---------------- */
  say("### 10. dataJson 其余可疑模块的键名");
  for (const name of ["tempModel", "mixModel", "offerSign", "offerCrossBorderModel", "activityModel", "abTestInfo", "exposeInfo", "orderParamLimitParam"]) {
    const v = get(dataJson, name);
    if (v && typeof v === "object") {
      say(`  ${name} : ${keysOf(v).join(", ")}`);
    }
  }
  say("");

  /* ---------------- 11. endpoint 是什么 ---------------- */
  say("### 11. result.endpoint（探针 C 显示它是对象不是字符串）");
  const ep = get(get(ctx, "result"), "endpoint");
  if (ep && typeof ep === "object") {
    for (const k of keysOf(ep)) {
      if (FORBIDDEN.test(k)) continue;
      say(`  ${k} : ${preview(get(ep, k))}`);
    }
  } else {
    say(`  ${preview(ep)}`);
  }

  /* ---------------- 输出 ---------------- */
  const text = out.join("\n");
  try {
    window.__PROBE_TEXT__ = text;
  } catch {
    /* ignore */
  }
  console.log(text);
  console.log("%c↑ 想一键复制就再跑一句：  copy(__PROBE_TEXT__)", "font-weight:bold;color:#0a7");
  return text;
})();
