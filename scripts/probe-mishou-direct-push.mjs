/**
 * 验证：在 ERP 网页上下文里直接调 push_collect_box 提交采集任务
 *
 * 背景：抓包发现点按钮最终就是发 POST /api/open/niu/push_collect_box，
 * body 只有 itemId/itemUrl/source/site/postFee/isAutoPublish，
 * 认证靠浏览器自动带的 ERP 会话 cookie（mserp）。
 * 如果直接在 ERP 域的页面里 fetch 就能通，自动采集就可以跳过
 * 「开 1688 页 → 等插件 → 点按钮」整条链路，字段全部可控。
 *
 * 本探针：开 erp.91miaoshou.com 标签 → check_login → push 一条
 * 已在采集箱的商品（956176979274），看响应结构。
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const PORT_FILE = "server/browser/profile/cdp-port.txt";
const OFFER_ID = "956176979274";

const rec = JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${rec.port}`, { timeout: 15_000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.goto("https://erp.91miaoshou.com/welcome", { waitUntil: "domcontentloaded", timeout: 45_000 });
// 等 SPA 起来（同源 fetch 才带 cookie）
for (let i = 0; i < 10; i++) {
  const len = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
  if (len > 50) break;
  await page.waitForTimeout(2_000);
}
console.log("ERP 页面就绪:", page.url());

const result = await page.evaluate(async (offerId) => {
  const body = new URLSearchParams({
    isAutoPublish: "0",
    itemSimpleDetails: JSON.stringify({
      [offerId]: {
        itemUrl: `https://detail.1688.com/offer/${offerId}.html`,
        itemId: offerId,
        site: "",
        source: "1688",
        postFee: "",
      },
    }),
  });

  // ① check_login
  let login;
  try {
    const r = await fetch("/api/open/niu/check_login", { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" } });
    login = await r.text();
  } catch (e) { login = "ERR " + String(e).slice(0, 100); }

  // ② push_collect_box
  let push;
  try {
    const r = await fetch("/api/open/niu/push_collect_box", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
    });
    push = { status: r.status, body: (await r.text()).slice(0, 800) };
  } catch (e) { push = { status: "ERR", body: String(e).slice(0, 200) }; }

  return { login: login.slice(0, 500), push };
}, OFFER_ID);

console.log("\ncheck_login:", result.login);
console.log("\npush_collect_box:", JSON.stringify(result.push, null, 2));

await page.close();
await browser.close();
