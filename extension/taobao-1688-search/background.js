/**
 * MV3 service worker：右键菜单 + 接收 content script 消息，负责开 1688 图搜标签页
 * 为什么开标签页的动作放 background：chrome.tabs.create 在 SW 里不受页面弹窗拦截影响
 */
importScripts('lib.js');

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'taobao1688-search',
    title: '用 1688 以图搜同款',
    contexts: ['image']
  });
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId !== 'taobao1688-search' || !info.srcUrl) return;
  chrome.tabs.create({ url: TB1688.buildSearchUrl(info.srcUrl) });
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === 'open-1688-search' && msg.image) {
    chrome.tabs.create({ url: TB1688.buildSearchUrl(msg.image) });
    sendResponse({ ok: true });
  }
});
