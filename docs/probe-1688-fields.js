/**
 * 1688 商品页字段探针 C：一次性结构导出
 *
 * 用法：1688 商品详情页 → F12 → Console → 粘贴本文件 → 回车。
 *      输出是一整块文本，直接全选复制即可。
 *      也可以跑 copy(__PROBE_TEXT__) 一键复制到剪贴板。
 *
 * 跟探针 A 的区别：
 *   - 只打结构 + 短预览，不打大段 JSON（不再被运费/促销噪声淹没）
 *   - 数组会展开 [0] 一层 —— 阶梯价、SKU 列表的真实形状靠这个看出来
 *   - 全部包在 try/catch 里：1688 的对象上有会抛错的 getter，
 *     探针 A 就是被这种 getter 打断过一次
 *
 * 安全约束：只读，不发请求。命中 cookie/token/session 类键名会跳过。
 *
 * 注意：本脚本是 async 的（要等 window.context 就绪），所以控制台的完成值
 * 是 Promise 而不是文本。文本存在 window.__PROBE_TEXT__，跑完用
 * copy(__PROBE_TEXT__) 取。
 */
(async () => {
  const MAX_KEYS = 45;
  const MAX_JSON_CHARS = 1200;
  /**
   * 输出总行数上限。
   *
   * 只靠 MAX_KEYS 不够 —— 那是「每层最多几个键」，而 shape 会递归三层，
   * 最多能刷出 45³ 行。探针 A 就是被行数预算坑过一次（预算被运费险吃光，
   * 关键模块没展开到），这次两头都要卡：单层限宽 + 整体限长。
   */
  const MAX_LINES = 500;

  /** 只看这些名字 */
  const WANT =
    /(sku|price|amount|image|gallery|pic|photo|title|subject|seller|supplier|company|member|shop|attribute|prop|weight|unit|volume|size|dimension|moq|minorder|begin|inventory|stock|quantity)/i;

  /** 打全文的范围再收窄一层，只挑最关键的 */
  const WANT_JSON = /(sku|price)/i;

  /** 这些模块只列键名，不往下展开（它们是运费险/促销说明，一行能有几百字） */
  const NOISY = /^(shippingServices|description|submitOrder|screen|consign|productPackInfo|activityModel)$/;

  /** 用词边界，避免把 consign / offerSign 这类正常字段误伤 */
  const FORBIDDEN =
    /(cookie|token|session|passwd|password|secret|csrf|ticket|_m_h5|\bsign\b|signature|\bauth(orization)?\b)/i;

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

  /** 所有属性访问都走这里 —— 页面对象上的 getter 会抛错 */
  const get = (obj, key) => {
    try {
      return obj[key];
    } catch {
      return undefined;
    }
  };

  const preview = (v) => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return `Array(${v.length})`;
    const t = typeof v;
    if (t === "string") return `"${v.length > 60 ? `${v.slice(0, 60)}…` : v}"`;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "object") {
      let n = "?";
      try {
        n = Object.keys(v).length;
      } catch {
        /* ignore */
      }
      return `Object{${n}}`;
    }
    return t;
  };

  const safeJson = (v) => {
    let s;
    try {
      s = JSON.stringify(v, null, 1);
    } catch {
      return "(无法序列化)";
    }
    if (s === undefined) return "(undefined)";
    return s.length > MAX_JSON_CHARS
      ? `${s.slice(0, MAX_JSON_CHARS)}\n  … 截断（原文 ${s.length} 字符）`
      : s;
  };

  const keysOf = (o) => {
    try {
      return Object.keys(o);
    } catch {
      return [];
    }
  };

  /**
   * 结构展开。
   * 数组只展开第 0 个元素 —— 形状信息全在那里，展开全部只会让输出爆炸。
   */
  const shape = (node, path, depth) => {
    if (node === null || typeof node !== "object") return;
    if (depth > 3) return;

    if (Array.isArray(node)) {
      if (!node.length) {
        say(`${path} : Array(0)`);
        return;
      }
      // 不重复打 "Array(n)" —— 调用方刚刚已经打过一行了
      say(`${path} → 展开 [0] 看形状：`);
      const first = get(node, 0);
      if (first && typeof first === "object") shape(first, `${path}[0]`, depth + 1);
      else say(`  [0] : ${preview(first)}`);
      return;
    }

    const ks = keysOf(node).slice(0, MAX_KEYS);
    for (const k of ks) {
      if (FORBIDDEN.test(k)) {
        say(`${path}.${k} : [已略过]`);
        continue;
      }
      const v = get(node, k);
      say(`${path}.${k} : ${preview(v)}`);
      if (v && typeof v === "object" && !NOISY.test(k) && WANT.test(k)) {
        shape(v, `${path}.${k}`, depth + 1);
      }
    }
  };

  /**
   * 读 window.context，并把「三种失败」区分开。
   *
   * 上一版直接用 get() 读，而 get() 会把「不存在」和「getter 抛错」都变成
   * undefined —— 报告里只剩一句「不存在」，看着像页面改版，实则可能是别的原因。
   */
  const readContext = () => {
    if (!("context" in window)) return { state: "absent" };
    try {
      const v = window.context;
      return v ? { state: "ok", value: v } : { state: "empty" };
    } catch {
      return { state: "threw" };
    }
  };

  /**
   * 等数据挂上再读。
   *
   * 起因：广告落地页（`src=zhanwai` / `sk=sem` 这类带 tracking 参数的 URL）
   * 经常先渲染一屏再跳转，落地过程中 window.context 尚未存在。跑早了会得到
   * 一份全 false 的报告，长得和「1688 改版了」一模一样 —— 实际上只是时机不对。
   * 所以先等，最多 10 秒；属性存在但 getter 抛错则不等（等也不会变好）。
   */
  const WAIT_MS = 10000;
  const startedAt = Date.now();
  let probe = readContext();
  while (
    (probe.state === "absent" || probe.state === "empty") &&
    Date.now() - startedAt < WAIT_MS
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    probe = readContext();
  }
  const waitedMs = Date.now() - startedAt;

  const ctx = probe.state === "ok" ? probe.value : undefined;
  const root = ctx && get(ctx, "result");
  const data = root && get(root, "data");
  const dj = data && get(get(get(data, "Root"), "fields"), "dataJson");

  /* ---------------- 0. 环境 ---------------- */
  say("### 0. 环境");
  say(`location.href        : ${String(location.href).slice(0, 110)}`);
  say(`document.readyState  : ${document.readyState}`);
  say(`顶层文档             : ${window.top === window.self ? "是" : "!! 在 iframe 里"}`);
  if (waitedMs >= 250) {
    say(`等待 window.context  : ${waitedMs}ms${ctx ? "（等到了）" : "（超时仍未出现）"}`);
  }
  say(`window.context       : ${probe.state}`);
  say(`has window.context   : ${!!ctx}`);
  say(`context.result      : ${!!root}`);
  say(`result.endpoint     : ${root ? preview(get(root, "endpoint")) : "(无)"}`);
  say(`result.data         : ${!!data}`);
  say(`Root.fields.dataJson: ${!!dj}`);
  say("");

  if (!ctx) {
    say(
      probe.state === "threw"
        ? "!! window.context 存在，但读取时抛错（多半是页面把它定义成了会抛的 getter）。"
        : `!! window.context 取不到（${probe.state}），已等 ${waitedMs}ms。`,
    );
    say("   先跑 docs/probe-1688-diag.js 定位：是页面不对、frame 不对，还是真没数据。");
    say("   若确认是详情页但全局对象变了，再跑 docs/probe-1688-network.js 走接口录制。");
  }

  /* ---------------- 1. 价格/SKU 全文（最关键，放最前） ---------------- */
  say("### 1. 价格与 SKU 的 JSON 全文（有截断）");
  if (dj) {
    for (const k of keysOf(dj)) {
      if (!WANT_JSON.test(k) || FORBIDDEN.test(k)) continue;
      say("");
      say(`--- dataJson.${k} ---`);
      say(safeJson(get(dj, k)));
    }
  } else {
    say("  (dataJson 不存在)");
  }
  say("");

  /* ---------------- 2. dataJson 顶层键 ---------------- */
  say("### 2. Root.fields.dataJson 顶层键");
  if (dj) {
    for (const k of keysOf(dj)) {
      if (FORBIDDEN.test(k)) {
        say(`  ${k} : [已略过]`);
        continue;
      }
      say(`  ${k} : ${preview(get(dj, k))}`);
    }
  } else {
    say("  (dataJson 不存在)");
  }
  say("");

  /* ---------------- 3. result.data 模块 ---------------- */
  say("### 3. result.data 下的模块");
  say(data ? keysOf(data).join(", ") : "(无)");
  say("");

  /* ---------------- 4. 渲染层模块的 fields 键名 ---------------- */
  say("### 4. result.data 各模块的 fields 键名");
  if (data) {
    for (const k of keysOf(data)) {
      if (FORBIDDEN.test(k)) continue;
      const mod = get(data, k);
      const fields = mod && get(mod, "fields");
      if (!fields) continue;
      say(`  ${k} : ${keysOf(fields).join(", ")}`);
    }
  }
  say("");

  /* ---------------- 5. FE_GLOBALS ---------------- */
  say("### 5. window.FE_GLOBALS");
  const fe = get(window, "FE_GLOBALS");
  if (fe) {
    for (const k of keysOf(fe)) {
      if (FORBIDDEN.test(k)) {
        say(`  ${k} : [已略过]`);
        continue;
      }
      say(`  ${k} : ${preview(get(fe, k))}`);
    }
  } else {
    say("  (不存在)");
  }
  say("");

  /* ---------------- 6. dataJson 关键分支展开（最可能撑爆，放最后） ---------------- */
  say("### 6. dataJson 关键分支（数组展开 [0]）");
  if (dj) {
    for (const k of keysOf(dj)) {
      if (!WANT.test(k) || FORBIDDEN.test(k)) continue;
      const v = get(dj, k);
      // 标量（title / onePiecePrice）在第 2 段已经打过值了，这里展开不出任何东西，
      // 打一个空标题只会让输出显得像出错
      if (!v || typeof v !== "object") continue;
      say("");
      say(`--- dataJson.${k} ---`);
      shape(v, `dataJson.${k}`, 0);
    }
  }

  /* ---------------- 输出 ---------------- */
  const text = out.join("\n");
  try {
    window.__PROBE_TEXT__ = text;
  } catch {
    /* ignore */
  }

  console.log(text);
  console.log(
    `%c↑ 共 ${out.length} 行。想一键复制到剪贴板就再跑一句：  copy(__PROBE_TEXT__)`,
    "font-weight:bold;color:#0a7",
  );

  // 返回文本本身，这样控制台的完成值不再是 undefined
  return text;
})();
