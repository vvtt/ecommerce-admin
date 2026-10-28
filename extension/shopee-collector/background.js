/* Shopee 商品抓取助手 - background.js (MV3 service worker)
 * 职责：
 *  1. 接收 content.js 转发的 API 截获数据，POST 到本地后端 /api/competitor/ingest
 *  2. 读取 Shopee 域 Cookie（登录凭证），发到后端 /ingest type=cookie
 *  3. 维护 session 计数器供 popup 展示
 *
 * 后端已并入跨境电商后台（ecommerce-admin，默认 http://localhost:3000）。
 * 若浏览器里还存着旧的 8787 地址，需在插件设置页改回新地址才生效 ——
 * storage.sync 里的旧值优先级高于这里的默认值。
 */
'use strict';

const DEFAULT_BACKEND = 'http://localhost:3000';
const INGEST_PATH = '/api/competitor/ingest';

async function backendBase() {
  const { backendUrl } = await chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND });
  return (backendUrl || DEFAULT_BACKEND).replace(/\/+$/, '');
}

async function postIngest(body) {
  const base = await backendBase();
  const resp = await fetch(base + INGEST_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---- 页面截获的商品/评论数据 ----
  if (msg.type === 'api') {
    const p = msg.payload || {};
    const isPdp = /pdp\/get_pc|v4\/item\/get$/.test(p.path || '');
    const isRatings = /get_ratings/.test(p.path || '');
    const j = p.json;
    if (!j || !j.data) {   // error=90309999 之类的错误响应直接忽略
      sendResponse({ ok: false, note: 'error json ignored' });
      return false;
    }
    postIngest({
      type: isPdp ? 'pdp' : 'ratings',
      shopId: p.shopId, itemId: p.itemId,
      url: (sender.tab && sender.tab.url) || '',
      data: j
    })
      .then(() => bump(isPdp
        ? { pdp: 1, last: { shopId: p.shopId, itemId: p.itemId }, lastErr: '' }
        : { batches: 1, last: { shopId: p.shopId, itemId: p.itemId }, lastErr: '' }))
      .then(() => sendResponse({ ok: true }))
      .catch(err => bump({ lastErr: String(err) }).then(() => sendResponse({ ok: false, err: String(err) })));
    return true;   // 异步响应
  }

  // ---- 评论拉取进度 ----
  if (msg.type === 'ratings_status') {
    const p = msg.payload || {};
    bump({ status: p.ok === false ? ('✗ ' + (p.msg || '')) : ('✓ ' + (p.phase || '') + (p.got !== undefined ? ' ' + p.got + ' 条' : '')) })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  // ---- 登录凭证（Cookie）----
  if (msg.type === 'cookie') {
    const url = msg.url || (sender.tab && sender.tab.url) || '';
    if (!url) { sendResponse({ ok: false, err: 'no url' }); return false; }
    chrome.cookies.getAll({ url: url })
      .then(cookies => {
        const s = cookies.map(c => c.name + '=' + c.value).join('; ');
        return postIngest({
          type: 'cookie',
          shopId: msg.shopId, itemId: msg.itemId,
          url: url, cookies: s,
          names: cookies.map(c => c.name)
        });
      })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, err: String(err) }));
    return true;
  }

  // ---- 完整页面 HTML（原始分析数据）----
  if (msg.type === 'page_html') {
    const p = msg.payload || {};
    postIngest({ type: 'page_html', shopId: p.shopId, itemId: p.itemId, url: p.url, html: p.html })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, err: String(err) }));
    return true;
  }

  // ---- 搜索结果批量上报已移除（2026-10-21 用户决策）----
  // 搜索采集只走平台 CDP 拦截器；插件保留手动浏览 PDP/评论的缓冲上报。

  // ---- JSON-LD 兜底 ----
  if (msg.type === 'ldjson') {
    postIngest({ type: 'ldjson', shopId: msg.shopId, itemId: msg.itemId, data: msg.data })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, err: String(err) }));
    return true;
  }

  return false;
});
