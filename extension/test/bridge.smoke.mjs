/**
 * isolated.js ↔ background.js 联调冒烟测试。
 *
 * 这两个文件靠 `chrome.runtime.sendMessage` 通信，在浏览器里没法单独调试 ——
 * 出问题时的表现是「浮层不出现」或者「点了按钮没反应」，没有任何报错线索。
 * 这里把 chrome.* 用最小的桩接起来，让整条链路在 Node 里真的跑一遍：
 *
 *   data 事件 → isolated 渲染浮层 → 点「采集」→ background 发 POST → 断言请求
 *
 * 验的是**消息形状对不对**（两边字段名是否一致、token 有没有带上、
 * 上报的是不是 offer 本身）。不验网络与真实 Chrome 行为。
 *
 * 跑法：node extension/test/bridge.smoke.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..");

let passed = 0;
const failures = [];

const check = (name, condition, detail = "") => {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  → ${detail}` : ""}`);
  }
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);

/* ------------------------------------------------------------------ *
 * chrome.* 的桩
 * ------------------------------------------------------------------ */

const storage = { sourcingSettings: { backendUrl: "http://localhost:3000", collectToken: "test-token-abc" } };
const messageListeners = [];

/** 把 sendMessage 直接接到背景脚本注册的监听器上，模拟真实的消息投递 */
const deliver = (message) =>
  new Promise((resolve, reject) => {
    // 没有监听器时真实行为是 reject("Receiving end does not exist")
    if (!messageListeners.length) {
      reject(new Error("Receiving end does not exist"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("background 没有回消息")), 5_000);
    for (const listener of messageListeners) {
      const kept = listener(message, {}, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (!kept) return; // 监听器已同步回应
    }
  });

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
      set: async (obj) => Object.assign(storage, obj),
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    sendMessage: (message) => deliver(message),
    onInstalled: { addListener: () => {} },
    openOptionsPage: () => {},
  },
  action: { onClicked: { addListener: () => {} } },
};

/* ------------------------------------------------------------------ *
 * fetch 的桩 —— 记录请求，按 URL 回不同的响应
 * ------------------------------------------------------------------ */

const requests = [];

globalThis.fetch = async (url, init = {}) => {
  requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });

  if (url.includes("/lookup")) {
    return { ok: true, status: 200, json: async () => ({ exists: false, offer: null }) };
  }
  if (url.includes("/collect")) {
    return {
      ok: true,
      status: 201,
      json: async () => ({ offer: { id: "offer-row-1", offerId: "1031250827028" }, action: "created" }),
    };
  }
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
};

/* ------------------------------------------------------------------ *
 * DOM 的桩
 * ------------------------------------------------------------------ */

/** data-act="x" 是浮层里按钮的唯一标识，从这里把按钮"找"出来 */
const actsIn = (html) => [...String(html).matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);

/** act → 该按钮当前绑定的 click 处理函数 */
const buttonHandlers = new Map();

const makeEl = (tag) => {
  const el = {
    tagName: tag,
    style: {},
    children: [],
    textContent: "",
    className: "",
    _html: "",
    // shadow 的 append 记在宿主身上，所以 host.children === [style, panel]
    attachShadow: () => ({ append: (...nodes) => el.children.push(...nodes) }),
    append: (...nodes) => el.children.push(...nodes),
    appendChild: (node) => el.children.push(node),
    remove: () => {},
    addEventListener: () => {},
    getAttribute: () => null,
    querySelectorAll: () => {
      // 每次 render 都会重新绑一遍，所以直接覆盖（Map 天然如此）
      return actsIn(el._html).map((act) => ({
        getAttribute: (name) => (name === "data-act" ? act : null),
        addEventListener: (_event, fn) => buttonHandlers.set(act, fn),
      }));
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get: () => el._html,
    set: (value) => {
      el._html = String(value);
    },
  });
  return el;
};

const document_ = new EventTarget();
document_.createElement = makeEl;
document_.body = makeEl("body");

/** isolated.js 会在 mount() 里把浮层宿主挂到 body 上，从这里抓住它 */
let mountedHost = null;
document_.body.appendChild = (node) => {
  mountedHost = node;
};

/** isolated.js 的数据事件名带随机 token，只能从注册的监听器里认出来 */
const dataEventNames = [];
const originalAdd = document_.addEventListener.bind(document_);
document_.addEventListener = (type, fn, options) => {
  if (String(type).startsWith("__sc_data_")) dataEventNames.push(type);
  return originalAdd(type, fn, options);
};

globalThis.document = document_;
// isolated.js 用 window.__SC_ISOLATED_LOADED__ 做重复注入保护
globalThis.window = globalThis;

/* ------------------------------------------------------------------ *
 * 加载两个脚本
 * ------------------------------------------------------------------ */

console.log("加载 background.js / isolated.js …");
vm.runInThisContext(readFileSync(join(EXT, "background.js"), "utf8"), { filename: "background.js" });
vm.runInThisContext(readFileSync(join(EXT, "isolated.js"), "utf8"), { filename: "isolated.js" });

eq("isolated 注册了数据监听", dataEventNames.length, 1);
check("浮层宿主已挂到 body", Boolean(mountedHost));
check("shadow 里有 style + panel 两个节点", mountedHost?.children.length === 2, String(mountedHost?.children.length));

const panel = mountedHost?.children[1];
check("取到 panel 节点", Boolean(panel));
const panelHtml = () => panel?.innerHTML ?? "";

check("初始渲染的是「解析中」状态", panelHtml().includes("正在解析页面数据"), panelHtml().slice(0, 120));

/* ------------------------------------------------------------------ *
 * 推一份解析结果进去（形状与 main-world.js 的 publish 一致）
 * ------------------------------------------------------------------ */

const snapshotDetail = {
  ok: true,
  warnings: [],
  summary: {
    offerId: "1031250827028",
    title: "跨境爆款手持小风扇",
    supplierName: "广州胜丰玩具有限公司",
    moq: 1,
    priceMin: 2.29,
    priceMax: 4.99,
    skuCount: 3,
    attributeCount: 3,
    mainCount: 3,
    detailCount: 2,
    weightGram: 141,
    priceMode: "skuPrice",
  },
  offer: {
    platform: "1688",
    offerId: "1031250827028",
    url: "https://detail.1688.com/offer/1031250827028.html",
    title: "跨境爆款手持小风扇",
    supplier: { name: "广州胜丰玩具有限公司" },
    moq: 1,
    priceLadder: [],
    specDimensions: [],
    skus: [{ skuId: "1", specValues: { 颜色: "红" }, price: 2.29, stock: 10 }],
    attributes: [],
    images: { main: ["https://cbu01.alicdn.com/a.jpg"], detail: [] },
    weightGram: 141,
    extractorVersion: "1688/2",
    capturedAt: new Date().toISOString(),
  },
};

document_.dispatchEvent(new CustomEvent(dataEventNames[0], { detail: snapshotDetail }));
// 让 checkExisting 的 await 跑完
await new Promise((r) => setTimeout(r, 50));

console.log("\n--- 浮层渲染 ---");
check("标题渲染出来", panelHtml().includes("跨境爆款手持小风扇"), panelHtml().slice(0, 200));
check("供应商渲染出来", panelHtml().includes("广州胜丰玩具有限公司"));
check("价格区间渲染成 ¥2.29 ~ ¥4.99", panelHtml().includes("¥2.29 ~ ¥4.99"), panelHtml().slice(0, 400));
check("价格模式与 SKU 数有显示", panelHtml().includes("skuPrice") && panelHtml().includes("3 个 SKU"));
check("起批量显示", panelHtml().includes(">1<"));
check("图片计数显示", panelHtml().includes("主图 3 · 详情 2"));
check("重量显示", panelHtml().includes("141g"));
check("状态标成已解析", panelHtml().includes("已解析"));
check("采集按钮存在", buttonHandlers.has("collect"), [...buttonHandlers.keys()].join(","));

console.log("\n--- 查重请求 ---");
const lookup = requests.find((r) => r.url.includes("/lookup"));
check("解析成功后自动查重", Boolean(lookup), JSON.stringify(requests.map((r) => r.url)));
check("查重 URL 带 offerId", lookup?.url.includes("offerId=1031250827028"), lookup?.url);
check("查重 URL 带 platform", lookup?.url.includes("platform=1688"), lookup?.url);
check("查重是 GET", lookup?.method === "GET", lookup?.method);
check("查重**不带** token（只读接口，不需要）", !("X-Collect-Token" in (lookup?.headers ?? {})));

console.log("\n--- 点「采集到货源库」 ---");
buttonHandlers.get("collect")();
await new Promise((r) => setTimeout(r, 80));

const post = requests.find((r) => r.url.includes("/collect"));
check("发出了 POST", Boolean(post), JSON.stringify(requests.map((r) => r.url)));
eq("打到正确的路径", post?.url, "http://localhost:3000/api/sourcing/collect");
eq("方法是 POST", post?.method, "POST");
eq("带上 X-Collect-Token", post?.headers["X-Collect-Token"], "test-token-abc");
eq("Content-Type 是 JSON", post?.headers["Content-Type"], "application/json");

const sent = post ? JSON.parse(post.body) : null;
eq("上报的是 offer 本身（不是外面那层 {ok,summary}）", sent?.offerId, "1031250827028");
eq("载荷 platform 正确", sent?.platform, "1688");
check("载荷不含 summary（那是界面用的，不该上报）", sent && !("summary" in sent), Object.keys(sent ?? {}).join(","));
check("载荷不含 warnings", sent && !("warnings" in sent));
check("载荷不含查重结果", sent && !("exists" in sent));

console.log("\n--- 采集成功后 ---");
check("按钮变成「更新已有记录」", panelHtml().includes("更新已有记录"), panelHtml().slice(-300));
check("给出成功反馈", panelHtml().includes("已采集到货源库"));

/* ------------------------------------------------------------------ *
 * 失败路径
 * ------------------------------------------------------------------ */

console.log("\n--- 失败路径：后端挂掉 ---");
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new TypeError("Failed to fetch");
};

requests.length = 0;
storage.sourcingSettings = { backendUrl: "http://localhost:3000", collectToken: "test-token-abc" };
const failure = await deliver({ type: "collect", offer: snapshotDetail.offer });

eq("返回 ok:false", failure.ok, false);
check("提示里带上后端地址，用户知道去哪找", failure.error.includes("http://localhost:3000"), failure.error);
check("提示可操作（让用户确认 npm run dev）", failure.error.includes("npm run dev"), failure.error);

console.log("\n--- 失败路径：没配 token ---");
storage.sourcingSettings = { backendUrl: "http://localhost:3000", collectToken: "" };
globalThis.fetch = realFetch;
const noToken = await deliver({ type: "collect", offer: snapshotDetail.offer });

eq("返回 ok:false", noToken.ok, false);
check("指向设置页而不是让用户猜", noToken.error.includes("设置页"), noToken.error);

console.log("\n--- 失败路径：后端 401 ---");
storage.sourcingSettings = { backendUrl: "http://localhost:3000", collectToken: "wrong" };
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) });
const unauthorized = await deliver({ type: "collect", offer: snapshotDetail.offer });

eq("返回 ok:false", unauthorized.ok, false);
check("401 被翻译成「token 不对」而不是「网络问题」", unauthorized.error.includes("token 不对"), unauthorized.error);

console.log("\n--- 未知消息类型 ---");
const unknown = await deliver({ type: "nope" });
eq("明确拒绝", unknown.ok, false);
check("报出类型名", unknown.error.includes("nope"), unknown.error);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log(`\n${"=".repeat(52)}`);
if (failures.length) {
  console.log(`FAILED —— ${passed} 通过, ${failures.length} 失败`);
  for (const name of failures) console.log(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`PASSED —— ${passed} 项全部通过`);
