/**
 * 抓妙手「采集此商品」提交报文 v2 —— 原生 CDP WebSocket 直连 SW target
 *
 * v2 原因：playwright 该版本的 Worker 没有 newCDPSession()，且实测 0 条
 * 页面层请求 → 提交必走 background service worker。改用 Node 22 内置
 * WebSocket 连浏览器 DevTools 端点，Target.attachToTarget(flatten) 附着
 * SW target，Network.enable 抓全部请求。
 *
 * 点击仍用 playwright（真实鼠标事件）。抓包窗口：点击前挂好监听 →
 * 点击 → 25s 后转储 scripts/.mishou-submit-capture.json。
 */
import { chromium } from "playwright-core";
import fs from "node:fs";

const PORT_FILE = "server/browser/profile/cdp-port.txt";
const OFFER_URL = "https://detail.1688.com/offer/884976102205.html";
const MIAOSHOU_RE = /miaoshou|chengji|happyporsche/i;
/** 妙手插件在比特窗口里的扩展 ID（URL 里只有 ID 没有 miaoshou 字样） */
const MIAOSHOU_EXT_ID = "conjbfo";

const rec = JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
const port = rec.port;

/* ---------- 原生 CDP WebSocket ---------- */
const captured = [];
const sessionByUrl = new Map(); // sessionId → target URL（onMessage 在模块层引用）
let msgId = 0;
const pending = new Map();
let ws;
let swSessionId = null;

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function onMessage(raw) {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  // 带 sessionId 的事件 —— 记录来源 target
  if (msg.sessionId && msg.method === "Network.requestWillBeSent") {
    const r = msg.params.request;
    if (MIAOSHOU_RE.test(r.url)) {
      captured.push({
        from: sessionByUrl.get(msg.sessionId) ?? msg.sessionId.slice(0, 8),
        method: r.method, url: r.url, body: r.postData ?? null, headers: r.headers, reqId: msg.params.requestId,
      });
    }
  }
  if (msg.sessionId && msg.method === "Network.responseReceived") {
    const hit = captured.find((c) => c.reqId === msg.params.requestId && c.status === undefined);
    if (hit) hit.status = msg.params.response.status;
  }
}

async function main() {
  // ① 拿浏览器级 DevTools WS
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => onMessage(e.data);

  // ② playwright 开页（页面交互方便），SW 稍后原生附着
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto(OFFER_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

  // ③ 附着窗口里全部 target（页面+SW），记录来源 —— 提交可能从 ERP 网页标签发出
  const { targetInfos } = await send("Target.getTargets");
  const targets = targetInfos.filter((t) => t.type === "page" || t.type === "service_worker" || t.type === "iframe");
  console.log("窗口内 target：", targets.map((t) => `${t.type}:${t.url.slice(0, 60)}`));
  for (const t of targets) {
    try {
      const attached = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      sessionByUrl.set(attached.sessionId, t.url.slice(0, 70));
      await send("Network.enable", {}, attached.sessionId);
    } catch (e) {
      console.log(`attach 失败 ${t.url.slice(0, 50)}:`, String(e).slice(0, 80));
    }
  }
  console.log(`✅ 已附着 ${sessionByUrl.size} 个 target 并开启 Network 监听`);

  // ④ 等采集条挂载，点按钮
  let mounted = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const ok = await page.evaluate(() => !!document.querySelector(".earth-wxt-collect-panel")).catch(() => false);
    if (ok) { mounted = true; break; }
    await page.waitForTimeout(2_000);
  }
  if (!mounted) { console.log("❌ 采集条没挂载"); process.exit(1); }
  await page.waitForTimeout(8_000);

  const btn = await page.evaluate(() => {
    const el = document.querySelector(".earth-wxt-collect-panel .earth-wxt-button--primary");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  if (!btn) { console.log("❌ 按钮没找到"); process.exit(1); }
  console.log("点击采集按钮…");
  await page.mouse.click(btn.cx, btn.cy);

  // ⑤ 25s 收包
  await page.waitForTimeout(25_000);

  const reqs = captured.filter((c) => c.method !== "OPTIONS");
  console.log(`\n===== SW 层共捕获 ${captured.length} 条（含预检），有效请求 ${reqs.length} 条 =====`);
  fs.writeFileSync("scripts/.mishou-submit-capture.json", JSON.stringify(captured, null, 2), "utf-8");
  for (const c of reqs) {
    console.log(`\n${c.status ?? ""} ${c.method} ${c.url.slice(0, 150)}`);
    if (c.body) console.log("  BODY:", c.body.length > 2000 ? c.body.slice(0, 2000) + `…(共${c.body.length})` : c.body);
  }
  await page.close();
  await browser.close();
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
