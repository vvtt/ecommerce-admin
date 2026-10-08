/**
 * Cross-Border Sourcing —— background service worker
 *
 * 职责很窄：
 *   - 存后端地址 + collect token（chrome.storage.local）
 *   - 查重：GET  /api/sourcing/lookup
 *   - 上报：POST /api/sourcing/collect，带 X-Collect-Token
 *
 * 它是扩展里**唯一**碰后端的地方。isolated.js 不直接 fetch 后端，
 * 两个原因：一是 content script 发跨域请求要页面参与 CORS，而 service worker
 * 有 host_permissions 就能直接发；二是 token 只存在 background 这一处，
 * 不用把它注入到页面上下文里。
 */

/** 默认后端地址。改这里同时要改 manifest 的 host_permissions，见 README */
const DEFAULT_BACKEND_URL = "http://localhost:3000";

const SETTINGS_KEY = "sourcingSettings";

/** 查重要快 —— 它只是给按钮换个文案，卡住不如先显示「采集」 */
const CHECK_TIMEOUT_MS = 8_000;
/** 上报要传完整载荷，图片由后端异步下载，所以不用等太久，但也不能太短 */
const COLLECT_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} Settings
 * @property {string} backendUrl
 * @property {string} collectToken
 *
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {unknown} [body]
 * @property {string} [token]
 * @property {number} timeout
 */

/** @returns {Promise<Settings>} */
async function readSettings() {
  const stored = /** @type {Record<string, any>} */ (await chrome.storage.local.get(SETTINGS_KEY));
  const settings = stored?.[SETTINGS_KEY] ?? {};
  return {
    backendUrl: normalizeBase(settings.backendUrl) || DEFAULT_BACKEND_URL,
    collectToken: typeof settings.collectToken === "string" ? settings.collectToken : "",
  };
}

/**
 * 去掉末尾斜杠，避免拼出 `http://localhost:3000//api/...`
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBase(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/**
 * 把各种失败翻译成**能照着做**的提示。
 *
 * fetch 抛出的 TypeError 只说明「没连上」，用户看到 "Failed to fetch"
 * 完全不知道下一步该干嘛 —— 而这里三种失败的原因和处置方式完全不同。
 *
 * @param {unknown} error
 * @param {string} base
 * @returns {string}
 */
function describeNetworkError(error, base) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return `请求超时。确认后端在 ${base} 且响应正常。`;
  return `连不上后端 ${base}。确认已运行 npm run dev，且该地址在扩展的 host_permissions 里（改过地址要一起改 manifest.json 并重新加载扩展）。`;
}

/**
 * 统一的请求封装。
 *
 * @param {string} base
 * @param {string} path 以 / 开头的接口路径
 * @param {RequestOptions} options
 * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
 */
async function request(base, path, { method = "GET", body, token, timeout }) {
  const url = `${base}${path}`;
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Collect-Token"] = token;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    return { ok: false, error: describeNetworkError(error, base) };
  }

  // 401 是配置问题不是网络问题，单独说清楚 —— 否则用户会一直重启后端
  if (response.status === 401) {
    return {
      ok: false,
      error: "采集 token 不对。点扩展图标 → 设置页，填入后端启动时打印的 token。",
    };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return { ok: false, error: payload?.error ?? `后端返回 HTTP ${response.status}` };
  }

  return { ok: true, data: payload };
}

/* ------------------------------------------------------------------ *
 * 消息处理
 * ------------------------------------------------------------------ */

/** @type {Record<string, (message: any) => Promise<any>>} */
const handlers = {
  /** 扩展上下文是否可用 + 当前配置（设置页用来回填表单） */
  async getSettings() {
    return { ok: true, settings: await readSettings() };
  },

  async saveSettings(message) {
    const settings = {
      backendUrl: normalizeBase(message.backendUrl) || DEFAULT_BACKEND_URL,
      collectToken: typeof message.collectToken === "string" ? message.collectToken.trim() : "",
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return { ok: true, settings };
  },

  /** 查重：后端是否已有这个 offerId。失败不影响采集，所以只回 ok:false 不弹错 */
  async check(message) {
    const offerId = String(message.offerId ?? "").trim();
    if (!offerId) return { ok: false, error: "缺少 offerId" };

    const { backendUrl } = await readSettings();
    const result = await request(
      backendUrl,
      `/api/sourcing/lookup?offerId=${encodeURIComponent(offerId)}&platform=1688`,
      { timeout: CHECK_TIMEOUT_MS },
    );

    if (!result.ok) return result;
    return { ok: true, exists: Boolean(result.data?.exists), offer: result.data?.offer ?? null };
  },

  /**
   * 设置页的「测试连接」。
   *
   * 打 /api/sourcing/stats 而不是 /lookup —— 它是只读的，**不需要 token**，
   * 所以能单独验证「地址通不通」这一件事。把地址问题和 token 问题分开暴露，
   * 用户就不用猜到底是哪一个填错了。
   */
  async testConnection(message) {
    const base = normalizeBase(message.backendUrl) || DEFAULT_BACKEND_URL;
    const result = await request(base, "/api/sourcing/stats", { timeout: CHECK_TIMEOUT_MS });
    if (!result.ok) return result;
    const stats = result.data ?? {};
    return { ok: true, message: `连接正常。货源库现有 ${stats.total ?? "?"} 条记录。` };
  },

  async collect(message) {
    const offer = message.offer;
    if (!offer || typeof offer !== "object") return { ok: false, error: "没有可上报的数据" };
    if (!offer.offerId) return { ok: false, error: "载荷缺少 offerId" };

    const { backendUrl, collectToken } = await readSettings();
    if (!collectToken) {
      return { ok: false, error: "还没配采集 token。点扩展图标 → 设置页填写。" };
    }

    const result = await request(backendUrl, "/api/sourcing/collect", {
      method: "POST",
      body: offer,
      token: collectToken,
      timeout: COLLECT_TIMEOUT_MS,
    });

    if (!result.ok) return result;
    return { ok: true, action: result.data?.action ?? "created", offer: result.data?.offer ?? null };
  },
};

/**
 * 用 `return true` + sendResponse 而不是让监听器返回 Promise：
 * 后者在旧版 Chrome 上不生效，会让调用方永远等不到回音。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message && handlers[message.type];

  if (!handler) {
    sendResponse({ ok: false, error: `未知的消息类型: ${message?.type}` });
    return false;
  }

  handler(message)
    .then(sendResponse)
    .catch((/** @type {any} */ error) => {
      console.error("[sourcing] background 处理失败", error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });

  return true; // 保持消息通道打开，等异步 handler 结束
});

/* ------------------------------------------------------------------ *
 * 安装与工具栏
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  // 只在真的没配过时写默认值，避免覆盖用户已填的地址
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored?.[SETTINGS_KEY]) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { backendUrl: DEFAULT_BACKEND_URL, collectToken: "" },
    });
  }
});

/** 这个扩展没有 popup，点图标直接开设置页（token 没填时最常见的动作） */
chrome.action?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
