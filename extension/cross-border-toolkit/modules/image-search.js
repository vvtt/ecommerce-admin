/**
 * 全网图搜模块（三合一 · 任意网站生效）
 *
 * 三种入口：
 *   1. 悬停任意 >=80px 的 <img>，左上角浮出「1688搜」角标，点击即搜
 *   2. Alt + 点击图片 = 直接搜（角标被站点样式干扰时的兜底）
 *   3. 右键菜单「用 1688 以图搜同款」（background 注册，无需本脚本）
 * 另外：淘宝/天猫商品页保留右侧悬浮按钮（主图直搜，og:image 检测）。
 *
 * 开关（popup 的「全网图片搜 1688」）实时生效——storage.onChanged 监听，
 * 不像采集模块那样要刷新页面。为什么用「角标」而不是点图片就搜：
 * 直接劫持图片点击会破坏网站的灯箱/链接/选择交互，角标是各比价插件的通行做法。
 */
(() => {
  'use strict';
  if (window.__tb1688Injected) return;
  window.__tb1688Injected = true;

  const MIN_SIZE = 80; // 小于 80px 的多半是图标/头像，不值得搜
  let enabled = true;

  chrome.storage.local.get({ toolkitToggles: {} }, (s) => {
    enabled = !((s.toolkitToggles || {}).imageSearch === false);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.toolkitToggles) {
      enabled = !((changes.toolkitToggles.newValue || {}).imageSearch === false);
      if (!enabled) hideBadge();
    }
  });

  function sendMessage(image) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'open-1688-search', image });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 扩展重载瞬间会抛错，忽略 */ }
  }

  /* ---------------- 悬停角标 ---------------- */

  const badge = document.createElement('div');
  badge.className = 'tb1688-img-badge';
  badge.textContent = '1688搜';
  badge.style.display = 'none';
  document.documentElement.appendChild(badge);
  let target = null; // { el, src }

  // <img> 是否可用：协议合规 + 固有尺寸够大（防止被拉伸的小图标蒙混过关）
  function imgUsableImg(img) {
    try {
      if (!img || img.tagName !== 'IMG') return false;
      const src = img.currentSrc || img.src || '';
      if (!/^https?:/.test(src)) return false;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (nw > 0 && (nw < MIN_SIZE || nh < MIN_SIZE)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // 取元素内联背景图 URL（只查内联 style，足够覆盖淘宝营销页且零开销；
  // 不查 computedStyle——那是全页扫描级别的成本，悬停热路径经不起）
  function bgUrlOf(el) {
    const bg = el.style && el.style.backgroundImage;
    if (!bg) return null;
    const m = /url\(["']?(https?:\/\/[^"')]+)["']?\)/.exec(bg);
    return m ? m[1] : null;
  }

  // 单个元素是否可搜：img 或内联背景图
  function hitOf(el) {
    if (el.tagName === 'IMG' && imgUsableImg(el)) {
      return { el, src: el.currentSrc || el.src };
    }
    if (el.style) {
      const u = bgUrlOf(el);
      if (u) return { el, src: u };
    }
    return null;
  }

  // 从悬停点找可搜图，两级策略：
  //  ① 悬停元素自身/祖先链上的 img 或背景图（绝大多数页面到这就命中了）
  //  ② 兄弟层回溯：SEM 落地页常见「背景图层 + 透明链接覆盖层」结构——
  //     悬停命中的覆盖层与背景图层是兄弟节点，沿祖先链永远碰不到。
  //     所以逐层扫描每层祖先的同层元素，找「矩形包含悬停点且有图」的那个。
  //     （2026-10-24 实测淘宝 alimama SEM 页 5 张商品卡全部命中此结构）
  function findHoverTarget(node, x, y) {
    let el = node;
    const chain = [];
    while (el && el !== document.documentElement) {
      const hit = hitOf(el);
      if (hit) return hit;
      chain.push(el);
      el = el.parentElement;
    }
    for (const anc of chain) {
      const parent = anc.parentElement;
      if (!parent) continue;
      for (const sib of parent.children) {
        if (sib === anc) continue;
        const r = sib.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const hit = hitOf(sib);
        if (hit) return hit;
      }
    }
    return null;
  }

  function placeBadge(hit) {
    const r = hit.el.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return hideBadge();
    badge.style.left = Math.max(0, r.left) + 'px';
    badge.style.top = Math.max(0, r.top) + 'px';
    badge.style.display = 'block';
    target = hit;
  }

  function hideBadge() {
    badge.style.display = 'none';
    target = null;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!enabled) return;
      if (badge.contains(e.target)) return; // 移到角标上别闪没
      const hit = findHoverTarget(e.target, e.clientX, e.clientY);
      if (hit) placeBadge(hit);
      else hideBadge();
    },
    true,
  );
  window.addEventListener('scroll', hideBadge, { passive: true });

  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const hit = target;
    hideBadge();
    if (hit) sendMessage(hit.src);
  });

  /* ---------------- Alt+点击兜底 ---------------- */

  document.addEventListener(
    'click',
    (e) => {
      if (!enabled || !e.altKey) return;
      const hit = findHoverTarget(e.target, e.clientX, e.clientY);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        sendMessage(hit.src);
      }
    },
    true,
  );

  /* ---------------- 淘宝/天猫商品页：右侧悬浮按钮 ---------------- */

  const isTaobaoPdp = /(^|\.)(taobao\.com|tmall\.com|tmall\.hk)$/i.test(location.hostname);
  if (!isTaobaoPdp) return;

  let currentImage = null;
  let timer = null;

  function findMainPic() {
    const og =
      document.querySelector('meta[property="og:image"]') ||
      document.querySelector('meta[name="og:image"]') ||
      document.querySelector('meta[itemprop="image"]');
    if (og && og.content && /^https?:/.test(og.content)) return og.content;
    // og:image 缺失时的选择器兜底（老版淘宝/部分天猫皮肤）
    const fallbacks = [
      '#J_ImgBooth',
      '.PicGallery--mainPic img',
      '.PicGallery img',
      '.mainPic img',
      '.tb-main-pic img',
    ];
    for (const sel of fallbacks) {
      const el = document.querySelector(sel);
      const src = el && (el.src || el.getAttribute('data-src'));
      if (src && /^https?:/.test(src)) return src;
    }
    // 最后的兜底：新 SSR 详情页（pc-detail-ssr-2025）实测可能没有任何可识别的
    // 主图标记 —— 取首屏里可见的最大图（商品详情页主图几乎总是全页最大的那张）。
    // 只在商品页 URL 形态下启用，避免搜索页/首页误判。
    if (!/item\.htm|-i\.\d+\.\d+|\/item\//i.test(location.href)) return null;
    let best = null;
    let bestArea = 0;
    for (const img of document.images) {
      try {
        const src = img.currentSrc || img.src || '';
        if (!/^https?:/.test(src)) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 250 || r.height < 250) continue;
        if (r.top < 0 || r.top > window.innerHeight * 0.85) continue; // 主图在首屏
        const area = (img.naturalWidth || r.width) * (img.naturalHeight || r.height);
        if (area > bestArea) {
          bestArea = area;
          best = img;
        }
      } catch (e) { /* 忽略取不到尺寸的图 */ }
    }
    return best ? best.currentSrc || best.src : null;
  }

  function refresh() {
    currentImage = findMainPic();
    fab.style.display = currentImage ? 'flex' : 'none';
  }

  function scheduleRefresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 500);
  }

  const fab = document.createElement('div');
  fab.className = 'tb1688-fab';
  fab.innerHTML = '<span class="tb1688-fab-icon">搜</span><span class="tb1688-fab-text">1688 找同款</span>';
  fab.title = '用主图在 1688 以图搜同款';
  fab.addEventListener('click', () => {
    if (currentImage) sendMessage(currentImage);
  });
  document.documentElement.appendChild(fab);

  // 页面是 SPA，主图随路由变化：MutationObserver 防抖重探，点击时取最新值
  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  scheduleRefresh();
})();
