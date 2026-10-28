/**
 * taobao-1688-search 插件冒烟测试
 * 验证：manifest 结构、lib.js 缩略图转原图规则、图搜 URL 组装、关键接线点存在
 * 运行：node extension/taobao-1688-search/test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
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

// --- manifest ---
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));
ok(manifest.manifest_version === 3, 'manifest 为 MV3');
ok(manifest.permissions.includes('contextMenus'), '声明 contextMenus 权限');
ok(manifest.background.service_worker === 'background.js', 'background 指向 service worker');
const matches = manifest.content_scripts[0].matches.join(' ');
ok(/taobao\.com/.test(matches), 'content script 覆盖淘宝');
ok(/tmall\.(com|hk)/.test(matches), 'content script 覆盖天猫/天猫国际');
ok(manifest.content_scripts[0].js.includes('lib.js'), 'content script 先加载 lib.js');

// --- lib.js 在 vm 里执行 ---
const libSrc = readFileSync(join(root, 'lib.js'), 'utf-8');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(libSrc, sandbox);
const { toBigImageUrl, buildSearchUrl, SEARCH_BASE } = sandbox.TB1688;

ok(SEARCH_BASE.startsWith('https://s.1688.com/youyuan/index.htm?imageAddress='), '图搜入口为 youyuan（kq 已 404 弃用）');
ok(
  toBigImageUrl('https://img.alicdn.com/imgextra/i3/abc.jpg_400x400.jpg') === 'https://img.alicdn.com/imgextra/i3/abc.jpg',
  '缩略图 _400x400.jpg 后缀被剥掉'
);
ok(
  toBigImageUrl('https://img.alicdn.com/imgextra/abc.jpg_q90.jpg_.webp') === 'https://img.alicdn.com/imgextra/abc.jpg',
  '缩略图 _q90.jpg_.webp 后缀被剥掉'
);
ok(toBigImageUrl('https://img.alicdn.com/imgextra/abc.jpg') === 'https://img.alicdn.com/imgextra/abc.jpg', '原图 URL 原样保留');
ok(
  buildSearchUrl('https://img.alicdn.com/imgextra/abc.jpg') ===
    SEARCH_BASE + encodeURIComponent('https://img.alicdn.com/imgextra/abc.jpg'),
  'buildSearchUrl 对原图做 encodeURIComponent'
);

// --- 接线点 ---
const bg = readFileSync(join(root, 'background.js'), 'utf-8');
ok(bg.includes("importScripts('lib.js')"), 'background 引入 lib.js');
ok(bg.includes("id: 'taobao1688-search'"), '右键菜单已注册');
ok(bg.includes('chrome.tabs.create'), 'background 用 tabs.create 打开结果页');
const cs = readFileSync(join(root, 'content.js'), 'utf-8');
ok(cs.includes('og:image'), '主图检测优先 og:image');
ok(cs.includes('__tb1688Injected'), 'content script 有防重复注入');
ok(cs.includes("type: 'open-1688-search'"), 'content 到 background 的消息已接好');
ok(cs.includes('MutationObserver'), 'SPA 路由变化会重新检测主图');

console.log(`\n共 ${pass} 项检查全部通过 ✅`);
