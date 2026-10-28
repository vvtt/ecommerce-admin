#!/usr/bin/env node
/* Shopee 商品抓取助手 - inject.js
 * 运行在 MAIN world（页面上下文），document_start 时尽早安装钩子。
 *
 * 【手动模式】劫持 window.fetch / XMLHttpRequest，截获页面自己发出的商品 API
 * 响应后只存入缓冲区，**不自动发送**。用户在弹窗里点按钮才推送：
 *   - buffer_info        查询缓冲区状态（商品详情 1/0，评论批次数）
 *   - flush_pdp          发送最近一次截获的商品详情（get_pc / item get）
 *   - flush_ratings      发送全部缓冲的评论批次并清空缓冲
 *   - fetch_all_ratings  主动分页拉取全部评论（逐批即时发送）
 *
 * 监听的接口：
 *   /api/v4/pdp/get_pc        商品详情（标题/规格/描述/评分汇总）
 *   /api/v2/item/get          旧版商品详情（兜底）
 *   /api/v2/item/get_ratings  评论
 *
 *   （搜索结果采集已移除 —— 2026-10-21 用户决策：搜索采集只走平台 CDP 拦截，
 *    插件在自己浏览器里偷偷上报搜索结果曾导致大量非预期入库）
 *
 * 与 content.js 的通信一律走 window.postMessage，带 source/target 标记。
 */
(function () {
  if (window.__shopee_ext_hook__) return;
  window.__shopee_ext_hook__ = true;
  console.log('[shopee-ext] hook installed v3 (搜索采集已移除)');

  var TARGET = /\/api\/(v4\/pdp\/get_pc|v4\/item\/get|v2\/item\/get_ratings|v2\/item\/get)(?:\?|$)/;

  // ---------------- 缓冲区 ----------------
  var lastPdp = null;        // 最近一次商品详情：{ path, shopId, itemId, json }
  var ratingBuffer = [];     // 评论批次：[{ shopId, itemId, json }, ...]
  var autoFetching = false;  // 自动拉评论期间不再重复入缓冲（那批会即时发送）

  function send(type, payload) {
    try {
      window.postMessage({ source: 'shopee-ext-inject', type: type, payload: payload }, location.origin);
    } catch (e) { /* 页面 CSP 变动时不影响页面本身 */ }
  }

  function reply(requestId, payload) {
    try {
      window.postMessage({ source: 'shopee-ext-inject', type: 'api_reply', requestId: requestId, payload: payload }, location.origin);
    } catch (e) { /* ignore */ }
  }

  function pick(url) {
    try { return new URL(url, location.origin); } catch (e) { return null; }
  }

  function tryParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function inspect(u, text) {
    if (!u) return;
    // 搜索结果采集已移除（2026-10-21）：搜索只由平台 CDP 拦截器处理，
    // 插件不再上报，避免用户在自己浏览器里的调研搜索被静默入库。
    if (!TARGET.test(u.pathname)) return;
    var j = null;
    try { j = JSON.parse(text); } catch (e) { return; }
    if (!j || !j.data) return;              // error=90309999 之类的错误响应不入缓冲
    var p = u.searchParams;
    var entry = {
      path: u.pathname,
      shopId: p.get('shop_id') || p.get('shopid') || '',
      itemId: p.get('item_id') || p.get('itemid') || '',
      json: j
    };
    if (/get_ratings/.test(entry.path)) {
      if (autoFetching) return;             // 自动拉取的批次由循环即时发送
      var list = (j.data && j.data.ratings) || [];
      if (list.length) {
        ratingBuffer.push(entry);
        if (ratingBuffer.length > 200) ratingBuffer.shift();   // 防爆内存
      }
    } else if (j.data && j.data.item) {
      lastPdp = entry;                      // 永远保留最近一次详情
    }
  }

  // ---------------- 劫持 fetch ----------------
  var origFetch = window.fetch;
  window.fetch = function (input) {
    var u = pick(typeof input === 'string' ? input : (input && input.url) || '');
    var args = arguments;
    return origFetch.apply(this, args).then(function (resp) {
      try {
        if (u && resp.ok) {
          resp.clone().text().then(function (t) { inspect(u, t); }).catch(function () {});
        }
      } catch (e) { /* 不干扰页面 */ }
      return resp;
    });
  };

  // ---------------- 劫持 XMLHttpRequest ----------------
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ext_url = url;
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener('load', function () {
      try {
        var u = pick(self.__ext_url || '');
        if (u) inspect(u, self.responseText || '');
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };

  // ---------------- 响应 popup / content 指令 ----------------
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.target !== 'shopee-ext-inject') return;
    switch (d.cmd) {
      case 'buffer_info':
        reply(d.requestId, {
          pdp: lastPdp ? { shopId: lastPdp.shopId, itemId: lastPdp.itemId, name: extractName(lastPdp) } : null,
          ratingBatches: ratingBuffer.length
        });
        break;

      // 页面浮窗「一键采集」：详情（规格/描述）+ 全部评论，一次搞定
      case 'capture_all':
        (async function () {
          var shopId = d.shopId, itemId = d.itemId;
          // 用户可能点得早：等详情截获，最多 10 秒
          if (!lastPdp) {
            for (var i = 0; i < 10 && !lastPdp; i++) await sleep(1000);
          }
          if (lastPdp) {
            send('api', {
              path: lastPdp.path,
              shopId: lastPdp.shopId || shopId,
              itemId: lastPdp.itemId || itemId,
              json: lastPdp.json
            });
            var s = pdpSummary(lastPdp);
            send('capture_progress', { phase: 'pdp_ok', name: s.name, attrs: s.attrs, desc: s.desc });
          } else {
            send('capture_progress', { phase: 'pdp_miss' });
          }
          // 完整页面 HTML 传回后端（分析用：分类面包屑、内嵌状态、漏掉的字段）
          try {
            var htmlStr = document.documentElement.outerHTML;
            send('page_html', { shopId: shopId, itemId: itemId, url: location.href, html: htmlStr });
            send('capture_progress', { phase: 'html_ok', kb: Math.round(htmlStr.length / 1024) });
          } catch (eHtml) {
            send('capture_progress', { phase: 'html_err', msg: String(eHtml) });
          }
          await fetchAllRatings(shopId, itemId);   // 过程经 ratings_status 汇报
          send('capture_progress', { phase: 'all_done' });
        })();
        break;

      case 'flush_pdp':
        if (!lastPdp) {
          reply(d.requestId, { ok: false, msg: '缓冲区还没有商品详情：请等页面加载出商品信息后重试' });
          break;
        }
        send('api', { path: lastPdp.path, shopId: lastPdp.shopId, itemId: lastPdp.itemId, json: lastPdp.json });
        reply(d.requestId, { ok: true, flushed: 1, name: extractName(lastPdp) });
        break;

      case 'flush_ratings':
        if (!ratingBuffer.length) {
          reply(d.requestId, { ok: false, msg: '评论缓冲区为空：请先在页面评论区滚动或点「更多評論」加载' });
          break;
        }
        var n = ratingBuffer.length;
        ratingBuffer.forEach(function (b) {
          send('api', { path: b.path, shopId: b.shopId, itemId: b.itemId, json: b.json });
        });
        ratingBuffer = [];
        reply(d.requestId, { ok: true, flushed: n });
        break;

      // 单独传回页面完整 HTML（面板/弹窗手动触发）
      case 'send_html':
        try {
          var hs = document.documentElement.outerHTML;
          if (!hs) { reply(d.requestId, { ok: false, msg: '无法读取页面HTML' }); break; }
          var mm = /-i\.(\d+)\.(\d+)/.exec(location.href) || [];
          send('page_html', { shopId: mm[1] || '', itemId: mm[2] || '', url: location.href, html: hs });
          reply(d.requestId, { ok: true, kb: Math.round(hs.length / 1024) });
        } catch (eSe) {
          reply(d.requestId, { ok: false, msg: String(eSe) });
        }
        break;

      case 'fetch_all_ratings':
        fetchAllRatings(d.shopId, d.itemId);
        break;
    }
  });

  function extractName(entry) {
    try { return (entry.json.data.item && entry.json.data.item.name) || ''; } catch (e) { return ''; }
  }

  function pdpSummary(entry) {
    var it = null;
    try { it = entry.json.data.item; } catch (e) { /* ignore */ }
    return {
      name: (it && it.name) || '',
      attrs: (it && it.attributes && it.attributes.length) || 0,
      desc: it ? ((it.description || '').length) : 0
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------------- 自动拉取全部评论（用户点按钮触发） ----------------
  async function fetchAllRatings(shopId, itemId) {
    if (!shopId || !itemId) {
      send('ratings_status', { ok: false, msg: '缺少 shopId/itemId，请确认当前是商品页' });
      return;
    }
    send('ratings_status', { ok: true, phase: 'start' });
    var limit = 20, offset = 0, got = 0;
    autoFetching = true;
    for (var page = 0; page < 100; page++) {   // 安全上限 2000 条
      var resp, j;
      try {
        resp = await fetch(
          '/api/v2/item/get_ratings?filter=0&flag=1&itemid=' + itemId +
          '&limit=' + limit + '&offset=' + offset + '&shopid=' + shopId + '&type=0',
          { credentials: 'include' }
        );
        if (resp.status === 403) {
          autoFetching = false;
          send('ratings_status', {
            ok: false, got: got,
            msg: '接口403被反爬拦截。请手动滚动评论区加载，然后点「抓取页面已加载的评论」。'
          });
          return;
        }
        j = await resp.json();
      } catch (err) {
        autoFetching = false;
        send('ratings_status', { ok: false, got: got, msg: '请求异常: ' + err });
        return;
      }
      var list = (j && j.data && j.data.ratings) || [];
      if (!list.length) break;
      send('api', { path: '/api/v2/item/get_ratings', shopId: shopId, itemId: itemId, json: j });
      got += list.length;
      offset += limit;
      send('ratings_status', { ok: true, phase: 'progress', got: got });
      await sleep(700 + Math.random() * 500);   // 礼貌限速
    }
    autoFetching = false;
    send('ratings_status', { ok: true, phase: 'done', got: got });
  }
})();
