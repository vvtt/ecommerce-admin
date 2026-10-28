/**
 * 探针 3：轮询等妙手浮窗出现（用户反馈：页面加载一段时间后才出现）。
 * 每 3s 查一次：happyporsche iframe / 「采集」文案叶子元素 / 超大 z-index fixed 容器。
 * 出现后打印按钮结构 + 截图，最多等 120s。
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const rec = JSON.parse(fs.readFileSync("server/browser/profile/cdp-port.txt", "utf-8"));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${rec.port}`);
const ctx = browser.contexts()[0];

const page = await ctx.newPage();
await page.bringToFront().catch(() => {});
await page.goto("https://detail.1688.com/offer/956176979274.html", {
  waitUntil: "domcontentloaded",
  timeout: 45_000,
});

const t0 = Date.now();
let appeared = null;
while (Date.now() - t0 < 120_000) {
  const s = await page.evaluate(() => {
    const out = { iframes: [], texts: [], bigZ: [] };
    for (const f of document.querySelectorAll("iframe")) {
      if (/happyporsche|miaoshou|plw/i.test(f.src || "")) {
        const r = f.getBoundingClientRect();
        out.iframes.push({ src: f.src.slice(0, 100), rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` });
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      const el = n;
      const own = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join("");
      if (own.includes("采集")) {
        const r = el.getBoundingClientRect();
        out.texts.push({ tag: el.tagName, text: own.trim().slice(0, 30), cls: String(el.className).slice(0, 60), rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` });
      }
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" && Number(cs.zIndex) > 1e6 && el.children.length) {
        const r = el.getBoundingClientRect();
        out.bigZ.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60), rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` });
      }
    }
    out.texts = out.texts.slice(0, 8);
    out.bigZ = out.bigZ.slice(0, 5);
    return out;
  }).catch(() => null);
  if (s && (s.iframes.length || s.texts.length || s.bigZ.length)) {
    appeared = { atSec: Math.round((Date.now() - t0) / 1000), ...s };
    break;
  }
  await page.waitForTimeout(3_000);
}

if (!appeared) {
  console.log("120s 内妙手 UI 未出现");
} else {
  console.log(`✅ ${appeared.atSec}s 时妙手 UI 出现：`);
  console.log("iframes:", JSON.stringify(appeared.iframes, null, 1));
  console.log("texts:", JSON.stringify(appeared.texts, null, 1));
  console.log("bigZ:", JSON.stringify(appeared.bigZ, null, 1));
  await page.screenshot({ path: "scripts/.mishou-page2.png" });
  console.log("screenshot saved: scripts/.mishou-page2.png");
}
await page.close();
await browser.close();
console.log("done");
