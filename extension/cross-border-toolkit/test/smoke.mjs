/**
 * cross-border-toolkit 三合一插件冒烟测试
 * 运行：node extension/cross-border-toolkit/test/smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  pass++;
  console.log(`  ✓ ${label}`);
}
const read = (p) => readFileSync(join(root, p), 'utf-8');

/* ---- 文件齐全 ---- */
for (const f of [
  'manifest.json', 'lib.js', 'background.js',
  'main-world.js', 'isolated.js', 'inject.js', 'content.js',
  'options.html', 'options.js',
  'popup.html', 'popup.css', 'popup.js',
  'modules/image-search.js', 'modules/image-search.css',
]) ok(existsSync(join(root, f)), `文件存在 ${f}`);

/* ---- manifest：三合一接线 ---- */
const manifest = JSON.parse(read('manifest.json'));
ok(manifest.manifest_version === 3, 'manifest 为 MV3');
ok(['contextMenus', 'storage', 'cookies'].every((p) => manifest.permissions.includes(p)), '权限含 contextMenus/storage/cookies');
const perms = manifest.host_permissions.join(' ');
ok(/1688\.com/.test(perms), 'host_permissions 覆盖 1688');
ok(/xiapibuy\.com/.test(perms) && /shopee\.tw/.test(perms), 'host_permissions 覆盖 Shopee 双域');
ok(/127\.0\.0\.1/.test(perms), 'host_permissions 覆盖本地后端');
const cs = manifest.content_scripts;
ok(cs.length === 5, '5 组 content_scripts（1688 主世界/隔离 + shopee 主世界/隔离 + 全网图搜）');
ok(cs[0].world === 'MAIN' && cs[1].world === undefined, '1688 双世界声明正确');
ok(cs[2].world === 'MAIN', 'shopee inject.js 在 MAIN world');
ok(cs[4].matches.includes('http://*/*') && cs[4].matches.includes('https://*/*'), '图搜模块注入所有 http(s) 页面');
ok(cs[4].all_frames === true, '图搜模块注入 iframe（SEM 落地页多为 iframe 嵌套）');
ok(cs[4].js.includes('lib.js') && cs[4].js.includes('modules/image-search.js'), '图搜模块先加载 lib.js');
ok(manifest.action.default_popup === 'popup.html', '工具栏按钮挂 popup');
ok(manifest.options_ui.page === 'options.html', '设置页已挂');

/* ---- lib.js 图搜工具 ---- */
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(read('lib.js'), sandbox);
const { toBigImageUrl, buildSearchUrl, SEARCH_BASE } = sandbox.TB1688;
ok(SEARCH_BASE.startsWith('https://s.1688.com/youyuan/index.htm?imageAddress='), '图搜入口为 youyuan（kq 已 404 弃用）');
ok(
  toBigImageUrl('https://img.alicdn.com/imgextra/i3/abc.jpg_400x400.jpg') === 'https://img.alicdn.com/imgextra/i3/abc.jpg',
  '缩略图 _400x400.jpg 后缀被剥掉',
);
ok(
  toBigImageUrl('https://img.alicdn.com/imgextra/abc.jpg_q90.jpg_.webp') === 'https://img.alicdn.com/imgextra/abc.jpg',
  '缩略图 _q90.jpg_.webp 后缀被剥掉',
);
ok(toBigImageUrl('not a url') === 'not a url', '非 http 输入原样返回');

/* ---- background：三路消息 + 右键菜单 + 配置迁移 ---- */
const bg = read('background.js');
ok(bg.includes("importScripts('lib.js')"), 'background 引入 lib.js');
for (const type of ['getSettings', 'saveSettings', 'check', 'testConnection', 'collect']) {
  ok(bg.includes(`async ${type}(`), `1688 采集消息 ${type} 已注册`);
}
for (const type of ['api', 'ratings_status', 'cookie', 'page_html', 'ldjson']) {
  ok(bg.includes(`async ${type}(`), `Shopee 采集消息 ${type} 已注册`);
}
ok(bg.includes("'open-1688-search'"), '图搜消息已注册');
ok(bg.includes('toolkitSettings'), '统一配置键 toolkitSettings');
ok(bg.includes('sourcingSettings'), '旧 sourcing 配置迁移');
ok(bg.includes('chrome.storage.sync'), '旧 shopee sync 配置迁移');
ok(!/collectToken|X-Collect-Token/.test(bg), '采集 token 机制已移除（2026-10-24 用户决策）');
ok(bg.includes("id: 'tb1688-image-search'"), '全网右键菜单已注册');
ok(!/action\?\.onClicked/.test(bg), '有 popup 后不再用 action.onClicked（避免双入口）');

/* ---- 模块开关 ---- */
const iso = read('isolated.js');
ok(iso.includes('toolkitToggles') && /t\.sourcing === false/.test(iso), '1688 采集模块受 popup 开关控制');
const shopee = read('content.js');
ok(shopee.includes('toolkitToggles') && /t\.shopee === false/.test(shopee), 'Shopee 采集模块受 popup 开关控制');
ok(
  shopee.includes('parseItemIds') && shopee.includes('/product/'),
  '商品 ID 解析兼容新 /product/{shop}/{item} URL 形态（2026-10-24 修）',
);
const imgs = read('modules/image-search.js');
ok(imgs.includes('storage.onChanged') && /imageSearch === false/.test(imgs), '图搜开关实时生效');
ok(imgs.includes('tb1688-img-badge'), '全网悬停角标');
ok(imgs.includes('bgUrlOf') && imgs.includes('backgroundImage'), '角标支持 CSS 背景图元素（淘宝营销页实测 21 处背景图）');
ok(imgs.includes('findHoverTarget'), '沿祖先链找最近可搜图');
ok(imgs.includes('altKey'), 'Alt+点击兜底入口');
ok(imgs.includes('og:image'), '淘宝/天猫商品页主图检测（og:image 优先）');
ok(imgs.includes('tb1688-fab'), '淘宝/天猫悬浮按钮');
ok(imgs.includes('__tb1688Injected'), '图搜模块防重复注入');

/* ---- popup ---- */
const popupJs = read('popup.js');
for (const key of ['imageSearch', 'sourcing', 'shopee']) {
  ok(popupJs.includes(`'${key}'`), `popup 开关 ${key}`);
}
ok(popupJs.includes('siteModule'), '按当前网站高亮对应模块');
ok(read('popup.html').includes('open-options'), 'popup 有设置入口');

/* ---- 冒烟也要跑得动旧模块的语法（防止守卫包裹改坏） ---- */
for (const f of ['isolated.js', 'content.js', 'modules/image-search.js', 'background.js', 'popup.js', 'lib.js']) {
  assert.doesNotThrow(() => new Function(read(f)), `${f} 语法可解析`);
  pass++;
  console.log(`  ✓ ${f} 语法可解析`);
}

console.log(`\n共 ${pass} 项检查全部通过 ✅`);
