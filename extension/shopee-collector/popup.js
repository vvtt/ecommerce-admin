/* Shopee 商品抓取助手 - popup.js（手动模式）
 * 所有数据先在页面内缓冲，点对应按钮才发送后端。
 */
'use strict';

const $ = (id) => document.getElementById(id);
let tab = null;
let shopId = '', itemId = '';

function setStatus(text, isErr) {
  const el = $('status');
  el.textContent = text || '';
  el.className = isErr ? 'err' : '';
}

function renderStats(st) {
  if (!st) return;
  const last = st.last ? `（最近 shop ${st.last.shopId} / item ${st.last.itemId}）` : '';
  $('stats').innerHTML =
    `已发送后端：商品详情 <b>${st.pdp}</b> 次，评论批次 <b>${st.batches}</b> 批${last}` +
    (st.lastErr ? `<br><span style="color:#c0392b">后端错误：${st.lastErr}</span>` : '') +
    (st.status ? `<br>评论拉取：${st.status}` : '');
}

async function healthCheck() {
  // 后端已并入跨境电商后台：健康检查从 /status 换成它的 /api/health
  const { backendUrl } = await chrome.storage.sync.get({ backendUrl: 'http://localhost:3000' });
  $('backend').value = backendUrl;
  try {
    const r = await fetch(backendUrl.replace(/\/+$/, '') + '/api/health');
    const j = await r.json();
    $('health').innerHTML = j.status === 'ok'
      ? `<span class="health-ok">● 在线</span>`
      : `<span class="health-bad">● 异常</span>`;
  } catch (e) {
    $('health').innerHTML = `<span class="health-bad">● 离线（先启动后端）</span>`;
  }
}

// 查询页面内缓冲区状态（商品详情 1/0，评论批次数）
function refreshBuffer() {
  chrome.tabs.sendMessage(tab.id, { cmd: 'buffer_info' }, (r) => {
    if (chrome.runtime.lastError || !r) {
      $('buffer').textContent = '缓冲区：页面脚本未就绪（刷新商品页后重试）';
      return;
    }
    const pdp = r.pdp
      ? `✓ 已截获「${(r.pdp.name || '').slice(0, 24)}」`
      : '✗ 还没截获详情';
    $('buffer').textContent = `缓冲区：商品详情 ${pdp} · 评论 ${r.ratingBatches} 批待发送`;
  });
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = /-i\.(\d+)\.(\d+)/.exec((tab && tab.url) || '');
  if (m) {
    shopId = m[1]; itemId = m[2];
    $('ids').textContent = `✓ 商品页  shop ${shopId} / item ${itemId}`;
  } else {
    $('ids').textContent = '✗ 当前页不是商品页（URL 需含 -i.shopid.itemid）';
  }

  const st = await chrome.storage.session.get({ pdp: 0, batches: 0, last: null, lastErr: '', status: '' });
  renderStats(st);
  await healthCheck();
  refreshBuffer();
}

// 抓取商品详情：发送缓冲的最近一次 get_pc
$('btnPdp').addEventListener('click', () => {
  if (!itemId) { setStatus('请先打开商品页', true); return; }
  chrome.tabs.sendMessage(tab.id, { cmd: 'flush_pdp' }, (r) => {
    if (chrome.runtime.lastError || !r) { setStatus('无法连接页面脚本，请刷新商品页', true); return; }
    if (r.ok) {
      setStatus('✓ 商品详情已发送后端' + (r.name ? `：${r.name.slice(0, 30)}` : ''));
      refreshBuffer();
      pollStats();
    } else {
      setStatus(r.msg || '发送失败', true);
    }
  });
});

// 抓取页面已加载的评论：把手动滚动时缓冲的评论批次全部发送
$('btnFlushRatings').addEventListener('click', () => {
  if (!itemId) { setStatus('请先打开商品页', true); return; }
  chrome.tabs.sendMessage(tab.id, { cmd: 'flush_ratings' }, (r) => {
    if (chrome.runtime.lastError || !r) { setStatus('无法连接页面脚本，请刷新商品页', true); return; }
    if (r.ok) {
      setStatus(`✓ 已发送 ${r.flushed} 批缓冲评论（后端自动去重）`);
      refreshBuffer();
      pollStats();
    } else {
      setStatus(r.msg || '发送失败', true);
    }
  });
});

// 自动拉取全部评论：页面内分页请求，逐批即时发送
$('btnRatings').addEventListener('click', () => {
  if (!itemId) { setStatus('请先打开商品页', true); return; }
  chrome.tabs.sendMessage(tab.id, { cmd: 'fetch_all_ratings', shopId, itemId }, (r) => {
    if (chrome.runtime.lastError) {
      setStatus('无法连接页面脚本，请刷新商品页后重试', true);
      return;
    }
    setStatus('开始拉取评论…完成后可关闭弹窗');
    pollStats();
  });
});

// JSON-LD 兜底：DOM 里解析商品名/描述/评分
$('btnLd').addEventListener('click', () => {
  if (!itemId) { setStatus('请先打开商品页', true); return; }
  chrome.tabs.sendMessage(tab.id, { cmd: 'ld_fallback' }, (r) => {
    if (chrome.runtime.lastError || !r || !r.ok) { setStatus('解析失败', true); return; }
    chrome.runtime.sendMessage(
      { type: 'ldjson', shopId, itemId, data: r.data },
      (rr) => setStatus(rr && rr.ok ? 'JSON-LD 已发送到后端' : '发送失败：' + (rr && rr.err || ''), !(rr && rr.ok))
    );
  });
});

// 页面完整 HTML（原始分析数据）
$('btnHtml').addEventListener('click', () => {
  if (!itemId) { setStatus('请先打开商品页', true); return; }
  setStatus('HTML 传回中…（页面大的话要几秒）');
  chrome.tabs.sendMessage(tab.id, { cmd: 'send_html' }, (r) => {
    if (chrome.runtime.lastError || !r) { setStatus('无法连接页面脚本，请刷新商品页', true); return; }
    setStatus(r.ok ? `✓ 页面HTML已传回（${r.kb} KB）` : '失败：' + (r.msg || ''), !r.ok);
  });
});

// 登录凭证：background 用 chrome.cookies 读取后发送
$('btnCookie').addEventListener('click', () => {
  if (!itemId) { setStatus('请先打开商品页', true); return; }
  chrome.runtime.sendMessage(
    { type: 'cookie', shopId, itemId, url: tab.url },
    (r) => setStatus(r && r.ok ? '✓ Cookie 已发送到后端（credentials/ 目录）' : '发送失败：' + (r && r.err || ''), !(r && r.ok))
  );
});

$('btnSave').addEventListener('click', async () => {
  const v = $('backend').value.trim().replace(/\/+$/, '');
  await chrome.storage.sync.set({ backendUrl: v || 'http://localhost:3000' });
  setStatus('后端地址已保存');
  healthCheck();
});

let pollTimer = null;
function pollStats() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const st = await chrome.storage.session.get({ pdp: 0, batches: 0, last: null, lastErr: '', status: '' });
    renderStats(st);
    if (/done|✗/.test(st.status || '')) { clearInterval(pollTimer); pollTimer = null; }
  }, 800);
}

init();
