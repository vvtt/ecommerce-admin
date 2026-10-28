/**
 * 工具箱弹窗：
 *  - 显示当前网站 + 高亮该站点对应的采集模块（按访问的网站决定哪个模块在用）
 *  - 三个模块开关（toolkitToggles）；图搜实时生效，采集模块刷新页面生效
 *  - Shopee 本次会话统计（background 写入 storage.session）
 */
'use strict';

const TOGGLES_KEY = 'toolkitToggles';
const MODULE_KEYS = ['imageSearch', 'sourcing', 'shopee'];

/** 当前站点对应哪个采集模块；'' 表示都不对应（图搜总是可用） */
function siteModule(hostname) {
  if (/(^|\.)1688\.com$/i.test(hostname)) return 'sourcing';
  if (/(^|\.)(xiapibuy\.com|shopee\.tw)$/i.test(hostname)) return 'shopee';
  return '';
}

async function getToggles() {
  const stored = await chrome.storage.local.get({ [TOGGLES_KEY]: {} });
  return (stored && stored[TOGGLES_KEY]) || {};
}

async function init() {
  // 当前站点
  let host = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = tab && tab.url ? new URL(tab.url).hostname : '';
  } catch (e) { /* 无标签页权限的页面保持空 */ }
  document.getElementById('site').textContent = host || '（无法识别页面）';

  const mod = siteModule(host);
  document.getElementById('row-sourcing').classList.toggle('dim', mod !== 'sourcing');
  document.getElementById('row-shopee').classList.toggle('dim', mod !== 'shopee');
  if (mod) {
    const hint = document.querySelector('#row-' + mod + ' .hint');
    if (hint) { hint.textContent += '（当前站点 ✅）'; hint.style.visibility = 'visible'; hint.style.color = '#1a7f37'; }
  }

  // 开关
  const toggles = await getToggles();
  for (const key of MODULE_KEYS) {
    const cb = document.getElementById('tg-' + key);
    cb.checked = toggles[key] !== false; // 未配置 = 开
    cb.addEventListener('change', async () => {
      const next = Object.assign({}, await getToggles(), { [key]: cb.checked });
      await chrome.storage.local.set({ [TOGGLES_KEY]: next });
    });
  }

  // Shopee 会话统计
  try {
    const s = await chrome.storage.session.get({ pdp: 0, batches: 0, lastErr: '', status: '' });
    const el = document.getElementById('shopee-stats');
    let text = `Shopee 本次会话：商品 ${s.pdp} 次 · 评论批次 ${s.batches}`;
    if (s.lastErr) text += ` · 最近错误 ${s.lastErr.slice(0, 46)}`;
    else if (s.status) text += ` · ${s.status.slice(0, 46)}`;
    el.textContent = text;
  } catch (e) {
    document.getElementById('shopee-stats').textContent = '';
  }
}

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
