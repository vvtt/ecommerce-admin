/**
 * 探针：验证比特窗口用 --load-extension 挂本地扩展是否可行，
 * 以及重开窗口（profile 复用）后扩展是否还活着（Edge 曾有
 * unsupportedDeveloperExtension 二次启动禁用的坑）。
 * 流程：关窗 → 带 args 开窗 → CDP 查扩展 SW → 关窗 → 再开 → 再查。
 */
import { chromium } from "playwright-core";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BIT_API = "http://127.0.0.1:54345";
const WINDOW_ID = "e380f0657895493aba228c7fd48cd77d";
const EXT_DIR = path.resolve("extension", "cross-border-toolkit");

async function post(p, body) {
  const res = await fetch(BIT_API + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.success === false) throw new Error(`${p}: ${json.msg}`);
  return json.data;
}

async function probeOnce(round) {
  const data = await post("/browser/open", {
    id: WINDOW_ID,
    args: [`--load-extension=${EXT_DIR}`],
  });
  const port = Number(data.http.split(":").pop());
  console.log(`[round ${round}] 窗口已开，CDP 端口 ${port}`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  const ctx = browser.contexts()[0];
  // 等 service worker 起来（MV3 扩展加载后会有 chrome-extension:// 的 SW target）
  let found = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !found) {
    const sws = ctx.serviceWorkers();
    found = sws.find((sw) => sw.url().startsWith("chrome-extension://"));
    if (!found) await new Promise((r) => setTimeout(r, 800));
  }
  if (found) {
    console.log(`[round ${round}] ✅ 扩展已加载：${found.url()}`);
  } else {
    console.log(`[round ${round}] ❌ 20s 内没有发现扩展 service worker`);
    console.log(`[round ${round}] 当前 SW 列表:`, ctx.serviceWorkers().map((s) => s.url()));
  }
  await browser.close();
}

// 初始关窗，保证两轮都是「带 args 冷启动」
await post("/browser/close", { id: WINDOW_ID }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

await probeOnce(1);
await post("/browser/close", { id: WINDOW_ID });
await new Promise((r) => setTimeout(r, 3000));
await probeOnce(2);

console.log("done");
