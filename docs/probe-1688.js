/**
 * 1688 商品详情页字段探针
 *
 * 用途：找出商品数据在页面里挂在哪个全局对象上、以及各字段的确切路径。
 * 这是 Phase 0 的产出，extension 的字段映射表以它的结果为准。
 *
 * 用法：打开一个真实的 https://detail.1688.com/offer/<offerId>.html，
 *       F12 → Console → 粘贴「探针 A」全文 → 回车。
 *       然后按输出里的提示，需要时再跑「探针 B」。
 *
 * 安全约束（与后端的数据最小化原则一致）：
 *   只读页面对象，不发任何请求，不写任何东西。
 *   打印时会**主动跳过** cookie / token / session / 签名 之类的键，
 *   只显示 "[已略过]"。输出可以直接贴给别人。
 */
(() => {
  /* ============ 探针 A：结构扫描 ============ */

  /** 命中这些名字的键才值得看 —— 全量 dump 会让输出长到没法读 */
  const INTERESTING =
    /(title|subject|name|price|amount|range|sku|spec|prop|attr|image|img|pic|photo|url|seller|supplier|company|shop|member|moq|minorder|begin|end|quantity|stock|inventory|weight|volume|size|length|width|height|desc|detail|offerid|id$)/i;

  /**
   * 这些键一律不看，也不打印值 —— 采集不该碰它们。
   *
   * 用词边界而不是裸 "sign"/"auth"：1688 的数据里有 consign（代销）、
   * offerSign（报价标记）这类正常字段，裸匹配会把它们一起误伤掉。
   * 上一轮就因此漏掉了一整个模块。
   */
  const FORBIDDEN =
    /(cookie|token|session|passwd|password|secret|csrf|ticket|_m_h5|\bsign\b|signature|\bauth(orization)?\b)/i;

  const MAX_DEPTH = 6;
  const MAX_KEYS_PER_OBJ = 60;
  const MAX_LINES = 240;
  const MAX_ARRAY_SAMPLE = 2;

  const lines = [];
  let truncated = false;

  const preview = (v) => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return `Array(${v.length})`;
    const t = typeof v;
    if (t === "string") {
      const s = v.length > 70 ? `${v.slice(0, 70)}…` : v;
      return `"${s}" (len=${v.length})`;
    }
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "object") return `Object{${Object.keys(v).length}}`;
    return t;
  };

  const seen = new WeakSet();

  const walk = (node, path, depth) => {
    if (lines.length >= MAX_LINES) {
      truncated = true;
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    let keys;
    try {
      keys = Array.isArray(node)
        ? node.slice(0, MAX_ARRAY_SAMPLE).map((_, i) => i)
        : Object.keys(node).slice(0, MAX_KEYS_PER_OBJ);
    } catch {
      return;
    }

    for (const k of keys) {
      if (typeof k === "string" && FORBIDDEN.test(k)) {
        lines.push(`${path}.${k} : [已略过]`);
        continue;
      }
      let v;
      try {
        v = node[k];
      } catch {
        continue; // getter 抛错
      }
      const p = Array.isArray(node) ? `${path}[${k}]` : `${path}.${k}`;
      const hit = typeof k === "string" && INTERESTING.test(k);
      if (hit) lines.push(`${p} : ${preview(v)}`);
      if (v && typeof v === "object" && depth < MAX_DEPTH) walk(v, p, depth + 1);
    }
  };

  console.log("%c=== 1. 候选全局对象 ===", "font-weight:bold;font-size:14px");
  const candidates = Object.keys(window).filter((k) =>
    /data|context|init|global|model|offer|detail|raw|sku|page/i.test(k),
  );
  console.log(candidates.length ? candidates.join(", ") : "(没有任何可疑的全局对象)");

  console.log("%c=== 2. 逐个展开 ===", "font-weight:bold;font-size:14px");
  for (const key of candidates) {
    let obj;
    try {
      obj = window[key];
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    lines.length = 0;
    truncated = false;
    walk(obj, `window.${key}`, 0);

    console.log(`%c--- window.${key} ---`, "font-weight:bold;color:#0a7");
    console.log(
      lines.length ? lines.join("\n") : "(没有命中任何感兴趣字段名的键)",
    );
    if (truncated) console.log(`… 输出被截断在 ${MAX_LINES} 行`);
  }

  console.log(
    "%c=== 3. 阶梯价专项（最关键，形状没有任何来源） ===",
    "font-weight:bold;font-size:14px",
  );
  const priceKeys = [];
  const collectPriceKeys = (node, path, depth) => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
      if (/price|amount|range|begin|end|ladder|tier/i.test(k)) {
        priceKeys.push(`${path}.${k}`);
      }
      try {
        if (node[k] && typeof node[k] === "object") {
          collectPriceKeys(node[k], `${path}.${k}`, depth + 1);
        }
      } catch {
        /* ignore */
      }
    }
  };
  for (const key of candidates) {
    try {
      if (window[key] && typeof window[key] === "object") {
        collectPriceKeys(window[key], `window.${key}`, 0);
      }
    } catch {
      /* ignore */
    }
  }
  console.log(priceKeys.length ? priceKeys.join("\n") : "(没找到价格相关路径)");
  console.log("\n下一步：对上面最像的路径跑 JSON.stringify，例如");
  console.log('  JSON.stringify(window.context.skuRangePrices, null, 2)');
  console.log('  JSON.stringify(window.context.data?.skuInfos, null, 2)');

  console.log(
    "\n%c=== 4. 图片专项 ===",
    "font-weight:bold;font-size:14px",
  );
  const imgUrls = new Set();
  const collectImgs = (node, depth) => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /^(\/\/|https?:).*\.(jpg|jpeg|png|webp)/i.test(v)) {
        imgUrls.add(`${k}: ${v.slice(0, 90)}`);
      } else if (v && typeof v === "object") {
        collectImgs(v, depth + 1);
      }
    }
  };
  for (const key of candidates) {
    try {
      collectImgs(window[key], 0);
    } catch {
      /* ignore */
    }
  }
  console.log(`页面上抓到的图片 URL 样例（共 ${imgUrls.size} 条，显示前 12 条）：`);
  console.log([...imgUrls].slice(0, 12).join("\n") || "(没抓到)");

  console.log(
    "\n%c=== 5. 未登录对照 ===",
    "font-weight:bold;font-size:14px",
  );
  console.log(
    "记下上面的价格结果，然后用隐身窗口打开同一个链接重跑本脚本。\n" +
      "如果隐身窗口里价格路径存在但值为空/被隐藏，说明未登录拿不到价格，\n" +
      "UI 需要做降级提示（计划里的风险 #5）。",
  );
})();
