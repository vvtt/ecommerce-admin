/**
 * 1688 探针 D：诊断「为什么 window.context 取不到」
 *
 * 起因：探针 A 在商品页上明明找到了 window.context 和 window.FE_GLOBALS，
 * 探针 C 在（据称）同一个页面跑却报两者都不存在。
 * 这不是「页面改版」能解释的 —— 两个独立的全局同时消失，
 * 更像是脚本跑在了另一个页面 / 另一个 frame 上。
 *
 * 本脚本只做一件事：把「你在哪、window 上有什么」如实打出来，不做任何猜测。
 *
 * 用法：F12 → Console → 粘贴 → 回车。跑完可 copy(__PROBE_TEXT__) 复制全文。
 * 只读，不发请求。
 */
(() => {
  const out = [];
  const say = (s) => out.push(s);

  const get = (obj, key) => {
    try {
      return { ok: true, value: obj[key] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const line = (label, text) => say(`  ${label.padEnd(22, " ")}: ${text}`);

  /* ---------------- 0. 脚本自己是否在正常环境里 ---------------- */
  say("### 0. 执行环境");
  line("window === globalThis", window === globalThis);
  line("window.top === window.self", window.top === window.self);
  line("父子帧", `${window.top === window.self ? "顶层文档" : "!! 在 iframe 里（可能是问题所在）"}`);
  line("location.href", String(location.href));
  line("location.host", String(location.host));
  line("document.title", JSON.stringify(document.title));
  line("document.readyState", document.readyState);
  line("document.referrer", JSON.stringify(document.referrer));
  say("");

  /* ---------------- 1. 点名检查（区分「不存在」与「存在但抛错」） ---------------- */
  say("### 1. 候选全局逐个点名");
  say("  说明：\"不存在\" = 键本身不在 window 上；\"取值抛错\" = 键在、但 getter 抛异常。");
  say("        探针 C 里这两者会显示成同一句「不存在」，所以这里必须分开。");
  const CANDIDATES = [
    "context",
    "FE_GLOBALS",
    "rawData",
    "__INIT_DATA__",
    "__GLOBAL_DATA__",
    "iDetailData",
    "__NEXT_DATA__",
    "__NUXT__",
    "runParams",
    "pageData",
    "detailData",
    "__DETAIL__",
  ];
  for (const name of CANDIDATES) {
    const has = name in window;
    if (!has) {
      line(name, "不存在");
      continue;
    }
    const r = get(window, name);
    if (!r.ok) {
      line(name, `!! 存在但取值抛错: ${r.error}`);
    } else if (r.value === null) {
      line(name, "存在，值为 null");
    } else if (typeof r.value === "object") {
      let n = "?";
      try {
        n = Object.keys(r.value).length;
      } catch {
        /* ignore */
      }
      line(name, `存在，是对象，顶层 ${n} 个键`);
    } else {
      line(name, `存在，${typeof r.value} = ${String(r.value).slice(0, 60)}`);
    }
  }
  say("");

  /* ---------------- 2. window 上有没有名字沾边的键 ---------------- */
  say("### 2. window 上名字可疑的键");
  let allKeys = [];
  try {
    allKeys = Object.keys(window);
  } catch {
    /* ignore */
  }
  line("window 可枚举键总数", allKeys.length);
  const sus = allKeys.filter((k) =>
    /(context|global|data|init|model|offer|detail|sku|^__|preload|state)/i.test(k),
  );
  say(`  命中 ${sus.length} 个：`);
  for (const k of sus.slice(0, 80)) {
    const v = get(window, k);
    const preview = !v.ok
      ? "[取值抛错]"
      : v.value === null
        ? "null"
        : typeof v.value === "object"
          ? `Object{${(() => { try { return Object.keys(v.value).length; } catch { return "?"; } })()}}`
          : `${typeof v.value} = ${String(v.value).slice(0, 40)}`;
    say(`    ${k} : ${preview}`);
  }
  if (sus.length > 80) say(`    … 还有 ${sus.length - 80} 个未列出`);
  say("");

  /* ---------------- 3. 页面源码里到底有没有这些数据 ---------------- */
  say("### 3. 内联 <script> 里的痕迹");
  const scripts = document.querySelectorAll("script");
  line("<script> 标签数", scripts ? scripts.length : "(取不到)");
  let inlineChars = 0;
  const markers = {
    FE_GLOBALS: 0,
    "window.context": 0,
    dataJson: 0,
    skuPriceScale: 0,
    skuMap: 0,
    "offerId": 0,
    __INIT_DATA__: 0,
  };
  // 用索引循环而不是 for...of：不依赖 NodeList 实现 Symbol.iterator
  const scriptCount = scripts ? scripts.length : 0;
  for (let i = 0; i < scriptCount; i++) {
    const t = (scripts[i] && scripts[i].textContent) || "";
    if (!t) continue;
    inlineChars += t.length;
    for (const m of Object.keys(markers)) {
      if (t.includes(m)) markers[m]++;
    }
  }
  line("内联脚本总字符数", inlineChars);
  say("  各标记出现于多少个内联脚本中：");
  for (const m of Object.keys(markers)) {
    say(`    ${m.padEnd(20, " ")}: ${markers[m]}`);
  }
  say("");
  say("  判读：若 dataJson / skuMap 都是 0 —— 这份 HTML 里根本没有商品数据，");
  say("        说明服务端没吐详情页（多半是没登录、被反爬挡了，或这压根不是详情页）。");
  say("        若它们 > 0 而 window.context 取不到 —— 那就是执行上下文/frame 的问题。");
  say("");

  /* ---------------- 4. 是不是被挡了 ---------------- */
  say("### 4. 是不是被登录墙 / 反爬拦了");
  const href = String(location.href);
  line("URL 含 login", /login|signin/i.test(href));
  line("URL 含 x5sec/punish", /x5sec|punish|captcha|nocaptcha/i.test(href));
  line("滑块容器 #nc_1_wrapper", !!document.querySelector("#nc_1_wrapper"));
  line("登录框 .login-", !!document.querySelector("[class*='login-']"));
  let bodyText = "";
  try {
    bodyText = (document.body ? document.body.innerText : "").slice(0, 200);
  } catch {
    /* ignore */
  }
  line("body 文本前 200 字", JSON.stringify(bodyText));
  say("");

  /* ---------------- 5. 页面上的商品痕迹（DOM 层） ---------------- */
  say("### 5. DOM 层的商品痕迹");
  const probes = [
    "[class*='title']",
    "[class*='offer-title']",
    "[class*='price']",
    "[class*='sku']",
    "[class*='gallery']",
    "[class*='detail']",
    "img[src*='cbu01']",
    "img[src*='alicdn']",
  ];
  for (const sel of probes) {
    let n = "查询失败";
    try {
      n = document.querySelectorAll(sel).length;
    } catch {
      /* ignore */
    }
    line(sel, n);
  }
  say("  判读：若 cbu01/alicdn 图片数为 0，说明页面上连商品图都没渲染出来。");
  say("");

  /* ---------------- 输出 ---------------- */
  const text = out.join("\n");
  try {
    window.__PROBE_TEXT__ = text;
  } catch {
    /* ignore */
  }
  console.log(text);
  console.log(
    "%c↑ 想一键复制就再跑一句：  copy(__PROBE_TEXT__)",
    "font-weight:bold;color:#0a7",
  );
  return text;
})();
