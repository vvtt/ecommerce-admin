/**
 * 前后台共用的图搜工具（content_scripts 与 background 都会加载本文件）
 * 为什么单独抽出来：缩略图转原图的规则只有一份，冒烟测试也直接复用它
 */
(function (g) {
  'use strict';

  /**
   * 1688 图搜结果页入口。
   * 为什么不用 search.1688.com/kq/-1.htm：2026-10-24 实测已 404；
   * youyuan 入口实测 200。alicdn 域名图（淘宝主图）可直传 URL，
   * 1688 服务端自己抓取，无需下载-上传链路（非 alicdn 图不受此保证）。
   * 若 1688 调整入口，只改这一处。
   */
  var SEARCH_BASE = 'https://s.1688.com/youyuan/index.htm?imageAddress=';

  /**
   * alicdn 缩略图转原图：
   *   xxx.jpg_400x400.jpg     -> xxx.jpg
   *   xxx.jpg_q90.jpg_.webp   -> xxx.jpg
   *   xxx.jpg                 -> xxx.jpg（原样）
   * 纯字符串实现，不依赖 URL 构造器（vm 沙箱/老环境也没有）；带 ?query 的图原样返回不碰
   */
  function toBigImageUrl(u) {
    if (!/^https?:\/\//i.test(u)) return u;
    // 惰性分组锁定第一个图片扩展名，其余整段必须是 _后缀 串
    var m = u.match(/^(https?:\/\/[^/]+)(.*?\.)(jpg|jpeg|png|gif)((?:_[^/]*)*)$/i);
    if (!m) return u;
    return m[1] + m[2] + m[3].toLowerCase();
  }

  function buildSearchUrl(imageUrl) {
    return SEARCH_BASE + encodeURIComponent(toBigImageUrl(imageUrl));
  }

  g.TB1688 = { SEARCH_BASE: SEARCH_BASE, toBigImageUrl: toBigImageUrl, buildSearchUrl: buildSearchUrl };
})(typeof globalThis !== 'undefined' ? globalThis : self);
