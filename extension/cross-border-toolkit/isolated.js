/**
 * Cross-Border Sourcing —— ISOLATED world 浮层 + 桥接
 *
 * 职责：
 *   1. 生成随机 token，用握手事件交给 main-world.js（MAIN world 拿不到 chrome.*）
 *   2. 接收 main-world 解析好的载荷，渲染浮层
 *   3. 用户点按钮后经 background 上报后端
 *
 * 浮层用 Shadow DOM（closed）挂在页面右下角，避免与 1688 的 CSS 互相污染。
 * closed 模式让页面脚本拿不到 shadowRoot —— 它改不了浮层里的按钮和文案，
 * 也就没法诱导用户点一个「采集」其实发的是别的载荷。
 */
(() => {
  "use strict";

  if (/** @type {any} */ (window).__SC_ISOLATED_LOADED__) return;
  /** @type {any} */ (window).__SC_ISOLATED_LOADED__ = true;

  /* —— 合并版开关：popup 可关掉 1688 采集模块（关掉后刷新页面生效）—— */
  chrome.storage.local.get({ toolkitToggles: {} }, (s) => {
    const t = (s && s.toolkitToggles) || {};
    if (t.sourcing === false) return;
    __tkInit();
  });
  function __tkInit() {

  const EVT_BOOTSTRAP = "__sc_sourcing_bootstrap__";

  /**
   * 事件名随机 token。
   *
   * ⚠️ 说清楚它**不是硬边界**：页面脚本与我们同处一个 JS 环境，能监听
   * document 上的任何事件，也就能从握手事件里读到 token，然后伪造数据事件。
   * 它挡的是「随手写一段脚本往这个后台灌数据」这类情况。
   *
   * 真正的兜底在后端：载荷敏感字段递归校验，命中直接 400
   * （server/routes/sourcing.ts 的 findSensitiveKey；X-Collect-Token 已于 2026-10-24 移除）
   */
  const token =
    (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) +
    "_" +
    Date.now();

  const DATA_EVT = `__sc_data_${token}__`;

  /* ------------------------------------------------------------------ *
   * 浮层
   * ------------------------------------------------------------------ */

  const host = document.createElement("div");
  // all:initial 清掉 1688 可能命中的通配样式；后面的属性逐个覆盖回来
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; width: 312px;
      font: 12px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2328; background: #fff; border: 1px solid #d8dee4;
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.16); overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; background: #f6f8fa; border-bottom: 1px solid #d8dee4;
      font-weight: 600;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8c959f; flex: none; }
    .dot.ok { background: #1a7f37; }
    .dot.warn { background: #bf8700; }
    .dot.err { background: #cf222e; }
    .head .spacer { flex: 1; }
    .icon-btn {
      all: unset; cursor: pointer; color: #59636e; padding: 2px 5px;
      border-radius: 4px; font-size: 13px; line-height: 1;
    }
    .icon-btn:hover { background: #eaeef2; }
    .body { padding: 9px 10px; max-height: 46vh; overflow: auto; }
    .row { display: flex; gap: 6px; margin-bottom: 5px; align-items: baseline; }
    .k { color: #59636e; flex: none; min-width: 52px; }
    .v { flex: 1; word-break: break-all; }
    .muted { color: #59636e; }
    .warn-text { color: #9a6700; }
    .err-text { color: #cf222e; }
    .thumbs { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
    .thumbs img {
      width: 44px; height: 44px; object-fit: cover;
      border: 1px solid #d8dee4; border-radius: 4px; background: #f6f8fa;
    }
    .foot { padding: 8px 10px; border-top: 1px solid #d8dee4; background: #f6f8fa; }
    button.primary {
      all: unset; display: block; width: 100%; text-align: center; cursor: pointer;
      padding: 7px 0; border-radius: 6px; font-weight: 600; color: #fff;
      background: #1f883d;
    }
    button.primary:hover { background: #1a7f37; }
    button.primary[disabled] { background: #8c959f; cursor: default; }
    .msg { margin-top: 6px; min-height: 16px; }
    .link { color: #0969da; cursor: pointer; text-decoration: underline; }
  `;

  const panel = document.createElement("div");
  panel.className = "panel";
  shadow.append(style, panel);

  /**
   * `all:initial` 之后 host 自己不产生盒子，但保险起见把宿主也设成不含尺寸，
   * 免得 1688 的某个全局选择器把它撑开一条缝。
   */
  const mount = () => {
    if (!document.body) return;
    document.body.appendChild(host);
  };
  mount();

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  /** @type {ExtractResult | null} */
  let snapshot = null;
  /** 后端已有的同 offerId 记录（查重用），null = 没查过或不存在 */
  /** @type {{ collectedAt?: string } | null} */
  let existing = null;
  let checking = false;
  let uploading = false;
  /** 底部消息行（成功/失败的即时反馈） */
  let message = { text: "", kind: "" };

  /**
   * @param {unknown} value
   * @returns {string}
   */
  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
    );

  /**
   * @param {ExtractSummary} summary
   * @returns {string}
   */
  const priceRangeText = (summary) => {
    if (!summary) return "—";
    if (typeof summary.priceMin !== "number") return "—";
    return summary.priceMin === summary.priceMax
      ? `¥${summary.priceMin}`
      : `¥${summary.priceMin} ~ ¥${summary.priceMax}`;
  };

  const render = () => {
    // 解析中
    if (!snapshot) {
      panel.innerHTML = `
        <div class="head"><span class="dot"></span><span>货源采集</span></div>
        <div class="body muted">正在解析页面数据…</div>`;
      return;
    }

    // 没解析到商品
    if (!snapshot.ok) {
      panel.innerHTML = `
        <div class="head">
          <span class="dot err"></span><span>货源采集</span>
          <span class="spacer"></span>
          <button class="icon-btn" data-act="refresh" title="重新解析">↻</button>
        </div>
        <div class="body">
          <div class="err-text">${escapeHtml(snapshot.warnings[0] ?? "未识别到商品数据")}</div>
        </div>`;
      wire();
      return;
    }

    const s = snapshot.summary;
    const hasWarnings = snapshot.warnings.length > 0;

    const warningHtml = hasWarnings
      ? `<div class="warn-text">⚠ ${escapeHtml(snapshot.warnings.join("；"))}</div>`
      : "";

    const thumbs = (snapshot.offer.images.main ?? [])
      .slice(0, 6)
      .map((url) => `<img src="${escapeHtml(url)}" alt="">`)
      .join("");

    // 按钮文案取决于后端是否已有这条记录
    let buttonLabel = "采集到货源库";
    if (uploading) buttonLabel = "上传中…";
    else if (existing) buttonLabel = "更新已有记录";

    const existsHint = existing
      ? `<div class="muted">货源库已有此商品（采集于 ${escapeHtml(
          String(existing.collectedAt ?? "").slice(0, 19).replace("T", " "),
        )}）</div>`
      : "";

    const messageHtml = message.text
      ? `<div class="msg ${message.kind === "err" ? "err-text" : "muted"}">${escapeHtml(message.text)}</div>`
      : "";

    panel.innerHTML = `
      <div class="head">
        <span class="dot ${hasWarnings ? "warn" : "ok"}"></span>
        <span>${hasWarnings ? "部分字段缺失" : "已解析"}</span>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="refresh" title="重新解析">↻</button>
        <button class="icon-btn" data-act="close" title="收起">✕</button>
      </div>
      <div class="body">
        <div class="row"><span class="k">标题</span><span class="v">${escapeHtml(s.title || "—")}</span></div>
        <div class="row"><span class="k">offerId</span><span class="v">${escapeHtml(s.offerId || "—")}</span></div>
        <div class="row"><span class="k">供应商</span><span class="v">${escapeHtml(s.supplierName || "—")}</span></div>
        <div class="row"><span class="k">价格</span><span class="v">${escapeHtml(priceRangeText(s))}
          <span class="muted">（${escapeHtml(s.priceMode)} · ${s.skuCount} 个 SKU）</span></span></div>
        <div class="row"><span class="k">起批量</span><span class="v">${s.moq ?? "—"}</span></div>
        <div class="row"><span class="k">图片</span><span class="v">主图 ${s.mainCount} · 详情 ${s.detailCount}</span></div>
        <div class="row"><span class="k">属性</span><span class="v">${s.attributeCount} 条${
          typeof s.weightGram === "number" ? ` · 重量 ${s.weightGram}g` : ""
        }</span></div>
        ${warningHtml}
        ${existsHint}
        <div class="thumbs">${thumbs}</div>
      </div>
      <div class="foot">
        <button class="primary" data-act="collect" ${uploading ? "disabled" : ""}>${buttonLabel}</button>
        ${messageHtml}
      </div>`;

    wire();
  };

  const wire = () => {
    for (const element of panel.querySelectorAll("[data-act]")) {
      element.addEventListener("click", () => {
        const action = element.getAttribute("data-act");
        if (action === "close") {
          host.remove();
          return;
        }
        if (action === "refresh") {
          snapshot = null;
          existing = null;
          message = { text: "", kind: "" };
          render();
          document.dispatchEvent(new CustomEvent(EVT_BOOTSTRAP, { detail: { token, refresh: true } }));
          return;
        }
        if (action === "collect") void collect();
      });
    }
  };

  /* ------------------------------------------------------------------ *
   * 与 background 通信
   * ------------------------------------------------------------------ */

  /**
   * 扩展重新加载后，已打开页面里的 content script 会失去 chrome.runtime ——
   * 此时 sendMessage 抛错而不是返回 undefined。捕获它并给出可操作的提示，
   * 否则用户只会看到按钮没反应。
   *
   * @param {any} payload
   * @returns {Promise<any>}
   */
  async function send(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      return {
        ok: false,
        error: `扩展上下文已失效 —— 在 chrome://extensions 刷新扩展后重新加载本页（${
          error instanceof Error ? error.message : String(error)
        }）`,
      };
    }
  }

  /**
   * 查重：后端已有就改按钮文案。失败不打扰用户（收藏仍然可用）
   *
   * @param {string} offerId
   * @returns {Promise<void>}
   */
  async function checkExisting(offerId) {
    if (!offerId || checking) return;
    checking = true;
    const response = await send({ type: "check", offerId });
    checking = false;
    if (response?.ok && response.exists) {
      existing = response.offer;
      render();
    }
  }

  async function collect() {
    if (!snapshot?.offer || uploading) return;

    uploading = true;
    message = { text: "", kind: "" };
    render();

    const response = await send({ type: "collect", offer: snapshot.offer });

    uploading = false;
    if (response?.ok) {
      message = { text: response.action === "updated" ? "已更新货源库记录" : "已采集到货源库", kind: "" };
      // 采完就当已存在，按钮随之变成「更新已有记录」
      existing = response.offer ?? { collectedAt: new Date().toISOString() };
    } else {
      message = { text: response?.error ?? "采集失败", kind: "err" };
    }
    render();
  }

  /* ------------------------------------------------------------------ *
   * 接收 main-world 的解析结果
   * ------------------------------------------------------------------ */

  document.addEventListener(DATA_EVT, (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail !== "object") return;

    const warnings = Array.isArray(detail.warnings) ? detail.warnings : [];

    // 载荷声称 ok 但没带 offer 时按失败处理 —— 否则下面渲染会读到 undefined
    if (detail.ok && detail.offer) {
      snapshot = { ok: true, offer: detail.offer, summary: detail.summary, warnings };
    } else {
      snapshot = { ok: false, offer: null, warnings };
    }
    render();

    if (snapshot.ok) void checkExisting(snapshot.summary.offerId);
  });

  /* 发握手，把 token 交给 MAIN world */
  render();
  document.dispatchEvent(new CustomEvent(EVT_BOOTSTRAP, { detail: { token } }));
  }
})();
