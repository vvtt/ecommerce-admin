/**
 * 1688 探针 F：定位商品属性 + MOQ，并汇总字段类型
 *
 * 为什么还要跑：探针 E 之后，只有两项还没着落。
 *   1. **商品属性**（品牌/材质/货号…）—— result.data.productAttributes.fields 只有
 *      uiType/label，是空的；dataJson.offerBaseInfo 里也没有。
 *   2. **MOQ / 起批量** —— 怀疑是 beginAmount，但那个字段同时被价格区间用着，没定论。
 *
 * 定位办法：**按已知值反查路径**。
 *   你页面上显示着「货号 F001」「材质 塑料」「品牌 SF」，这些值字符串很独特。
 *   把它们在整个数据树里搜一遍，命中的路径就是属性的存放处 —— 比猜键名可靠得多。
 *
 * 用法：F12 → Console → 粘贴 → 回车 → copy(__PROBE_TEXT__)
 * 只读，不发请求。buyer* / clientIP 等个人信息主动跳过。
 */
(async () => {
  const MAX_LINES = 420;
  const MAX_JSON_CHARS = 1800;

  const FORBIDDEN =
    /(cookie|token|session|passwd|password|secret|csrf|ticket|_m_h5|\bsign\b|signature|\bauth(orization)?\b)/i;
  /**
   * 个人信息 / 采集者本人标识。
   *
   * buyerUserId / buyerLoginId / buyerMemberId 是**采集者自己**的账号标识
   * （见 docs/1688-probe.md 第 10 节），跟采集商品无关；
   * clientIP 是采集者的出口 IP。都不该进库。
   */
  const PII =
    /(clientip|client_ip|buyeruserid|buyerloginid|buyermemberid|latitude|longitude|phone|mobile|email|idcard)/i;

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
  const redact = (key, value) => (key && (FORBIDDEN.test(key) || PII.test(key)) ? "[已略过]" : value);
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
  const result = ctx && get(ctx, "result");
  const data = result && get(result, "data");
  const dataJson = data && get(get(get(data, "Root"), "fields"), "dataJson");

  say("### 0. 环境");
  say(`window.context : ${probe.state}${probe.state === "ok" ? "" : `（等了 ${Date.now() - startedAt}ms）`}`);
  say(`dataJson       : ${dataJson ? `Object{${keysOf(dataJson).length}}` : "(无)"}`);
  say("");

  /* ---------------- 1. 按已知值反查属性存放处 ---------------- */
  say("### 1. 商品属性定位：按已知值在对象树里反查路径");
  say("  你在页面上看到的属性值是很好的路标。命中路径 = 属性的家。");
  say("");

  /**
   * 搜索目标。改成你页面上实际显示的值 —— 值越独特，命中越准。
   * 默认这几个来自上一个商品（货号 F001 / 材质 塑料 / 品牌 SF）的页面文本。
   */
  const NEEDLES = ["F001", "塑料", "静音", "货号", "材质", "品牌", "是否进口", "附加功能"];
  say(`  搜索词：${NEEDLES.join(" / ")}`);
  say("");

  const found = new Map(); // path -> value
  let visited = 0;
  const VISIT_CAP = 60000;
  const seen = new WeakSet();

  const search = (node, path, depth) => {
    if (visited > VISIT_CAP || found.size > 40 || depth > 12) return;
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    visited++;

    for (const k of keysOf(node)) {
      if (FORBIDDEN.test(k) || PII.test(k)) continue;
      const v = get(node, k);
      const p = `${path}.${k}`;
      if (typeof v === "string") {
        for (const n of NEEDLES) {
          if (v.includes(n)) {
            found.set(p, v.length > 80 ? `${v.slice(0, 80)}…` : v);
            break;
          }
        }
      } else if (v && typeof v === "object") {
        // 键名本身也可能是路标（比如键就叫 "材质"）
        for (const n of NEEDLES) {
          if (k.includes(n) && found.size < 40) found.set(p, `(键名命中) ${preview(v)}`);
        }
        search(v, p, depth + 1);
      }
    }
  };

  search(ctx, "context", 0);
  say(`  遍历了 ${visited} 个对象节点，命中 ${found.size} 条：`);
  say("");
  if (!found.size) {
    say("  (一条都没命中)");
    say("  → 说明属性根本不在这份 window.context 里，很可能是**另一个接口单独拉的**。");
    say("    那就改走 docs/probe-1688-network.js 看它请求了什么；");
    say("    或者接受现状，属性改从 DOM 读（计划里的第 4 层）。");
  }
  for (const [p, v] of found) {
    say(`  ${p}`);
    say(`      = ${v}`);
  }
  say("");

  /* ---------------- 2. 泛化扫描：形如 {name, value} 的属性数组 ---------------- */
  say("### 2. 泛化扫描：形如属性键值对的数组/对象");
  const ATTR_PAIR = /^(name|propName|attributeName|key|attrName|label)$/i;
  const ATTR_VAL = /^(value|propValue|attributeValue|val|text|content)$/i;
  const pairHits = [];
  const seen2 = new WeakSet();
  const scanPairs = (node, path, depth) => {
    if (pairHits.length >= 20 || depth > 10) return;
    if (!node || typeof node !== "object") return;
    if (seen2.has(node)) return;
    seen2.add(node);

    if (Array.isArray(node)) {
      const first = get(node, 0);
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const ks = keysOf(first);
        if (ks.some((k) => ATTR_PAIR.test(k)) && ks.some((k) => ATTR_VAL.test(k))) {
          pairHits.push({ path, len: node.length, keys: ks, sample: first });
        }
      }
      for (let i = 0; i < Math.min(node.length, 2); i++) scanPairs(get(node, i), `${path}[${i}]`, depth + 1);
      return;
    }
    for (const k of keysOf(node)) {
      if (FORBIDDEN.test(k) || PII.test(k)) continue;
      scanPairs(get(node, k), `${path}.${k}`, depth + 1);
    }
  };
  scanPairs(ctx, "context", 0);
  if (!pairHits.length) say("  (没找到)");
  for (const h of pairHits) {
    say(`  ★ ${h.path} —— Array(${h.len})，元素键: ${h.keys.join(", ")}`);
    say(`     [0] = ${safeJson(h.sample)}`);
  }
  say("");

  /* ---------------- 3. MOQ / 起批量 ---------------- */
  say("### 3. MOQ / 起批量候选");
  const orderParamModel = get(dataJson, "orderParamModel");
  if (orderParamModel) {
    say("  --- dataJson.orderParamModel 全文 ---");
    say(safeJson(orderParamModel));
  } else {
    say("  (orderParamModel 不存在)");
  }
  say("");
  const limit = get(dataJson, "orderParamLimitParam");
  if (limit) say(`  orderParamLimitParam : ${safeJson(limit)}`);
  say("");
  say("  另外看这几个（都出现过 beginAmount，需要判断哪个是「起批量」）：");
  const mp = get(get(data, "mainPrice"), "fields");
  const pm = mp && get(mp, "priceModel");
  if (pm) {
    say(`    priceModel.priceDisplayType : ${preview(get(pm, "priceDisplayType"))}`);
    say(`    priceModel.currentPrices     : ${safeJson(get(pm, "currentPrices"))}`);
  }
  const firstSku = (() => {
    const m = get(get(dataJson, "skuModel"), "skuInfoMap");
    const ks = m ? keysOf(m) : [];
    return ks.length ? get(m, ks[0]) : null;
  })();
  if (firstSku) {
    say(`    skuInfoMap[0].priceAmount    : ${preview(get(firstSku, "priceAmount"))}`);
    say(`    完整首个 SKU                 : ${safeJson(firstSku)}`);
  }
  say("");

  /* ---------------- 4. offerModelSign（40 键，属性最可能的隐藏处） ---------------- */
  say("### 4. dataJson.offerModelSign 全文（40 键，探针 E 没展开）");
  const oms = get(dataJson, "offerModelSign");
  if (oms) {
    for (const k of keysOf(oms)) {
      if (FORBIDDEN.test(k) || PII.test(k)) {
        say(`  ${k} : [已略过]`);
        continue;
      }
      const v = get(oms, k);
      say(`  ${k} : ${preview(v)}`);
    }
    say("");
    say("  --- 全文（截断） ---");
    say(safeJson(oms));
  } else {
    say("  (offerModelSign 不存在)");
  }
  say("");

  /* ---------------- 5. tempModel 全文 ---------------- */
  say("### 5. dataJson.tempModel 全文");
  const tm = get(dataJson, "tempModel");
  say(tm ? safeJson(tm) : "  (tempModel 不存在)");
  say("");

  /* ---------------- 6. 字段类型汇总（字符串 vs 数字） ---------------- */
  say("### 6. 字段类型汇总 —— 价格相关的都是字符串，取数必须 Number()");
  const skuMap = get(get(dataJson, "skuModel"), "skuInfoMap");
  const names = skuMap ? keysOf(skuMap) : [];
  if (names.length) {
    const s = get(skuMap, names[0]);
    say(`  以 skuInfoMap["${names[0]}"] 为例：`);
    for (const k of keysOf(s)) {
      const v = get(s, k);
      if (v === null || typeof v !== "object") say(`    ${k.padEnd(18, " ")}: ${typeof v}  ${preview(v)}`);
    }
  }
  say("");
  say("  priceModel 各数组元素的 beginAmount 类型（同一份数据里字符串/数字混用）：");
  if (pm) {
    for (const arrName of ["currentPrices", "originalPrices"]) {
      const arr = get(pm, arrName);
      if (Array.isArray(arr) && arr.length) {
        const el = get(arr, 0);
        say(`    ${arrName}[0].beginAmount : ${typeof get(el, "beginAmount")}  ${preview(get(el, "beginAmount"))}`);
        say(`    ${arrName}[0].price        : ${typeof get(el, "price")}  ${preview(get(el, "price"))}`);
      }
    }
  }
  const opwp = mp && get(mp, "originalPricesWithoutPromotion");
  if (Array.isArray(opwp) && opwp.length) {
    const el = get(opwp, 0);
    say(`    originalPricesWithoutPromotion[0].beginAmount : ${typeof get(el, "beginAmount")}  ${preview(get(el, "beginAmount"))}`);
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
