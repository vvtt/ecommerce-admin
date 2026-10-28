/**
 * 探针 2：打开 1688 详情页等 25s，整页截图落盘（人工/多模态确认妙手按钮），
 * 同时 pierce open shadow root 找 fixed 定位注入元素。
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
await page.waitForTimeout(25_000);

await page.screenshot({ path: "scripts/.mishou-page.png" });
console.log("screenshot saved");

// pierce open shadow roots 找 fixed/absolute 注入物
const found = await page.evaluate(() => {
  const out = [];
  const walk = (root, depth) => {
    if (depth > 6) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      const s = getComputedStyle(el);
      if ((s.position === "fixed" || s.position === "absolute") && Number(s.zIndex) > 999) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 20 && r.width < 600) {
          out.push({
            tag: el.tagName,
            id: el.id,
            cls: String(el.className).slice(0, 70),
            text: (el.textContent || "").trim().slice(0, 50),
            rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          });
        }
      }
    }
  };
  walk(document, 0);
  return out.slice(0, 20);
});
for (const f of found) console.log(JSON.stringify(f));

await page.close();
await browser.close();
console.log("done");
