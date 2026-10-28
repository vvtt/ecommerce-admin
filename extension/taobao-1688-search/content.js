/**
 * 淘宝/天猫商品页主图检测 + 右侧悬浮按钮
 * 设计意图：
 *  - 主图优先读 og:image（淘宝/天猫 PDP 都有，且是原图、SPA 改版也不受影响）
 *  - 页面是 SPA，主图会随路由变化：MutationObserver 防抖重探，按钮点击时取最新值
 *  - 检测不到主图就不显示按钮（搜索列表页等场景交给右键菜单兜底）
 */
(function () {
  'use strict';
  if (window.__tb1688Injected) return; // 防止脚本被重复注入
  window.__tb1688Injected = true;

  var currentImage = null;
  var timer = null;

  function findMainPic() {
    var og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (og && og.content && /^https?:/.test(og.content)) return og.content;
    // og:image 缺失时的选择器兜底（老版淘宝/部分天猫皮肤）
    var fallbacks = [
      '#J_ImgBooth',
      '.PicGallery--mainPic img',
      '.PicGallery img',
      '.mainPic img',
      '.tb-main-pic img'
    ];
    for (var i = 0; i < fallbacks.length; i++) {
      var el = document.querySelector(fallbacks[i]);
      var src = el && (el.src || el.getAttribute('data-src'));
      if (src && /^https?:/.test(src)) return src;
    }
    return null;
  }

  function refresh() {
    currentImage = findMainPic();
    btn.style.display = currentImage ? 'flex' : 'none';
  }

  function scheduleRefresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 500);
  }

  var btn = document.createElement('div');
  btn.className = 'tb1688-fab';
  btn.innerHTML = '<span class="tb1688-fab-icon">搜</span><span class="tb1688-fab-text">1688 找同款</span>';
  btn.title = '用主图在 1688 以图搜同款';
  btn.addEventListener('click', function () {
    if (!currentImage) return;
    chrome.runtime.sendMessage({ type: 'open-1688-search', image: currentImage });
  });
  document.documentElement.appendChild(btn);

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src']
  });
  scheduleRefresh();
})();
