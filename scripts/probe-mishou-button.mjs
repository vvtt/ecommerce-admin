/**
 * 探针：检查比特窗口里妙手 ERP 插件的采集按钮。
 * ① 列出所有扩展 SW（确认妙手和工具箱都活着）
 * ② 打开 1688 详情页，扫描 DOM 里带「采集」文案的元素 / 妙手相关 iframe / 容器
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const PORT_FILE = "server/browser/profile/cdp-port.txt";
let port;
try {
  const rec = JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
  port = rec.port;
} catch {
  port = Number(process.argv[2]);
}
if (!port) {
  console.error("用法：node scripts/probe-mishou-button.mjs <CDP端口>");
  process.exit(1);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
const ctx = browser.contexts()[0];

console.log("== 扩展 service workers ==");
for (const sw of ctx.serviceWorkers()) console.log(" ", sw.url());

const page = await ctx.newPage();
await page.bringToFront().catch(() => {});
await page.goto("https://detail.1688.com/offer/956176979274.html", {
  waitUntil: "domcontentloaded",
  timeout: 45_000,
});
// 等远程 UI 注入
await page.waitForTimeout(12_000);

const report = await page.evaluate(() => {
  const out = { iframes: [], hits: [], hosts: [] };
  for (const f of document.querySelectorAll("iframe")) {
    out.iframes.push({ src: (f.src || "").slice(0, 120), id: f.id, cls: f.className?.slice?.(0, 60) });
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n;
    // 叶子元素且直接文本含「采集」
    const own = Array.from(el.childNodes)
      .filter((c) => c.nodeType === 3)
      .map((c) => c.textContent)
      .join("");
    if (own.includes("采集")) {
      const r = el.getBoundingClientRect();
      out.hits.push({
        tag: el.tagName,
        text: own.trim().slice(0, 40),
        cls: String(el.className).slice(0, 80),
        rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      });
    }
    // 妙手特征容器（id/class 含 miaoshou / kjerp / chengji / plw）
    const sig = `${el.id} ${el.className}`;
    if (/miaoshou|kjerp|chengji|kuajing|plw/i.test(sig) && out.hosts.length < 10) {
      const r = el.getBoundingClientRect();
      out.hosts.push({
        tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 80),
        rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      });
    }
  }
  return out;
});

console.log("== 「采集」文案元素 ==");
for (const h of report.hits) console.log(" ", JSON.stringify(h));
console.log("== 妙手特征容器 ==");
for (const h of report.hosts) console.log(" ", JSON.stringify(h));
console.log("== iframes ==");
for (const f of report.iframes) console.log(" ", JSON.stringify(f));

await page.close();
console.log("done");
