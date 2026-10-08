/**
 * 1688 商品页接口录制探针（探针 B）
 *
 * 用途：找出商品主体数据走的是哪个 mtop 接口。
 * 只有在「探针 A 找不到全局数据对象」时才需要它 —— 那就得靠 hook XHR 兜底。
 *
 * 用法：
 *   1. 打开 1688 商品页，F12 → Console → 粘贴本文件全文 → 回车
 *   2. 脚本会开始录制，然后**按 F5 刷新页面**（首屏请求只在加载时发一次）
 *   3. 页面加载完等 3 秒，跑 window.__probeReport()
 *
 * 安全约束：只**记录** URL，不篡改请求与响应，不读任何请求头
 * （Cookie 是 forbidden header，页面 JS 本来就读不到，这里也不去碰）。
 */
(() => {
  const MAX = 80;
  const hits = [];

  const isApi = (url) =>
    typeof url === "string" &&
    /h5api\.m\.1688\.com|mtop|\.1688\.com\/(h5|api|offer|detail)/i.test(url);

  const record = (url, via) => {
    if (hits.length >= MAX || !isApi(url)) return;
    const api = (url.match(/[?&]api=([^&]+)/) || [])[1];
    hits.push({
      via,
      api: api ? decodeURIComponent(api) : "(无 api 参数)",
      url: url.length > 150 ? `${url.slice(0, 150)}…` : url,
    });
  };

  /* ---- hook XHR ---- */
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      record(String(url), "xhr");
    } catch {
      /* 绝不能让 hook 影响页面 */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  /* ---- hook fetch ---- */
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        record(typeof input === "string" ? input : input?.url, "fetch");
      } catch {
        /* ignore */
      }
      return origFetch.call(this, input, init);
    };
  }

  window.__probeHits = hits;

  window.__probeReport = () => {
    console.log("%c=== 录制到的接口 ===", "font-weight:bold;font-size:14px");
    if (!hits.length) {
      console.log("(没录到任何接口)");
      return;
    }
    // 按接口名去重，只关心有哪些接口，不关心调了几次
    const byApi = new Map();
    for (const h of hits) {
      if (!byApi.has(h.api)) byApi.set(h.api, h);
    }
    for (const h of byApi.values()) {
      console.log(`[${h.via}] ${h.api}`);
      console.log(`      ${h.url}`);
    }
    console.log(
      `\n共 ${hits.length} 次调用，去重后 ${byApi.size} 个接口。\n` +
        "把 mtop.xxx.yyy 这些名字记下来 —— 商品主体的那个就是要 hook 的目标。",
    );
  };

  console.log(
    "%c探针 B 已开始录制。现在按 F5 刷新页面，加载完等 3 秒，然后跑： window.__probeReport()",
    "font-weight:bold;color:#0a7;font-size:13px",
  );
})();
