/**
 * 妙手「采集此商品」点击验证探针（2026-10-28）
 * 用户反馈：自动采集点击成功了，但 ERP 里没收到商品。
 * 本脚本：打开 1688 商品页 → 等妙手采集条 → 点击主按钮 →
 *   监听点击后 20s 内发往妙手服务端的请求（看有没有上报采集）+
 *   截图 + 抓页面上的弹窗/提示（登录引导？确认弹窗？失败提示？）
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const PORT_FILE = "server/browser/profile/cdp-port.txt";
const OFFER_URL = "https://detail.1688.com/offer/956176979274.html";
const MIAOSHOU_RE = /miaoshou|chengji|happyporsche|91miaoshou/i;

const rec = JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${rec.port}`, { timeout: 15_000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {});

const hits = [];
page.on("request", (r) => {
  const u = r.url();
  if (MIAOSHOU_RE.test(u)) hits.push(`REQ  ${r.method()} ${u.slice(0, 140)}`);
});
page.on("response", (r) => {
  const u = r.url();
  if (MIAOSHOU_RE.test(u) && r.request().method() !== "GET") {
    hits.push(`RESP ${r.status()} ${r.request().method()} ${u.slice(0, 140)}`);
  }
});
page.on("popup", (p) => hits.push(`POPUP ${p.url().slice(0, 120)}`));

console.log("[1] 打开商品页…");
await page.goto(OFFER_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

console.log("[2] 等妙手采集条挂载…");
let mounted = false;
const t0 = Date.now();
while (Date.now() - t0 < 90_000) {
  const ok = await page.evaluate(() => !!document.querySelector(".earth-wxt-collect-panel")).catch(() => false);
  if (ok) { mounted = true; break; }
  await page.waitForTimeout(2_000);
}
if (!mounted) { console.log("❌ 90s 采集条没挂载"); process.exit(1); }
console.log(`    挂载，用时 ${Math.round((Date.now() - t0) / 1000)}s`);

// 等按钮渲染 + 稳定
await page.waitForTimeout(8_000);
await page.screenshot({ path: "scripts/.mishou-before.png" });

console.log("[3] 定位并点击主按钮…");
const btn = await page.evaluate(() => {
  const el = document.querySelector(".earth-wxt-collect-panel .earth-wxt-button--primary");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, disabled: el.hasAttribute("disabled") };
});
if (!btn) { console.log("❌ 按钮没找到"); process.exit(1); }
console.log(`    按钮 @(${Math.round(btn.cx)},${Math.round(btn.cy)}) ${btn.w}x${btn.h} disabled=${btn.disabled}`);

await page.mouse.move(btn.cx, btn.cy, { steps: 5 });
await page.waitForTimeout(400);
await page.mouse.click(btn.cx, btn.cy);
console.log("    已点击");

console.log("[4] 观察 20s：请求/弹窗/提示…");
let captured = null;
const fbDeadline = Date.now() + 20_000;
while (Date.now() < fbDeadline) {
  captured = await page.evaluate(() => {
    // 弹窗类：el-dialog / el-message / 任意含"采集/登录/成功/失败"文案的浮层
    const out = [];
    for (const el of document.querySelectorAll("[class*='message'],[class*='dialog'],[class*='toast'],[class*='notification'],[class*='modal'],[class*='popup'],[role='dialog']")) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 20) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150);
      if (t && /采集|登录|成功|失败|会员|授权/.test(t)) out.push(`${el.className.toString().slice(0, 40)} | ${t}`);
    }
    return out;
  }).catch(() => null);
  if (captured && captured.length) break;
  await page.waitForTimeout(1_500);
}

await page.screenshot({ path: "scripts/.mishou-after.png" });

console.log("\n===== 点击后的妙手相关网络请求 =====");
const seen = new Set();
for (const h of hits) { if (!seen.has(h)) { seen.add(h); console.log(" ", h); } }
if (!hits.length) console.log("  （没有任何发往妙手域的请求！）");

console.log("\n===== 页面浮层/提示 =====");
if (captured && captured.length) for (const c of captured) console.log("  ", c);
else console.log("  （没有检测到采集相关弹窗）");

await page.close();
await browser.close();
