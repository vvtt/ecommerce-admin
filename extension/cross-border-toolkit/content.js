/* Shopee 商品抓取助手 - content.js
 * ISOLATED world 桥梁脚本：
 *  1. 【页面浮窗】在商品页右下角显示「📦 一键采集商品」按钮：
 *     点一下 = 商品详情（规格/描述）+ 全部评论 一次抓完并发后端，
 *     进度实时显示在浮窗上。× 可临时隐藏，换商品页自动恢复。
 *  2. 把 inject.js（MAIN world）的数据/回复转发给 popup、background
 *  3. 接收 popup 指令（flush_pdp / flush_ratings / buffer_info 等）转发给
 *     inject.js —— 用 requestId 配对异步回传（备用通道，弹窗里还有一套按钮）
 *  4. 兜底：解析页面 JSON-LD（商品名/描述/评分）
 */
(function () {
  /* —— 合并版开关：popup 可关掉 Shopee 采集模块（关掉后刷新页面生效）—— */
  chrome.storage.local.get({ toolkitToggles: {} }, function (s) {
    var t = (s && s.toolkitToggles) || {};
    if (t.shopee === false) return;
    tkInit();
  });
  function tkInit() {
  var seq = 0;
  var pending = {};          // requestId -> sendResponse（附 _t 超时定时器）

  // ---------------- 浮窗状态 ----------------
  var panel = null, btn = null, btnHtml = null, statusEl = null;
  var busy = false, userClosed = false, lastUrl = '';

  function toBackground(msg) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 扩展重载瞬间会抛错，忽略 */ }
  }

  // ================= 页面浮窗 =================

  // 解析商品 ID，兼容两种 URL 形态：
  //   老形态：https://shopee.tw/【名】-i.{shopId}.{itemId}
  //   新形态：https://xiapi.xiapibuy.com/product/{shopId}/{itemId}
  // （2026-10-24 修：之前只认 -i. 形态，新 /product/ 链接下浮窗永远不出现）
  function parseItemIds() {
    var m = /-i\.(\d+)\.(\d+)/.exec(location.href);
    if (m) return { shopId: m[1], itemId: m[2] };
    m = /\/product\/(\d+)\/(\d+)/.exec(location.pathname);
    if (m) return { shopId: m[1], itemId: m[2] };
    return null;
  }

  function isProductPage() {
    return !!parseItemIds();
  }

  function ensurePanel() {
    if (panel) return;
    if (!document.body) return;   // document_start 时 body 未就绪，下个 tick 再建
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
      'font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;';

    var card = document.createElement('div');
    card.style.cssText = 'position:relative;background:#fff;border:1px solid #e8e8e8;' +
      'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:10px 12px;width:230px;';

    var close = document.createElement('div');
    close.textContent = '×';
    close.title = '临时隐藏（换商品页自动恢复）';
    close.style.cssText = 'position:absolute;top:2px;right:8px;font-size:16px;color:#999;' +
      'cursor:pointer;line-height:1;';
    close.addEventListener('click', function () {
      userClosed = true;
      panel.style.display = 'none';
    });

    btn = document.createElement('button');
    btn.textContent = '📦 一键采集商品';
    btn.style.cssText = 'width:100%;padding:8px 0;border:none;border-radius:6px;' +
      'background:#ee4d2d;color:#fff;font-size:13px;cursor:pointer;';
    btn.addEventListener('mouseenter', function () { if (!busy) btn.style.background = '#d7421f'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = '#ee4d2d'; });
    btn.addEventListener('click', startCapture);

    btnHtml = document.createElement('button');
    btnHtml.textContent = '📤 补传页面HTML';
    btnHtml.style.cssText = 'width:100%;padding:5px 0;margin-top:6px;border:1px solid #ddd;' +
      'border-radius:6px;background:#fafafa;color:#555;font-size:12px;cursor:pointer;';
    btnHtml.addEventListener('click', sendHtmlFromPanel);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin-top:6px;font-size:12px;color:#444;min-height:16px;' +
      'word-break:break-all;display:none;';

    card.appendChild(close);
    card.appendChild(btn);
    card.appendChild(btnHtml);
    card.appendChild(statusEl);
    panel.appendChild(card);
    document.body.appendChild(panel);
  }

  function showStatus(text, color) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.style.color = color || '#444';
    statusEl.style.display = text ? 'block' : 'none';
  }

  function startCapture() {
    if (busy) return;
    var ids = parseItemIds();
    if (!ids) { showStatus('当前不是商品页', '#c0392b'); return; }
    busy = true;
    btn.disabled = true;
    btn.style.opacity = '.7';
    btn.textContent = '⏳ 采集中…';
    showStatus('准备采集…');
    window.postMessage({
      target: 'shopee-ext-inject',
      cmd: 'capture_all',
      shopId: ids.shopId,
      itemId: ids.itemId
    }, location.origin);
  }

  // 单独补传页面 HTML（浮窗小按钮）
  function sendHtmlFromPanel() {
    if (busy) return;
    var ids = parseItemIds();
    if (!ids) { showStatus('当前不是商品页', '#c0392b'); return; }
    btnHtml.disabled = true;
    btnHtml.textContent = '⏳ 传回中…';
    var rid = 'panel_html_' + Date.now();
    pending[rid] = function (payload) {
      btnHtml.disabled = false;
      btnHtml.textContent = '📤 补传页面HTML';
      if (payload && payload.ok) showStatus('✓ 页面HTML已传回（' + payload.kb + ' KB）', '#0a6b2d');
      else showStatus('✗ ' + ((payload && payload.msg) || '传回失败'), '#c0392b');
    };
    pending[rid + '_t'] = setTimeout(function () {
      if (pending[rid]) {
        pending[rid]({ ok: false, msg: '超时：页面脚本无响应，请刷新商品页' });
        delete pending[rid];
      }
    }, 15000);
    window.postMessage({ target: 'shopee-ext-inject', cmd: 'send_html', requestId: rid }, location.origin);
  }

  function finishCapture(finalText, isErr) {
    busy = false;
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.textContent = '📦 一键采集商品';
    showStatus(finalText, isErr ? '#c0392b' : '#0a6b2d');
  }

  // 浮窗进度：capture_progress（详情步骤/收尾） + ratings_status（评论步骤）
  function onPanelEvent(type, p) {
    if (!panel) return;
    if (type === 'capture_progress') {
      switch (p.phase) {
        case 'pdp_ok':
          showStatus('✓ 详情已发送：规格 ' + (p.attrs || 0) + ' 项 · 描述 ' +
            (p.desc || 0) + ' 字', '#0a6b2d');
          break;
        case 'pdp_miss':
          showStatus('⚠ 未截获商品详情（页面没加载完），继续采评论…', '#b8860b');
          break;
        case 'html_ok':
          showStatus('✓ 页面HTML已传回（' + (p.kb || 0) + ' KB）', '#0a6b2d');
          break;
        case 'html_err':
          showStatus('⚠ 页面HTML传回失败：' + (p.msg || ''), '#b8860b');
          break;
        case 'all_done':
          finishCapture('✅ 采集完成，数据已存后端 data/ 目录');
          break;
      }
    } else if (type === 'ratings_status') {
      if (!busy) return;
      if (p.ok === false) {
        finishCapture('✗ 评论接口被拦：手动滚动评论区加载后，' +
          '可点扩展弹窗「抓取页面已加载的评论」发送', true);
        return;
      }
      if (p.phase === 'start') showStatus('⏳ 正在拉取全部评论…');
      else if (p.phase === 'progress') showStatus('⏳ 已采集评论 ' + (p.got || 0) + ' 条…');
      else if (p.phase === 'done') showStatus('✓ 评论采集完成，共 ' + (p.got || 0) + ' 条', '#0a6b2d');
    }
  }

  // 商品页显示浮窗；SPA 换页自动适配（换到商品页恢复显示，离开则隐藏）
  setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      userClosed = false;          // 换了页面就重新出现
      if (busy) finishCapture('页面已跳转，采集中断', true);
    }
    if (!panel) ensurePanel();
    panel.style.display = (isProductPage() && !userClosed) ? '' : 'none';
  }, 800);

  // ================= 消息桥梁 =================
  // （搜索页批量采集浮标已随搜索自动上报一并移除，2026-10-21）

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== 'shopee-ext-inject') return;

    if (d.type === 'api_reply') {
      var cb = pending[d.requestId];
      if (cb) {
        clearTimeout(pending[d.requestId + '_t']);
        try { cb(d.payload); } catch (e2) { /* 弹窗已关，忽略 */ }
        delete pending[d.requestId];
      }
      return;
    }
    if (d.type === 'api') toBackground({ type: 'api', payload: d.payload });
    else if (d.type === 'page_html') toBackground({ type: 'page_html', payload: d.payload });
    // （search 类型已移除：插件不再上报搜索结果，2026-10-21）
    else if (d.type === 'ratings_status') {
      onPanelEvent('ratings_status', d.payload);
      toBackground({ type: 'ratings_status', payload: d.payload });
    }
    else if (d.type === 'capture_progress') onPanelEvent('capture_progress', d.payload);
  });

  // popup/background -> 这里 -> inject.js（弹窗备用通道）
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.cmd === 'buffer_info' || msg.cmd === 'flush_pdp' || msg.cmd === 'flush_ratings' || msg.cmd === 'send_html') {
      // 需要等 inject.js 干活后异步回话：登记 requestId，回包后再 sendResponse
      var rid = 'r' + (++seq) + '_' + Date.now();
      pending[rid] = sendResponse;
      pending[rid + '_t'] = setTimeout(function () {
        if (pending[rid]) {
          try { sendResponse({ ok: false, msg: '页面脚本无响应，请刷新商品页后重试' }); } catch (e) {}
          delete pending[rid];
        }
      }, 8000);
      window.postMessage({
        target: 'shopee-ext-inject',
        cmd: msg.cmd,
        requestId: rid
      }, location.origin);
      return true;   // 保持通道开放，异步 sendResponse
    }

    if (msg.cmd === 'fetch_all_ratings') {
      window.postMessage({
        target: 'shopee-ext-inject',
        cmd: 'fetch_all_ratings',
        shopId: msg.shopId,
        itemId: msg.itemId
      }, location.origin);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.cmd === 'ld_fallback') {
      sendResponse({ ok: true, data: parseLd() });
      return false;
    }
    return false;
  });

  function parseLd() {
    var out = { ld: null, h1: '' };
    try {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      scripts.forEach(function (s) {
        try {
          var j = JSON.parse(s.textContent);
          (Array.isArray(j) ? j : [j]).forEach(function (x) {
            if (x && x['@type'] === 'Product') out.ld = x;
          });
        } catch (e) { /* 忽略坏块 */ }
      });
    } catch (e) { /* ignore */ }
    try {
      var h1 = document.querySelector('h1');
      out.h1 = h1 ? h1.innerText.trim() : '';
    } catch (e) { /* ignore */ }
    return out;
  }
  }
})();
