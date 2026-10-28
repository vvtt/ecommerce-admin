/**
 * 跨境电商工具箱 —— background service worker（三合一）
 *
 * 职责：
 *   - 统一的后端配置（toolkitSettings，自动迁移两个旧插件的配置）
 *   - 消息路由：1688 采集 / Shopee 采集 / 全网图搜
 *   - 右键菜单「用 1688 以图搜同款」（全网可用）
 *
 * 它是扩展里**唯一**碰后端的地方（图搜除外——那只开一个 1688 的标签页）。
 * content script 发跨域请求要页面参与 CORS，service worker 有 host_permissions 就能直接发。
 */
importScripts('lib.js');

const DEFAULT_BACKEND_URL = 'http://localhost:3000';
const SETTINGS_KEY = 'toolkitSettings';
/** 旧 sourcing 插件留在 storage.local 的键，首次启动时迁移 */
const LEGACY_SOURCING_KEY = 'sourcingSettings';

/** 查重要快 —— 它只是给按钮换个文案，卡住不如先显示「采集」 */
const CHECK_TIMEOUT_MS = 8_000;
/** 上报要传完整载荷，图片由后端异步下载，所以不用等太久，但也不能太短 */
const COLLECT_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} Settings
 * @property {string} backendUrl
 */

function normalizeBase(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/**
 * 读统一配置。首次调用时按优先级迁移：
 *   toolkitSettings → 旧 sourcing 插件(local) → 旧 shopee 插件(sync) → 默认值
 * @returns {Promise<Settings>}
 */
async function readSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_SOURCING_KEY]);
  let s = stored?.[SETTINGS_KEY];
  if (!s) {
    const legacyLocal = stored?.[LEGACY_SOURCING_KEY] ?? {};
    let backendUrl = normalizeBase(legacyLocal.backendUrl);
    if (!backendUrl) {
      const sync = await chrome.storage.sync.get({ backendUrl: '' });
      backendUrl = normalizeBase(sync.backendUrl);
    }
    s = { backendUrl: backendUrl || DEFAULT_BACKEND_URL };
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }
  return { backendUrl: normalizeBase(s.backendUrl) || DEFAULT_BACKEND_URL };
}

/**
 * 把各种失败翻译成**能照着做**的提示。
 * @param {unknown} error
 * @param {string} base
 */
function describeNetworkError(error, base) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return `请求超时。确认后端在 ${base} 且响应正常。`;
  return `连不上后端 ${base}。确认已运行 npm run dev，且该地址在扩展的 host_permissions 里（改过地址要一起改 manifest.json 并重新加载扩展）。`;
}

/**
 * 统一的请求封装。
 * @param {string} base
 * @param {string} path 以 / 开头的接口路径
 * @param {{ method?: string, body?: unknown, timeout: number }} options
 * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
 */
async function request(base, path, { method = 'GET', body, timeout }) {
  const url = `${base}${path}`;
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

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

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: payload?.error ?? `后端返回 HTTP ${response.status}` };
  }
  return { ok: true, data: payload };
}

/* ------------------------------------------------------------------ *
 * Shopee 采集（原 shopee-collector/background.js 平移）
 * ------------------------------------------------------------------ */

const INGEST_PATH = '/api/competitor/ingest';

async function postIngest(body) {
  const { backendUrl } = await readSettings();
  const resp = await fetch(backendUrl + INGEST_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + text.slice(0, 200));
  return text;
}

async function bump(patch) {
  const cur = await chrome.storage.session.get({ pdp: 0, batches: 0, last: null, lastErr: '', status: '' });
  const next = Object.assign({}, cur, patch);
  if (patch.pdp !== undefined) next.pdp = cur.pdp + patch.pdp;
  if (patch.batches !== undefined) next.batches = cur.batches + patch.batches;
  await chrome.storage.session.set(next);
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

/** @type {Record<string, (message: any, sender: chrome.runtime.MessageSender) => Promise<any>>} */
const handlers = {
  /* ---- 1688 货源采集（原 Cross-Border Sourcing）---- */

  /** 扩展上下文是否可用 + 当前配置（设置页用来回填表单） */
  async getSettings() {
    return { ok: true, settings: await readSettings() };
  },

  async saveSettings(message) {
    const settings = {
      backendUrl: normalizeBase(message.backendUrl) || DEFAULT_BACKEND_URL,
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return { ok: true, settings };
  },

  /** 查重：后端是否已有这个 offerId。失败不影响采集，所以只回 ok:false 不弹错 */
  async check(message) {
    const offerId = String(message.offerId ?? '').trim();
    if (!offerId) return { ok: false, error: '缺少 offerId' };

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
   * 设置页的「测试连接」。打 /api/sourcing/stats 而不是 /lookup ——
   * 它只读且**不需要 token**，能单独验证「地址通不通」这一件事。
   */
  async testConnection(message) {
    const base = normalizeBase(message.backendUrl) || DEFAULT_BACKEND_URL;
    const result = await request(base, '/api/sourcing/stats', { timeout: CHECK_TIMEOUT_MS });
    if (!result.ok) return result;
    const stats = result.data ?? {};
    return { ok: true, message: `连接正常。货源库现有 ${stats.total ?? '?'} 条记录。` };
  },

  async collect(message) {
    const offer = message.offer;
    if (!offer || typeof offer !== 'object') return { ok: false, error: '没有可上报的数据' };
    if (!offer.offerId) return { ok: false, error: '载荷缺少 offerId' };

    const { backendUrl } = await readSettings();
    const result = await request(backendUrl, '/api/sourcing/collect', {
      method: 'POST',
      body: offer,
      timeout: COLLECT_TIMEOUT_MS,
    });
    if (!result.ok) return result;
    return { ok: true, action: result.data?.action ?? 'created', offer: result.data?.offer ?? null };
  },

  /* ---- Shopee 采集（原 shopee-collector）---- */

  /** 页面截获的商品/评论数据 */
  async api(message, sender) {
    const p = message.payload || {};
    const isPdp = /pdp\/get_pc|v4\/item\/get$/.test(p.path || '');
    const isRatings = /get_ratings/.test(p.path || '');
    const j = p.json;
    // error=90309999 之类的错误响应直接忽略
    if (!j || !j.data) return { ok: false, note: 'error json ignored' };
    await postIngest({
      type: isPdp ? 'pdp' : 'ratings',
      shopId: p.shopId,
      itemId: p.itemId,
      url: (sender.tab && sender.tab.url) || '',
      data: j,
    });
    await bump(
      isPdp
        ? { pdp: 1, last: { shopId: p.shopId, itemId: p.itemId }, lastErr: '' }
        : { batches: 1, last: { shopId: p.shopId, itemId: p.itemId }, lastErr: '' },
    );
    return { ok: true };
  },

  /** 评论拉取进度 */
  async ratings_status(message) {
    const p = message.payload || {};
    await bump({
      status:
        p.ok === false
          ? '✗ ' + (p.msg || '')
          : '✓ ' + (p.phase || '') + (p.got !== undefined ? ' ' + p.got + ' 条' : ''),
    });
    return { ok: true };
  },

  /** 登录凭证（Cookie） */
  async cookie(message, sender) {
    const url = message.url || (sender.tab && sender.tab.url) || '';
    if (!url) return { ok: false, err: 'no url' };
    const cookies = await chrome.cookies.getAll({ url });
    const s = cookies.map((c) => c.name + '=' + c.value).join('; ');
    await postIngest({
      type: 'cookie',
      shopId: message.shopId,
      itemId: message.itemId,
      url,
      cookies: s,
      names: cookies.map((c) => c.name),
    });
    return { ok: true };
  },

  /** 完整页面 HTML（原始分析数据） */
  async page_html(message) {
    const p = message.payload || {};
    await postIngest({ type: 'page_html', shopId: p.shopId, itemId: p.itemId, url: p.url, html: p.html });
    return { ok: true };
  },

  /** JSON-LD 兜底 */
  async ldjson(message) {
    await postIngest({ type: 'ldjson', shopId: message.shopId, itemId: message.itemId, data: message.data });
    return { ok: true };
  },

  /* ---- 全网图搜 ---- */

  'open-1688-search'(message) {
    if (!message.image) return { ok: false, error: '缺少图片地址' };
    chrome.tabs.create({ url: TB1688.buildSearchUrl(message.image) });
    return { ok: true };
  },
};

/**
 * 用 `return true` + sendResponse 而不是让监听器返回 Promise：
 * 后者在旧版 Chrome 上不生效，会让调用方永远等不到回音。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) {
    sendResponse({ ok: false, error: `未知的消息类型: ${message?.type}` });
    return false;
  }
  Promise.resolve(handler(message, sender))
    .then(sendResponse)
    .catch((error) => {
      console.error('[toolkit] background 处理失败', error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });
  return true; // 保持消息通道打开，等异步 handler 结束
});

/* ------------------------------------------------------------------ *
 * 安装与右键菜单
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'tb1688-image-search',
    title: '用 1688 以图搜同款',
    contexts: ['image'],
  });
  // 触发一次性配置迁移（旧插件 → toolkitSettings）
  await readSettings();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'tb1688-image-search' || !info.srcUrl) return;
  chrome.tabs.create({ url: TB1688.buildSearchUrl(info.srcUrl) });
});
