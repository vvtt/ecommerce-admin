/**
 * 弹出式浏览器管理器：拉起一个真实浏览器窗口，并由服务端托管。
 *
 * 两种驱动（2026-10-21 起默认比特，Edge 降级为兜底）：
 *   - 比特（driver=bit）：通过比特管理端 Local API 打开指纹窗口（多账号
 *     隔离的主方案），拿到 CDP 端点后 connectOverCDP 接管，采集管线零改动
 *   - Edge（driver=edge）：直接 spawn 系统 Edge + 调试端口（原有路径，
 *     比特不可用时兜底，保证采集管线永远有窗口可用）
 *
 * 为什么从「内嵌截屏流」改成「弹出窗口」：canvas 里模拟真实网页的操作体验
 * 太差（输入法、右键菜单、拖拽、原生弹窗都受限）。弹出真实窗口原生操作，
 * 服务端以 CDP 持有它 —— 后续所有抓取/自动化都通过同一条 CDP 连接执行。
 *
 * 生命周期：不再自动关闭（弹出窗口由用户自己管理）；dev server 重启后
 * 会通过 cdp-port.txt 探活重新接管旧实例，不会重复拉起第二个窗口。
 */
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, CDPSession, Page, Response } from "playwright-core";
import { closeBitWindow, ensureBitWindowOpen } from "./bit";
import { handlePdp, handleRatings, handleSearch, hasPdpFile, markNoReviews } from "../competitor/ingest";
import {
  createCollectTask,
  finishCollectTask,
  getTaskItemStats,
  insertCollectTaskItems,
  listCollectTasks,
  listPendingRatings,
  listTaskItemsByStatus,
  resetFailedTaskItems,
  reviveCollectTask,
  updateCollectTaskItem,
  updateCollectTaskProgress,
} from "../competitor/repository";

const PROFILE_DIR = path.join(process.cwd(), "server", "browser", "profile");
/** 插件清单：路径相对项目根（与 PROFILE_DIR 同基准），绝对路径也兼容 */
const EXTENSIONS_FILE = path.join(process.cwd(), "server", "browser", "extensions.json");
/** CDP 端口记录：dev server 重启后据此探活接管旧实例（Edge 或比特窗口） */
const PORT_FILE = path.join(PROFILE_DIR, "cdp-port.txt");

/** 当前托管浏览器的驱动类型 */
type BrowserDriver = "bit" | "edge";

/** cdp-port.txt 的落盘内容（纯数字是历史 Edge 格式，读取时兼容） */
interface PortRecord {
  port: number;
  driver: BrowserDriver;
  /** driver=bit 时的指纹窗口 id（关闭窗口要回传给比特 API） */
  bitWindowId?: string;
  /** 启动时是否挂了工具箱插件（1688 自动采集依赖；接管旧实例时靠它判断要不要重启窗口） */
  withToolkit?: boolean;
}

function readPortRecord(): PortRecord | null {
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf-8").trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const o = JSON.parse(raw) as PortRecord;
      if (Number.isInteger(o.port) && o.port > 0) {
        return {
          port: o.port,
          driver: o.driver === "bit" ? "bit" : "edge",
          bitWindowId: o.bitWindowId,
          withToolkit: o.withToolkit === true,
        };
      }
      return null;
    }
    // 旧格式：纯数字端口（当时只有 Edge 一种驱动）
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 ? { port, driver: "edge" } : null;
  } catch {
    return null; // 首次运行还没有端口记录，属正常路径
  }
}

function writePortRecord(record: PortRecord): void {
  fs.writeFileSync(PORT_FILE, JSON.stringify(record), "utf-8");
}

export interface BrowserStatus {
  running: boolean;
  /** 浏览器主进程 PID；比特驱动/接管旧实例时拿不到 spawn PID，为 null */
  pid: number | null;
  /** CDP 远程调试端口，后续抓取模块复用同一连接的入口 */
  port: number | null;
  /** 当前驱动：bit=比特指纹窗口，edge=原生 Edge */
  driver: BrowserDriver | null;
  startedAt: string | null;
  /** 当前关注页面的主框架 URL（用户最近导航的页面） */
  url: string;
  /** 所有打开标签页的 URL 列表 */
  tabs: string[];
  /** 插件健康检查结果；null = 本次会话还没查完 */
  extensions: ExtensionCheck | null;
  /** 搜索批次拦截统计（累计值） */
  search: SearchStats;
  /** 评论/PDP 拦截统计（累计值） */
  ratings: RatingStats;
  /** 批量评论采集进度（单任务状态机） */
  ratingsBatch: RatingsBatchState;
}

export interface ExtensionCheck {
  checkedAt: string;
  /** extensions.json 里配置的插件逐个核对后的加载状态 */
  items: { name: string; enabled: boolean }[];
  /** 检查过程本身出错（不影响浏览器使用） */
  error?: string;
}

/** developerPrivate.getExtensionsInfo 返回项里用得到的字段 */
interface ExtensionInfoRaw {
  name: string;
  state: string;
  locationText?: string;
  prettifiedPath?: string;
}

interface Session {
  browser: Browser;
  context: BrowserContext;
  pid: number | null;
  port: number;
  driver: BrowserDriver;
  /** driver=bit 时的指纹窗口 id（closeBrowser 回传给比特 API） */
  bitWindowId?: string;
  startedAt: string;
  child?: ReturnType<typeof spawn>;
  /** 启动时是否通过 --load-extension 挂了扩展（ensureBrowser 的 opts 传入时置位） */
  withToolkit: boolean;
}

/**
 * 搜索批次拦截统计：托管浏览器里任何标签页发出的搜索结果响应都会被
 * 截获入库（页面自己发的请求，自带登录态与反爬签名，CDP 只旁观）。
 * 为什么用 playwright 的 response 事件而不是裸 CDP Network 域：
 * 事件语义相同但 body 解压/编码由 playwright 处理，少一层坑。
 */
export interface SearchStats {
  batches: number;
  received: number;
  added: number;
  skipped: number;
  tagged: number;
  errors: number;
  /** 空批次数（响应正常但 items 为空 —— 通常是 Shopee 风控限流的信号） */
  empty: number;
  lastKeyword: string;
  lastAt: string | null;
}

const searchStats: SearchStats = {
  batches: 0,
  received: 0,
  added: 0,
  skipped: 0,
  tagged: 0,
  errors: 0,
  empty: 0,
  lastKeyword: "",
  lastAt: null,
};

/** Shopee 搜索结果接口（v2/v4 都算，路径变了这里一处改） */
const SEARCH_API_RE = /\/api\/v\d+\/search\/search_items(?:\?|$)/;

/** 评论接口（PDP 评论区分页加载）。shopid/itemid 在 URL query 里 */
const RATINGS_API_RE = /\/api\/v\d+\/item\/get_ratings(?:\?|$)/;

/** PDP 详情接口（打开商品页时自动发，顺手截获补全 SKU/变体/描述） */
const PDP_API_RE = /\/api\/(?:v4\/pdp\/get_pc|v\d\/item\/get)(?:\?|$)/;

/**
 * 评论/PDP 拦截统计（与搜索采集分开计数）。
 * total 记录最近一个商品在文件里的评论累计条数。
 */
export interface RatingStats {
  batches: number;
  new: number;
  total: number;
  pdpSaved: number;
  lastItem: string;
  lastAt: string | null;
}

const ratingStats: RatingStats = {
  batches: 0,
  new: 0,
  total: 0,
  pdpSaved: 0,
  lastItem: "",
  lastAt: null,
};

/**
 * 并发采集时的 per-item 计数器。ratingStats 是全局累计，两个标签页同时采
 * 会互相污染 delta（A 商品的响应会让 B 误判「首批已落地」、把 A 的评论记到
 * B 头上）。采集方在开始前注册、结束后注销，响应拦截按商品归属登记。
 */
interface ItemRatingCounter {
  batches: number;
  /** 本商品新增评论文 */
  new: number;
  /** 评论文件累计条数（handleRatings 返回的 total） */
  total: number;
  pdpSaved: number;
  /**
   * 零评论快跳标记：get_pc 的 item_rating.rating_count[0]===0 时置位。
   * 只在响应解析明确给出 0 时才置位（解析不到不置位，回退常规滚动流程）——
   * 零评论商品没有评论区可渲染，滚动循环注定空转到超时，这是「评论少的
   * 商品也慢」的最后一块固定成本。
   */
  zeroComment?: boolean;
}

const activeRatingCounters = new Map<string, ItemRatingCounter>();

const counterKey = (shopId: string, itemId: string) => `${shopId}_${itemId}`;

/** 从请求 URL 或页面 URL 解析搜索关键字，作为入库打标的标签 */
function parseKeyword(requestUrl: string, pageUrl: string): string {
  for (const candidate of [requestUrl, pageUrl]) {
    try {
      const kw = new URL(candidate).searchParams.get("keyword");
      if (kw) return kw;
    } catch {
      // 非法 URL 跳过，试下一个来源
    }
  }
  return "";
}

let session: Session | null = null;
let starting: Promise<void> | null = null;
let currentUrl = "about:blank";
let extensionCheck: ExtensionCheck | null = null;
let extensionCheckPromise: Promise<void> | null = null;
/** 已挂 URL 监听的 CDP 会话，防止对同一页面重复 attach */
const watched = new WeakSet<CDPSession>();

/** 给「裸域名」补 https://；已有 scheme（http:/data:/about: 等）的原样保留 */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

/** 找系统安装的 Edge（channel msedge 对应的可执行文件），找不到返回 null */
function findEdgePath(): string | null {
  const bases = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LocalAppData,
  ].filter((b): b is string => !!b);
  for (const base of bases) {
    const exe = path.join(base, "Microsoft", "Edge", "Application", "msedge.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** 从 server/browser/extensions.json 读取要挂载的未打包插件目录（相对项目根解析，绝对路径也兼容） */
function extensionDirs(): string[] {
  let list: unknown;
  try {
    list = JSON.parse(fs.readFileSync(EXTENSIONS_FILE, "utf-8"));
  } catch {
    return []; // 不存在或 JSON 坏了都静默跳过——插件是可选能力，不该让浏览器起不来
  }
  return (Array.isArray(list) ? list : (list as { extensions?: unknown[] })?.extensions ?? [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => path.resolve(process.cwd(), d.trim()))
    .filter((d) => fs.existsSync(d));
}

/** 从 server/browser/extensions.json 读取要挂载的未打包插件目录（详见文件内注释） */
function extensionArgs(): string[] {
  const dirs = extensionDirs();
  if (!dirs.length) return [];
  return [`--disable-extensions-except=${dirs.join(",")}`, `--load-extension=${dirs.join(",")}`];
}

/**
 * 插件健康检查：开一个 edge://extensions 页调 developerPrivate API 拿权威清单，
 * 逐个核对 extensions.json 里配置的插件是否 ENABLED。
 *
 * 为什么需要它：MV3 service worker 惰性启动，CDP targets 里看不到插件；
 * 工具栏图标默认不固定；不查一下，「插件有没有加载」对用户完全是个黑盒。
 * 会短暂闪现一个扩展管理页标签（~2 秒），查完即关。
 */
/** 并发去重：健康检查同一时刻只跑一个，手动重跑与自动检查共用 */
function verifyExtensions(): Promise<void> {
  if (!session) return Promise.resolve();
  if (!extensionCheckPromise) {
    extensionCheckPromise = doVerifyExtensions().finally(() => {
      extensionCheckPromise = null;
    });
  }
  return extensionCheckPromise;
}

async function doVerifyExtensions(): Promise<void> {
  const context = session?.context;
  if (!context) return;
  extensionCheck = null;
  const page = await context.newPage().catch(() => null);
  if (!page) return;
  try {
    await page.goto("edge://extensions/", { timeout: 10_000 });
    // edge://extensions 的 WebUI 暴露 developerPrivate API，是插件清单的权威来源
    const info = (await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const api = (
            window as unknown as {
              chrome?: {
                developerPrivate?: {
                  getExtensionsInfo: (cb: (items: ExtensionInfoRaw[]) => void) => void;
                };
              };
            }
          ).chrome?.developerPrivate;
          if (!api) return reject(new Error("developerPrivate API 不可用"));
          api.getExtensionsInfo((items) => resolve(items));
        })
    )) as ExtensionInfoRaw[];
    const wanted = extensionDirs();
    const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
    const items = wanted.map((dir) => {
      const match = info.find(
        (it) => it.prettifiedPath && norm(it.prettifiedPath).includes(norm(dir))
      );
      return match
        ? { name: match.name, enabled: match.state === "ENABLED" }
        : { name: dir.split("\\").pop() ?? dir, enabled: false };
    });
    extensionCheck = { checkedAt: new Date().toISOString(), items };
    const failed = items.filter((it) => !it.enabled);
    if (failed.length) {
      console.warn(`[browser] 插件加载异常：${failed.map((it) => `${it.name} 未加载/未启用`).join("、")}`);
    } else {
      console.log(`[browser] 插件健康检查通过：${items.map((it) => it.name).join("、")}`);
    }
  } catch (error) {
    extensionCheck = { checkedAt: new Date().toISOString(), items: [], error: String(error).slice(0, 200) };
    console.warn("[browser] 插件健康检查失败（不影响浏览器使用）", error);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 找一个当前空闲的本地端口给 CDP 用（ listen(0) 由系统分配再释放） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 探测 CDP 端口是否就绪（Edge 主进程起来后调试端点才会监听） */
async function cdpAlive(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** CDP 端点未就绪时最多再等 15 秒（Edge 冷启动 + 插件加载） */
async function waitCdpReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive(port, 500)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Edge 启动超时：CDP 调试端口未就绪");
}

/**
 * 监听页面的主框架跳转，维护 currentUrl 供状态面板展示。
 * 每个页面挂一条 CDP 会话即可，WeakSet 防止重复 attach。
 */
function watchPage(page: Page): void {
  void page
    .context()
    .newCDPSession(page)
    .then((cdp) => {
      if (watched.has(cdp)) return;
      watched.add(cdp);
      cdp.on("Page.frameNavigated", (event: { frame: { parentId?: string; url?: string } }) => {
        if (!event.frame.parentId && event.frame.url) {
          currentUrl = event.frame.url;
        }
      });
    })
    .catch(() => undefined); // 页面可能瞬间关闭，监听失败无所谓
  watchSearchResponses(page);
}

/**
 * 拦截该页面发出的 Shopee 搜索结果响应，直接复用插件链路的 handleSearch
 * 入库（去重 + 打关键字标签）。手动在浏览器里滚动搜索页同样生效 ——
 * 采集不依赖自动化，也不依赖插件注入。
 */
function watchSearchResponses(page: Page): void {
  page.on("response", (resp: Response) => {
    if (!SEARCH_API_RE.test(resp.url())) return;
    const keyword = parseKeyword(resp.url(), page.url());
    void resp
      .json()
      .then((json) => {
        const result = handleSearch({ type: "search", keyword, url: page.url(), data: json });
        searchStats.lastKeyword = keyword || searchStats.lastKeyword;
        searchStats.lastAt = new Date().toISOString();
        if (!result.ok) {
          // items 为空 = 没有可入库内容。多半是风控限流（短时间内重复搜索），
          // 单独计数供采集流程感知，不计入有效批次
          searchStats.empty += 1;
          return;
        }
        searchStats.batches += 1;
        searchStats.received += result.total ?? 0;
        searchStats.added += result.added ?? 0;
        searchStats.skipped += result.skipped ?? 0;
        searchStats.tagged += result.tagged ?? 0;
      })
      .catch((error: unknown) => {
        // body 读取失败（204/重定向/连接中断）只计错不中断采集
        searchStats.errors += 1;
        console.warn("[browser/search] 响应读取失败:", String(error).slice(0, 150));
      });
  });
  watchRatingsResponses(page);
}

/**
 * 拦截该页面发出的评论与 PDP 详情响应：打开商品页（手动浏览或自动采集）
 * 都会自动截获入库 —— 评论追加写 JSONL 文件，DB 只存路径与条数。
 */
function watchRatingsResponses(page: Page): void {
  page.on("response", (resp: Response) => {
    const url = resp.url();
    if (RATINGS_API_RE.test(url)) {
      const u = new URL(url);
      const shopId = u.searchParams.get("shopid") ?? "";
      const itemId = u.searchParams.get("itemid") ?? "";
      if (!shopId || !itemId) return;
      void resp
        .json()
        .then((json) => {
          const r = handleRatings({ type: "ratings", shopId, itemId, data: json });
          if (r.ok && r.batch) {
            ratingStats.batches += 1;
            ratingStats.new += r.new ?? 0;
            ratingStats.total = r.total ?? ratingStats.total;
            ratingStats.lastItem = `${shopId}_${itemId}`;
            ratingStats.lastAt = new Date().toISOString();
            // 并发采集时同步登记到该商品的独立计数器（供 collectRatings 感知自己的进度）
            const counter = activeRatingCounters.get(counterKey(shopId, itemId));
            if (counter) {
              counter.batches += 1;
              counter.new += r.new ?? 0;
              counter.total = r.total ?? counter.total;
            }
          }
        })
        .catch((error: unknown) => {
          console.warn("[browser/ratings] 响应读取失败:", String(error).slice(0, 150));
        });
      return;
    }
    if (PDP_API_RE.test(url)) {
      // get_pc 的 query 里带 shop_id/item_id —— 并发时 PDP 产出也要按商品归属记账
      const pu = new URL(url);
      const pShop = pu.searchParams.get("shop_id") ?? pu.searchParams.get("shopid") ?? "";
      const pItem = pu.searchParams.get("item_id") ?? pu.searchParams.get("itemid") ?? "";
      void resp
        .json()
        .then((json) => {
          // shopId/itemId 必须显式传：API 直拉的 get_pc 响应体里 item 不带
          // shopid/itemid，不传的话详情文件会落成无主的 __pdp.json（踩过）
          const r = handlePdp({ type: "pdp", shopId: pShop, itemId: pItem, data: json });
          if (r.ok) {
            ratingStats.pdpSaved += 1;
            ratingStats.lastAt = new Date().toISOString();
            const counter = activeRatingCounters.get(counterKey(pShop, pItem));
            if (counter) {
              counter.pdpSaved += 1;
              // 零评论快跳：item.rating_count[0] 是评论总数（Shopee v4 get_pc
              // 标准结构）。明确为 0 时置位，让 collectRatings 跳过滚动+翻页
              // 整段流程；解析不到（字段缺失/结构变化）就不置位，行为不变。
              const it = (((json as { data?: unknown }).data ?? json) as Record<string, unknown>)
                .item as Record<string, unknown> | undefined;
              const rc = (it?.item_rating as { rating_count?: unknown[] } | undefined)?.rating_count;
              if (Array.isArray(rc) && rc[0] === 0) counter.zeroComment = true;
            }
          }
        })
        .catch(() => undefined);
    }
  });
}

/** 把上下文里所有页面（含之后新开的）纳入监控 */
function watchContext(context: BrowserContext): void {
  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);
}

async function connectToExisting(record: PortRecord): Promise<boolean> {
  if (!(await cdpAlive(record.port))) return false;
  let browser: Browser;
  try {
    // 探活通过不代表能连上 —— 半死实例（进程活着但 CDP 服务已坏）会在
    // connectOverCDP 上挂满超时。这里必须捕获后返回 false，交给启动兜底。
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${record.port}`, { timeout: 10_000 });
  } catch (error) {
    console.warn(`[browser] 接管旧实例失败（端口 ${record.port}）：`, String(error).slice(0, 120));
    return false;
  }
  const context = browser.contexts()[0];
  if (!context) {
    // 调试端点活着但没有任何上下文（理论上不会发生），按不可用处理
    await browser.close().catch(() => undefined);
    return false;
  }
  session = {
    browser, context, pid: null, port: record.port,
    driver: record.driver, bitWindowId: record.bitWindowId,
    startedAt: new Date().toISOString(),
    withToolkit: record.withToolkit === true,
  };
  watchContext(context);
  const pages = context.pages();
  currentUrl = pages[pages.length - 1]?.url() ?? "about:blank";
  console.log(`[browser] 已接管旧实例（${record.driver === "bit" ? "比特指纹窗口" : "Edge"}，CDP 端口 ${record.port}）`);
  return true;
}

/**
 * 杀掉占用采集 profile 的残留 Edge 主进程。场景：CDP 端口已坏但进程还活着
 * （半死实例）—— 它锁着 profile，不清场的话新 spawn 的实例会秒退。
 * 判据：命令行带本项目的 --user-data-dir 且无 --type（即主进程，子进程随之退出）。
 */
function killStaleProfileEdge(): void {
  try {
    const filter = PROFILE_DIR.replace(/'/g, "''");
    const ps =
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*--user-data-dir=${filter}*' -and $_.CommandLine -notmatch '--type=' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      timeout: 15_000,
      stdio: "ignore",
    });
    if (r.status !== 0) {
      console.warn("[browser] 清理残留 Edge 进程失败（status", r.status, "），继续尝试 spawn");
      return;
    }
    // 等句柄释放：profile 锁随进程退出立即解除，但留一点余量更稳
    sleepSync(1_500);
    console.log("[browser] 已清理占用 profile 的残留 Edge 进程");
  } catch (error) {
    console.warn("[browser] 清理残留 Edge 异常：", String(error).slice(0, 120));
  }
}

/** 同步 sleep（仅在 spawn 前清场的路径用，阻塞时间可控） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function spawnBrowser(initialUrl?: string, opts?: { extensionPaths?: string[] }): Promise<void> {  const edgePath = findEdgePath();
  if (!edgePath) {
    throw new Error("未找到系统 Edge（msedge.exe），请确认已安装 Microsoft Edge");
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const port = await freePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`, // 独立 profile：登录态持久化，且不干扰日常浏览器
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    ...extensionArgs(),
  ];
  // 附加挂载请求的本地扩展（与 extensions.json 的 --load-extension 合并成同一个参数）
  const extra = opts?.extensionPaths?.filter(Boolean) ?? [];
  const loadIdx = args.findIndex((a) => a.startsWith("--load-extension="));
  if (extra.length && loadIdx >= 0) args[loadIdx] = `${args[loadIdx]},${extra.join(",")}`;
  else if (extra.length) args.push(`--load-extension=${extra.join(",")}`);
  if (initialUrl) args.push(withScheme(initialUrl));

  // Edge 以独立窗口弹出，用户直接在真窗口里操作；stdio 丢弃（窗口应用无控制台输出）
  const child = spawn(edgePath, args, { stdio: "ignore" });

  await waitCdpReady(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Edge 已启动但未返回浏览器上下文");

  session = { browser, context, pid: child.pid ?? null, port, driver: "edge", startedAt: new Date().toISOString(), child, withToolkit: extra.length > 0 };
  watchContext(context);
  const pages = context.pages();
  currentUrl = pages[pages.length - 1]?.url() ?? initialUrl ?? "about:blank";
  writePortRecord({ port, driver: "edge", withToolkit: extra.length > 0 });

  // spawn 的进程退出有两种情况：① 窗口被用户关闭 → playwright disconnected
  // 会兜底清理；② 同 profile 已有实例被接管（spawn 秒退）→ 只丢 PID 记录
  child.on("exit", () => {
    if (!session || session.child !== child) return;
    session.pid = null;
    session.child = undefined;
  });
  browser.on("disconnected", () => {
    if (session?.browser !== browser) return;
    session = null;
    currentUrl = "about:blank";
    extensionCheck = null;
    console.log("[browser] Edge 已关闭（窗口被关闭或进程退出）");
  });

  console.log(`[browser] Edge 已弹出（PID ${child.pid}，CDP 端口 ${port}，profile: server/browser/profile）`);
}

/**
 * 比特路径：确保管理端在跑 → 打开指定指纹窗口 → connectOverCDP 接管。
 * 与 spawnBrowser 平行的一条启动路径，采集管线（watchContext 之后的
 * 一切）完全共用。CDP 端口同样落盘，dev server 重启后走 connectToExisting
 * 重新接管，不会重复开窗。
 */
async function startBitBrowser(initialUrl?: string, opts?: { extensionPaths?: string[] }): Promise<void> {
  const win = await ensureBitWindowOpen(opts);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${win.port}`, { timeout: 15_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("比特指纹窗口已打开但未返回浏览器上下文");

  const withToolkit = (opts?.extensionPaths?.filter(Boolean).length ?? 0) > 0;
  session = {
    browser, context, pid: null, port: win.port,
    driver: "bit", bitWindowId: win.windowId,
    startedAt: new Date().toISOString(),
    withToolkit,
  };
  watchContext(context);
  const pages = context.pages();
  currentUrl = pages[pages.length - 1]?.url() ?? initialUrl ?? "about:blank";
  writePortRecord({ port: win.port, driver: "bit", bitWindowId: win.windowId, withToolkit });

  browser.on("disconnected", () => {
    if (session?.browser !== browser) return;
    session = null;
    currentUrl = "about:blank";
    extensionCheck = null;
    console.log("[browser] 比特指纹窗口已关闭");
  });
  console.log(`[browser] 比特指纹窗口「${win.windowName}」已接管（CDP 端口 ${win.port}）`);
}

/** 确保浏览器在跑（并发调用共享同一个启动 Promise，避免重复拉起） */
export async function ensureBrowser(
  initialUrl?: string,
  opts?: { extensionPaths?: string[] },
): Promise<void> {
  const wantsExtension = (opts?.extensionPaths?.filter(Boolean).length ?? 0) > 0;
  if (session) {
    // 已在跑但没带请求的扩展 → 必须重启窗口（扩展无法热挂到运行中的实例）
    if (wantsExtension && !session.withToolkit) {
      console.log("[browser] 当前窗口未挂载请求的扩展，重启窗口使其生效");
      await closeBrowser();
      await sleep(1_500); // 给比特端/进程一点释放余量
    } else {
      return;
    }
  }
  if (starting) return starting;
  starting = (async () => {
    // ① 先按上次记录的端口探活接管（Edge/比特窗口通用），接管失败再真正拉起。
    //    接管来的实例带不带扩展以落盘记录为准（connectToExisting 已回填）
    const last = readPortRecord();
    if (last && (await connectToExisting(last))) {
      if (wantsExtension && !session?.withToolkit) {
        // 旧实例没挂扩展（上次不带 args 开的窗）→ 关掉按新参数重开
        console.log("[browser] 接管的旧实例未挂载请求的扩展，重启窗口使其生效");
        await closeBrowser();
        await sleep(1_500);
        await startPreferred(initialUrl, opts);
        return;
      }
      // 插件健康检查只对 Edge 有意义：比特指纹窗口的扩展由比特管理端配置，
      // extensions.json 的挂载与 developerPrivate 核对都不适用
      if (last.driver === "edge") void verifyExtensions();
      return;
    }
    await startPreferred(initialUrl, opts);
  })()
    .catch((error: unknown) => {
      session = null;
      throw error;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

/**
 * 主启动路径：比特指纹窗口优先，失败降级 Edge spawn（降级明确打日志）。
 * 半死实例（进程活着占着 profile 锁但 CDP 已坏）不清场的话新实例会秒退。
 */
async function startPreferred(initialUrl?: string, opts?: { extensionPaths?: string[] }): Promise<void> {
  try {
    await startBitBrowser(initialUrl, opts);
    return;
  } catch (error) {
    console.warn("[browser] 比特浏览器启动失败，回退 Edge：", String(error).slice(0, 200));
  }
  killStaleProfileEdge();
  await spawnBrowser(initialUrl, opts);
  void verifyExtensions();
}

export function getStatus(): BrowserStatus {
  if (!session) {
    return {
      running: false,
      pid: null,
      port: null,
      driver: null,
      startedAt: null,
      url: "about:blank",
      tabs: [],
      extensions: null,
      search: { ...searchStats },
      ratings: { ...ratingStats },
      ratingsBatch: getRatingsBatchState(),
    };
  }
  return {
    running: true,
    pid: session.pid,
    port: session.port,
    driver: session.driver,
    startedAt: session.startedAt,
    url: currentUrl,
    tabs: session.context.pages().map((p) => p.url()),
    extensions: extensionCheck,
    search: { ...searchStats },
    ratings: { ...ratingStats },
    ratingsBatch: getRatingsBatchState(),
  };
}

/** 手动重跑插件健康检查（前端「重新检查」按钮用） */
export function recheckExtensions(): Promise<void> {
  return verifyExtensions();
}

export function isRunning(): boolean {
  return session !== null;
}

/**
 * 在弹出窗口里打开一个 URL。
 * 策略：最后一个标签页还停在空白页就复用它，否则新开标签 —— 避免把用户
 * 正在看的页面顶掉，也避免空白标签堆积。
 */
export async function openUrl(url: string): Promise<BrowserStatus & { navError?: string }> {
  await ensureBrowser();
  const context = session!.context;
  const target = withScheme(url.trim());
  const pages = context.pages();
  const last = pages[pages.length - 1];
  // 复用空白/错误/新标签页，否则新开标签 —— 避免顶掉用户正在看的页面。
  // Edge 的新标签页是 edge://newtab（NTP），比特窗口内核是 Chromium，为 chrome://newtab
  const lastUrl = last?.url() ?? "";
  const reusable =
    last &&
    (lastUrl === "about:blank" ||
      lastUrl.startsWith("chrome-error://") ||
      lastUrl.startsWith("edge://newtab") ||
      lastUrl.startsWith("chrome://newtab") ||
      lastUrl.includes("ntp.msn"));
  const page = reusable ? last : await context.newPage();
  await page.bringToFront().catch(() => undefined);
  let navError: string | undefined;
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    // 导航失败（DNS/代理/超时）不能静默吞掉 —— 用户会以为打开了其实是错误页
    navError = String(error).replace(/^Error:\s*/, "").slice(0, 300);
  }
  currentUrl = page.url();
  return { ...getStatus(), navError };
}

/** 关闭浏览器：比特窗口走 API 关窗，Edge 先走 CDP 优雅退出（保存登录态），3 秒不退再强杀进程树 */
export async function closeBrowser(): Promise<void> {
  const current = session;
  if (!current) return;
  session = null;
  currentUrl = "about:blank";
  extensionCheck = null;
  if (current.driver === "bit" && current.bitWindowId) {
    // 比特窗口：API 关窗是唯一正道（管理端要回收窗口记录）。API 失败再
    // 用 CDP Browser.close 兜底 —— 窗口内核也是 Chromium，同样认这个指令
    const closed = await closeBitWindow(current.bitWindowId);
    if (!closed) {
      try {
        const cdp = await current.browser.newBrowserCDPSession();
        await cdp.send("Browser.close");
      } catch {
        // 连接已断说明窗口自己关了，无需处理
      }
    }
    await current.browser.close().catch(() => undefined); // 断开 playwright 连接
    console.log("[browser] 比特指纹窗口已关闭");
    return;
  }
  try {
    const cdp = await current.browser.newBrowserCDPSession();
    await cdp.send("Browser.close");
  } catch {
    // 连接已断说明浏览器自己关了，无需处理
  }
  const pid = current.pid;
  if (pid) {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      if (current.child) {
        current.child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      } else {
        // 接管的实例没有 child 句柄，靠轮询调试端口判断
        const poll = setInterval(() => {
          void cdpAlive(current.port, 300).then((alive) => {
            if (!alive) {
              clearInterval(poll);
              clearTimeout(timer);
              resolve(true);
            }
          });
        }, 300);
      }
    });
    if (!exited) {
      // Windows 下必须杀进程树，否则残留的渲染进程继续占内存
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  }
  await current.browser.close().catch(() => undefined); // 断开 playwright 连接
  console.log("[browser] Edge 已关闭");
}

/**
 * 供后续抓取模块使用：拿到托管浏览器的活动页面，所有自动化都在
 * 这个进程里执行（同一个 profile、同一套登录态、同一批插件）。
 * 浏览器未运行时抛错 —— 抓取不应顺手拉起一个用户看不见的窗口。
 */
export function getScrapingPage(): Page {
  if (!session) throw new Error("浏览器未运行，请先在「浏览器监控」页打开浏览器");
  const pages = session.context.pages();
  // 从后往前找第一个真实网页。坑：recheckExtensions 会在最后留一个
  // edge://extensions/ 标签，之前无脑取 pages[last]，翻页/滚动全打在
  // 扩展页上（那里的 evaluate 静默返回 no-btn），表现为「不翻页」。
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i];
    if (p && /^https?:/i.test(p.url())) return p;
  }
  throw new Error("浏览器没有打开的网页标签");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 在托管浏览器（比特优先，Edge 兜底）里开一个新标签并导航，返回该 Page。
 * 供 1688 链接自动采集这类「用完即关标签」的任务复用托管窗口 —— 调用方负责
 * page.close()，窗口本体不受影响。
 */
export async function openManagedTab(url: string, timeoutMs = 45_000): Promise<Page> {
  await ensureBrowser();
  if (!session) throw new Error("托管浏览器会话缺失");
  const page = await session.context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // CDP 接管的真实浏览器里，非前台标签的元素坐标/交互可能不稳定，
  // 自动点击按钮前必须把标签带到前台
  await page.bringToFront().catch(() => {});
  return page;
}

/**
 * 点击搜索结果底部的「下一页」按钮。
 * 实测 DOM（shopee-page-controller）：页码与箭头都是 <a>，不是 <button>；
 * 末页时右箭头带 shopee-icon-button--disabled。DOM click 不需要窗口在前台。
 */
async function clickNextPage(page: Page): Promise<boolean> {
  const clicked = await page
    .evaluate(() => {
      const btn = document.querySelector(
        "nav.shopee-page-controller .shopee-icon-button--right"
      ) as HTMLAnchorElement | null;
      if (!btn) return false;
      if (btn.classList.contains("shopee-icon-button--disabled") || btn.getAttribute("aria-disabled") === "true") {
        return false;
      }
      btn.click();
      return true;
    })
    .catch(() => false);
  return clicked === true;
}

export interface CollectSearchResult {
  keyword: string;
  screens: number;
  /** 本次采集窗口内新增的批次统计（相对采集开始时刻的差值） */
  stats: SearchStats;
  /** 导航失败时带出原因（页面打不开 = 没有数据可采） */
  navError?: string;
  /** true = 中途收到空响应（疑似 Shopee 风控限流），建议隔天/换关键字再试 */
  limited?: boolean;
}

/**
 * 搜索批量采集：打开关键字搜索页并限速滚动，响应由 watchSearchResponses
 * 自动截获入库。
 *
 * 限速设计（用户要求：避免被封号）：滚动一屏 = 页面自己发一批请求，
 * 频率完全由滚动节奏控制 —— 每屏之间随机等待 2.5~4.5 秒，加上首屏
 * 结果加载的固定等待，整体请求频率与人工浏览相当。
 */
export async function collectSearch(
  keyword: string,
  screens: number,
  /** 步骤回调：采集任务页用它把「正在干什么」实时写进任务表 */
  onStep?: (step: string) => void,
): Promise<CollectSearchResult> {
  await ensureBrowser();
  const start: SearchStats = { ...searchStats };
  // 2026-10-19 主阵地切 shopee.tw：xiapibuy 匿名通道被风控硬封，搜索任务同走
  // 台湾本地站（登录账号态，响应结构经探针验证与入库逻辑兼容）
  const url = `https://shopee.tw/search?keyword=${encodeURIComponent(keyword)}`;

  // 复用同关键字的搜索页（重复采集不堆积标签页），其余情况走 openUrl。
  // 只在真实网页里找 —— edge://extensions 等内部页排除在外
  const context = session!.context;
  const existing = context
    .pages()
    .filter((p) => /^https?:/i.test(p.url()))
    .find((p) => decodeURIComponent(p.url()).includes(`keyword=${keyword}`));
  let navError: string | undefined;
  if (existing) {
    // 不能 reload：旧标签页 URL 可能停在上一轮翻到的 &page=N（甚至被软封顶的深页），
    // reload 会原样重放该页，首批请求直接从第 N 页开始、还可能拿到空批次。
    // 必须 goto 干净的第 1 页 URL，把 page 参数剥掉。
    await existing.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((error: unknown) => {
      navError = String(error).slice(0, 300);
    });
  } else {
    const opened = await openUrl(url);
    navError = opened.navError;
  }
  if (navError) return { keyword, screens, stats: deltaStats(start), navError };
  onStep?.("等待首批搜索结果");

  // 明确定位搜索页：不能依赖「最后一个标签」（扩展检查页可能插在后面）
  const page =
    context.pages().find((p) => decodeURIComponent(p.url()).includes(`keyword=${keyword}`)) ??
    getScrapingPage();
  // 等首批响应落地（不猜固定秒数 —— 冷启动/风控挑战时首批可能明显变慢）。
  // 验证码期间不会有任何响应：发现页面被劫持到 /verify/captcha 就等人工过滑块，
  // 过了 Shopee 会重定向回搜索页并重发首批，再重开一轮等待窗口。
  // 窗口放宽到 60s：实测首批最慢约 66s（21:11:07 建任务 → 21:12:08 首批落地），
  // 之前 20s 窗口会在空页上误判「末页」提前退出。
  let firstDeadline = Date.now() + 60_000;
  for (;;) {
    if (page.url().includes("/verify/")) {
      onStep?.("等待人工过验证码（3 分钟）");
      const solved = await waitForCaptchaSolved(page, 180_000);
      if (!solved) {
        return { keyword, screens, stats: deltaStats(start), navError: "验证码 3 分钟内未通过，采集中止" };
      }
      onStep?.("验证已通过，等待首批搜索结果");
      firstDeadline = Date.now() + 25_000;
      continue;
    }
    if (searchStats.batches !== start.batches || Date.now() > firstDeadline) break;
    await sleep(500);
  }
  let limited = false;
  // screens <= 0 = 不限屏数，一直翻到末页自然停止。安全上限 60
  // （Shopee 搜索最多约 60 页，防翻页控件异常时无限循环）。
  const maxScreens = screens > 0 ? screens : 60;
  let captchaHits = 0;
  for (let i = 0; i < maxScreens; i++) {
    // 验证码可能在翻页间隙随时弹出 —— 每轮开始检测一次。有就等人工过滑块，
    // 过了不消耗本轮屏数（i-- 重翻）；反复弹超 5 次判定风控锁定，中止。
    if (page.url().includes("/verify/")) {
      captchaHits += 1;
      if (captchaHits > 5) {
        return { keyword, screens, stats: deltaStats(start), limited: true, navError: "验证码反复出现，疑似风控锁定，采集中止" };
      }
      onStep?.("等待人工过验证码（3 分钟）");
      const solved = await waitForCaptchaSolved(page, 180_000);
      if (!solved) {
        return { keyword, screens, stats: deltaStats(start), limited: true, navError: "验证码 3 分钟内未通过，采集中止" };
      }
      onStep?.("验证已通过，继续翻页采集");
      i -= 1;
      continue;
    }
    const batchesBefore = searchStats.batches;
    const emptyBefore = searchStats.empty;
    onStep?.(
      `搜索翻页（第 ${i + 1} 页${screens > 0 ? `/${screens}` : " · 不限"}）· 已入库 ${searchStats.added - start.added} 个商品`,
    );
    // 翻页：xiapi 桌面版搜索页是底部数字翻页（不是无限滚动），滚到底也不会发新请求。
    // 翻页控件懒渲染且时机不定 —— 首批结果刚落地时控件往往还没挂出来，
    // 找不到按钮先重试几轮（滚动+等待），全部失败才认定末页。
    let hasNext = false;
    for (let retry = 0; retry < 4; retry++) {
      await page
        .evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        .catch(() => undefined);
      hasNext = await clickNextPage(page);
      if (hasNext) break;
      await sleep(1_200);
    }
    if (!hasNext) break; // 重试后仍无下一页（结果只有一页/已到末页）
    // 等响应落地（有效批次或空批次都算「有响应」），最多 20 秒
    const deadline = Date.now() + 20_000;
    let got = false;
    while (Date.now() < deadline) {
      await sleep(500);
      if (searchStats.batches > batchesBefore || searchStats.empty > emptyBefore) {
        got = true;
        break;
      }
    }
    // 随机化间隔（2~4 秒），保持与人工浏览相当的翻页节奏
    await sleep(2_000 + Math.random() * 2_000);
    if (!got) {
      // 翻页后一直没响应：多数是末页/网络问题；但验证码劫持同样会无响应，
      // 先看一眼页面 —— 被劫持就等人工过滑块，过了本轮重试（i-- 不消耗屏数）
      if (page.url().includes("/verify/")) {
        captchaHits += 1;
        if (captchaHits > 5) {
          return { keyword, screens, stats: deltaStats(start), limited: true, navError: "验证码反复出现，疑似风控锁定，采集中止" };
        }
        onStep?.("等待人工过验证码（3 分钟）");
        const solved = await waitForCaptchaSolved(page, 180_000);
        if (!solved) {
          return { keyword, screens, stats: deltaStats(start), limited: true, navError: "验证码 3 分钟内未通过，采集中止" };
        }
        onStep?.("验证已通过，继续翻页采集");
        i -= 1;
        continue;
      }
      break; // 真没响应（末页/网络问题），不再空转
    }
    if (searchStats.batches === batchesBefore) {
      // 响应落地但没有商品 = 风控限流信号。立即停止，避免继续请求加重风控
      limited = true;
      console.warn(`[browser/search] 关键字「${keyword}」收到空响应，疑似被限流，提前终止采集`);
      break;
    }
  }
  await sleep(3_000); // 收尾：让最后一批响应有时间落地
  return { keyword, screens, stats: deltaStats(start), limited };
}

/** 采集窗口内的统计差值（SearchStats 是累计值，接口返回本次增量更好读） */
function deltaStats(start: SearchStats): SearchStats {
  return {
    batches: searchStats.batches - start.batches,
    received: searchStats.received - start.received,
    added: searchStats.added - start.added,
    skipped: searchStats.skipped - start.skipped,
    tagged: searchStats.tagged - start.tagged,
    errors: searchStats.errors - start.errors,
    empty: searchStats.empty - start.empty,
    lastKeyword: searchStats.lastKeyword,
    lastAt: searchStats.lastAt,
  };
}

/**
 * 点击评论区的「查看更多評論」按钮 / 评论区翻页下一页箭头。
 * 评论区与商品主区的翻页控件都叫 shopee-page-controller，取 DOM 里
 * 最后一个（评论区在页面底部）；文本按钮做第一优先候选。
 */
function clickMoreRatings(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const more = buttons.find((b) => /查看更多|更多評論|更多评论/.test(b.textContent ?? ""));
      if (more && !more.disabled) {
        more.click();
        return "text-btn";
      }
      const controllers = document.querySelectorAll("nav.shopee-page-controller");
      if (controllers.length) {
        const nav = controllers[controllers.length - 1];
        const right = nav.querySelector(".shopee-icon-button--right") as HTMLElement | null;
        if (right && !right.classList.contains("shopee-icon-button--disabled")) {
          right.click();
          return "pager";
        }
      }
      return "none";
    })
    .then((r) => r !== "none")
    .catch(() => false);
}

export interface CollectRatingsResult {
  shopId: string;
  itemId: string;
  pages: number;
  /** 本次窗口内的评论批次/新增/文件累计统计 */
  stats: RatingStats;
  navError?: string;
  /** true = 评论翻到尽头（无更多按钮）或多次翻页无新响应 */
  exhausted?: boolean;
}

/**
 * 评论批量采集：打开商品页 → 滚到评论区 → 循环点「更多评论」直到翻尽。
 * 响应由 watchRatingsResponses 自动截获：评论追加写
 * data/reviews/{shop}_{item}.jsonl，DB 只存文件路径与条数。
 * 限速：每页之间随机 2~4 秒（与搜索采集同一套节奏）。
 */
export async function collectRatings(
  shopId: string,
  itemId: string,
  maxPages: number,
  /** 步骤回调：批量任务用它把「正在干什么」实时写进任务表 */
  onStep?: (step: string) => void,
  /** 并发跑批时传入 worker 自己的页（由 worker 负责开合）；缺省走单发模式 */
  opts?: { page?: Page },
): Promise<CollectRatingsResult> {
  await ensureBrowser();
  // per-item 计数：并发下全局 ratingStats 的 delta 会互相污染（A 的首批响应
  // 会让 B 误判已落地、A 的评论数记到 B 头上），必须按商品归属记账。
  const key = counterKey(shopId, itemId);
  const counter: ItemRatingCounter = { batches: 0, new: 0, total: 0, pdpSaved: 0 };
  activeRatingCounters.set(key, counter);
  const statsNow = (): RatingStats => ({
    batches: counter.batches,
    new: counter.new,
    total: counter.total,
    pdpSaved: counter.pdpSaved,
    lastItem: `${shopId}_${itemId}`,
    lastAt: ratingStats.lastAt,
  });
  try {
    // 主路径：API 直拉（免签名已验证，不用 goto 商品页）。403 是偶发风控抖动
    // （探针实锤：重试一次即 200），在 ViaApi 内部退避重试；重试耗尽仍失败才
    // 回退旧的「goto PDP + 滚动 + 点击」路径，最坏情况等于旧行为。
    let page: Page;
    try {
      page = opts?.page ?? getScrapingPage();
    } catch {
      // 无可用标签（浏览器刚拉起/全被关）：开一个 Shopee 页做 API 同源上下文
      const opened = await openUrl("https://shopee.tw/");
      if (opened.navError) {
        return {
          shopId, itemId, pages: 0,
          stats: { batches: 0, new: 0, total: 0, pdpSaved: 0, lastItem: `${shopId}_${itemId}`, lastAt: null },
          navError: opened.navError,
        };
      }
      page = getScrapingPage();
    }
    const apiR = await collectRatingsViaApi(page, shopId, itemId, maxPages, onStep, counter, statsNow);
    if (!apiR.navError) return apiR;
    onStep?.(`API 直拉受阻（${apiR.navError.slice(0, 40)}），回退页面采集`);
    return await collectRatingsInner(shopId, itemId, maxPages, onStep, opts?.page, counter);
  } finally {
    activeRatingCounters.delete(key);
  }
}

/**
 * API 直拉采评论：在 xiapibuy.com 同源页上下文里循环 fetch get_ratings。
 * 相比页面采集（goto PDP + 滚动渲染 + 点击翻页）砍掉了全部渲染等待，
 * 单商品只剩接口耗时（~0.5-4s/页）。数据复用 handleRatings 入库（jsonl 去重追加）。
 * 403 按偶发风控抖动处理：退避重试 3 次，仍失败返回 navError 由调用方回退。
 */
async function collectRatingsViaApi(
  page: Page,
  shopId: string,
  itemId: string,
  maxPages: number,
  onStep: ((step: string) => void) | undefined,
  counter: ItemRatingCounter,
  statsNow: () => RatingStats,
): Promise<CollectRatingsResult> {
  // 只要求同源（xiapibuy / shopee.tw 域内任何页面都行，商品页/首页皆可），不在域内才导航。
  // 2026-10-19 起主阵地切到 shopee.tw（台湾本地站 + 登录买家账号，xiapibuy 匿名通道被风控硬封）
  if (!/xiapibuy\.com|shopee\.tw/i.test(page.url())) {
    onStep?.("打开 Shopee 页面");
    try {
      await page.goto("https://shopee.tw/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      return { shopId, itemId, pages: 0, stats: statsNow(), navError: String(error).slice(0, 300) };
    }
  }
  if (page.url().includes("/verify/")) {
    // 会话级风控已把当前页劫持到验证页，直接回退旧路径（那边有等待+重试逻辑）
    return { shopId, itemId, pages: 0, stats: statsNow(), navError: "触发了 Shopee 风控验证码" };
  }

  // 商品详情直拉：没有详情文件的商品拉一次 get_pc，保住「商品+评论一起采」。
  // 探针实锤极简参数即可（item_id/shop_id/detail_level），无需打开商品页。
  // 入库不在这里调 —— page.evaluate 的 fetch 是真实网络请求，watchPage 拦截器
  // 会自动接住同一个响应做 handlePdp 落盘+入账（直调+拦截会重复入库，踩过）。
  // 详情失败不致命 —— 只记日志，评论照采。
  // shopee.tw 域内 get_pc 被 90309999 风控信封持续拒绝（2026-10-19 探针实锤），
  // 而评论总数可从 get_ratings 的 item_rating_summary 拿到 —— tw 域直接跳过
  // get_pc，避免反复触发风控；详情后续靠插件/PDP 浏览补。
  if (!/shopee\.tw/i.test(page.url()) && !hasPdpFile(shopId, itemId)) {
    onStep?.("API 直拉商品详情");
    type PcOutcome = { status: number; body: unknown; evalError?: string };
    const pc: PcOutcome = await page
      .evaluate(async (arg) => {
        const q = new URLSearchParams({
          item_id: arg.itemId, shop_id: arg.shopId, detail_level: "0",
        });
        const resp = await fetch(`/api/v4/pdp/get_pc?${q}`, {
          credentials: "include", signal: AbortSignal.timeout(12_000),
        });
        let body: unknown = null;
        try { body = await resp.json(); } catch { /* 非 JSON（拦截器自己会再读一次） */ }
        return { status: resp.status, body };
      }, { shopId, itemId })
      .catch((error: unknown): PcOutcome => ({ status: 0, body: null, evalError: String(error).slice(0, 200) }));
    if (pc.status !== 200) {
      console.warn(
        `[browser/ratings] get_pc 直拉失败 ${shopId}_${itemId}:`,
        pc.evalError ?? `HTTP ${pc.status}`,
      );
    }
    // 给拦截器一点落地时间（resp.json() 异步），详情文件马上要被 hasPdpFile 之外
    // 的逻辑（任务明细 pdpSaved）感知；不影响主流程，失败场景也不阻塞
    await sleep(800);
  }

  let offset = 0;
  let pages = 0;
  for (let i = 0; i < maxPages; i++) {
    onStep?.(i === 0 ? "API 直拉评论" : `API 翻页（第 ${i + 1} 页）`);
    // 403 退避重试：2s → 4s → 6s（探针实锤重试一次即恢复）
    let json: { data?: Record<string, unknown> } | null = null;
    let httpError: string | undefined;
    type FetchOutcome = {
      status: number;
      body: { data?: Record<string, unknown>; error?: unknown } | null;
      err: unknown;
      evalError?: string;
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r: FetchOutcome = await page
        .evaluate(async (arg) => {
          const q = new URLSearchParams({
            filter: "0", flag: "1", itemid: arg.itemId, limit: "6",
            offset: String(arg.offset), shopid: arg.shopId, type: "0",
          });
          const resp = await fetch(`/api/v2/item/get_ratings?${q}`, {
            credentials: "include",
            signal: AbortSignal.timeout(12_000),
          });
          let body: { data?: Record<string, unknown>; error?: unknown } | null = null;
          try { body = await resp.json(); } catch { /* 非 JSON */ }
          return { status: resp.status, body, err: body?.error ?? 0 };
        }, { shopId, itemId, offset })
        .catch((error: unknown): FetchOutcome => ({ status: 0, body: null, err: 0, evalError: String(error).slice(0, 200) }));
      if (r.status === 200 && r.body) {
        json = r.body as { data?: Record<string, unknown> };
        httpError = undefined;
        break;
      }
      httpError = r.evalError
        ? `请求异常 ${r.evalError}`
        : `HTTP ${r.status}${r.err ? ` err=${r.err}` : ""}`;
      if (attempt < 3) await sleep(attempt * 2_000);
    }
    if (httpError) {
      return { shopId, itemId, pages, stats: statsNow(), navError: `API 直拉失败：${httpError}` };
    }
    const node = (json!.data ?? json!) as Record<string, unknown>;
    const ratings = (node.ratings as unknown[] | undefined) ?? [];
    // 评论总数：xiapibuy 用 data.count，shopee.tw 用 item_rating_summary.rating_total
    //（2026-10-19 探针：tw 域响应结构不同，零评论商品连 ratings 数组都没有）
    const summary = node.item_rating_summary as { rating_total?: unknown } | undefined;
    const totalCount =
      typeof node.count === "number" ? node.count
      : typeof summary?.rating_total === "number" ? summary.rating_total
      : null;
    // 入库同样交给 watchPage 拦截器（去重+review_file+counter 累加全自动），
    // 这里只读响应做判定：零评论 / 尽头。
    if (i === 0 && (totalCount === 0 || (ratings.length === 0 && node.has_more === false))) {
      // 明确零评论：补标记让商品永久离开待采队列（拦截器对空数组不落盘）
      markNoReviews(shopId, itemId);
      onStep?.("无评论，跳过");
      return { shopId, itemId, pages: 0, stats: statsNow(), exhausted: true };
    }
    pages += 1;
    offset += ratings.length || 6;
    // 尽头判定：has_more 明确为 false，或本页没返回数据
    if (node.has_more === false || ratings.length === 0) break;
    // 接口间小停顿：低频模式 2~4s 随机（shopee.tw 登录账号采集，宁慢勿封；
    // 原 400-900ms 的匀速快节奏正是昨天触发风控的主因之一）
    await sleep(2_000 + Math.random() * 2_000);
  }
  // 收尾等拦截器把最后一批响应的 jsonl 落盘 + counter 累加做完，保证
  // 返回的 stats（任务明细 reviews/pdpSaved）不含漏记
  await sleep(1_500);
  return { shopId, itemId, pages, stats: statsNow(), exhausted: true };
}

/** collectRatings 的实体（计数器已就位）。单发/worker 两种页面来源。 */
async function collectRatingsInner(
  shopId: string,
  itemId: string,
  maxPages: number,
  onStep: ((step: string) => void) | undefined,
  workerPage: Page | undefined,
  counter: ItemRatingCounter,
): Promise<CollectRatingsResult> {
  const statsNow = (): RatingStats => ({
    batches: counter.batches,
    new: counter.new,
    total: counter.total,
    pdpSaved: counter.pdpSaved,
    lastItem: `${shopId}_${itemId}`,
    lastAt: ratingStats.lastAt,
  });
  const url = `https://shopee.tw/product/${shopId}/${itemId}`;
  // 目标商品已在当前标签 → 跳过 goto。URL 有两种形式：
  // /product/{shop}/{item}（程序打开）与 【商品名】-i.{shop}.{item}（站内跳转/验证后重定向）。
  // 短时间反复 goto 同一商品页是风控的主要触发源，能省一次访问就省一次。
  const onTargetRe = new RegExp(`(?:/product/${shopId}/${itemId}|-i\\.${shopId}\\.${itemId})`);
  let page: Page;
  if (workerPage) {
    // worker 模式：页由 worker 持有复用（下一个商品直接 goto 覆盖），这里绝不 close
    page = workerPage;
    if (!onTargetRe.test(page.url())) {
      onStep?.("打开商品页");
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (error) {
        return { shopId, itemId, pages: 0, stats: statsNow(), navError: String(error).slice(0, 300) };
      }
    }
  } else {
    // 单发模式：沿用 openUrl（复用空白标签，否则新开）
    page = getScrapingPage();
    if (!onTargetRe.test(page.url())) {
      onStep?.("打开商品页");
      const opened = await openUrl(url);
      if (opened.navError) {
        return { shopId, itemId, pages: 0, stats: statsNow(), navError: opened.navError };
      }
      page = getScrapingPage();
    }
  }
  // Shopee 风控：频繁自动访问会把商品页重定向到 /verify/captcha（scene=crawler_item），
  // 流量异常时落到 /verify/traffic/error。两类都只能人工处理 —— 等用户在弹出的
  // Edge 窗口里完成滑块/刷新恢复，URL 离开 /verify/ 才继续；超时未过则明确报错返回，
  // 绝不假装采集成功（之前只认 captcha，traffic/error 页会被误当商品页白滚 30s）。
  const CAPTCHA_HINT = "/verify/";
  if (page.url().includes(CAPTCHA_HINT)) {
    onStep?.("等待人工过验证码");
    const solveDeadline = Date.now() + 120_000;
    while (Date.now() < solveDeadline && page.url().includes(CAPTCHA_HINT)) {
      await sleep(2_000);
    }
    if (page.url().includes(CAPTCHA_HINT)) {
      return {
        shopId,
        itemId,
        pages: 0,
        stats: statsNow(),
        navError: "触发了 Shopee 风控验证码且 2 分钟内未完成 —— 请在浏览器窗口手动过验证后重试，或稍后再采（短时间反复访问同一商品页容易触发）",
      };
    }
  }
  // PDP 是渐进渲染的：刚打开时 scrollHeight 往往只有几百像素（空壳），
  // get_pc 数据落地 + 主内容渲染要 10 秒上下（慢机更久）。单次 scrollTo
  // 会停在半空、评论区永远进不了视口。策略：
  // 「滚到底 → 等 → 再滚」循环，直到首批评论响应落地；
  // 退出条件三选一：① 首批响应已落地；② 高度连续 3 轮不变且页面充分渲染（>6000px）；
  // ③ 高度连续 6 轮不变（≈11s）—— 评论很少/没有的商品页面天然矮，永远到不了
  // 6000px，之前会白等满 30s 超时，这是「评论少的商品也慢」的主因。
  const firstDeadline = Date.now() + 30_000;
  onStep?.("滚动加载评论区");
  let lastHeight = -1;
  let stableRounds = 0;
  while (Date.now() < firstDeadline && counter.batches === 0) {
    // 零评论快跳：PDP 响应落地后若明确告知 0 评论，评论区根本不存在，
    // 滚动注定空转——立即退出（PDP 响应晚于 goto，所以循环内逐轮检查）
    if (counter.zeroComment) break;
    // 滚动中途被风控劫持到验证码页 → 立即中止，明确告知用户
    if (page.url().includes(CAPTCHA_HINT)) {
      return {
        shopId,
        itemId,
        pages: 0,
        stats: statsNow(),
        navError: "采集中途被重定向到 Shopee 风控验证码 —— 请在浏览器窗口完成验证后重试（验证通过会自动回到商品页，重试会跳过导航直接续采）",
      };
    }
    await page
      .evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      .catch(() => undefined);
    await sleep(1_800);
    const height = await page
      .evaluate(() => document.documentElement.scrollHeight)
      .catch(() => 0);
    stableRounds = height === lastHeight ? stableRounds + 1 : 0;
    lastHeight = height;
    if (stableRounds >= 3 && height > 6_000) break;
    if (stableRounds >= 6) break;
  }

  // 首批评论等待只负责「把评论区渲染出来、让翻页按钮存在」。
  // 续采场景（页面已加载、评论已全部渲染）不会有新请求，等不到首批是正常现象，
  // 不能据此判死 —— 尽头判定统一交给下面的点击循环（无按钮 / 点击无响应）。
  // 零评论商品没有「更多评论」按钮可点，直接收尾，省掉一次注定失败的点击。
  if (counter.zeroComment) {
    onStep?.("无评论，跳过");
    await sleep(1_000);
    return { shopId, itemId, pages: 0, stats: statsNow(), exhausted: true };
  }
  let exhausted = false;
  let pages = 0;
  for (let i = 0; i < maxPages && !exhausted; i++) {
    onStep?.(`翻页采评论（第 ${i + 1} 页）`);
    const batchesBefore = counter.batches;
    const clicked = await clickMoreRatings(page);
    if (!clicked) {
      exhausted = true; // 没有更多评论按钮 = 翻到尽头
      break;
    }
    // 等响应落地，最多 10 秒（评论分页通常比搜索快）
    const deadline = Date.now() + 10_000;
    let got = false;
    while (Date.now() < deadline) {
      await sleep(500);
      if (counter.batches > batchesBefore) {
        got = true;
        break;
      }
    }
    await sleep(1_500 + Math.random() * 1_500);
    if (!got) {
      exhausted = true; // 点击了但一直没响应，按尽头处理
      break;
    }
    pages += 1;
  }
  await sleep(500); // 收尾缓冲（原来 2s，批量下纯属浪费）
  return { shopId, itemId, pages, stats: statsNow(), exhausted };
}

/** 批量评论采集的进度状态（单任务状态机：同一时刻只允许一个批量在跑） */
export interface RatingsBatchState {
  running: boolean;
  /** 对应 collect_tasks.id，明细可查 GET /api/browser/tasks/:id */
  taskId: number | null;
  /** 过滤标签（搜索关键字）；null = 全部待采商品 */
  tag: string | null;
  /** 本批计划采集的商品数 */
  total: number;
  /** 已处理完的商品数（含失败） */
  done: number;
  success: number;
  failed: number;
  /** 本任务累计新增评论文数 */
  reviews: number;
  /** 正在处理的商品（shop_item + 名称截断），给前端展示进度用 */
  currentItem: string | null;
  /** 当前步骤（打开页面 / 滚动加载 / 翻页采评论第 n 页…） */
  currentStep: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 命中 Shopee 风控验证码，正等待人工过滑块 */
  waitingCaptcha: boolean;
  /** 最近的失败原因（新在前，最多留 20 条） */
  errors: string[];
  /** 用户请求停止：跑完当前商品后退出，不硬中断 */
  abort: boolean;
}

const ratingsBatch: RatingsBatchState = {
  running: false,
  taskId: null,
  tag: null,
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  reviews: 0,
  currentItem: null,
  currentStep: null,
  startedAt: null,
  finishedAt: null,
  waitingCaptcha: false,
  errors: [],
  abort: false,
};

export function getRatingsBatchState(): RatingsBatchState {
  return { ...ratingsBatch, errors: [...ratingsBatch.errors] };
}

/**
 * 等用户在弹出的 Edge 窗口里过掉风控页（验证码滑块 / 流量异常）：每 3 秒看一眼
 * 指定页的 URL，离开 /verify/ 即算通过。并发跑批时每个 worker 检查自己的页 ——
 * 全局 getScrapingPage 在多标签下会拿错页。页面没了（浏览器被关）视为未通过。
 */
async function waitForCaptchaSolved(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3_000);
    try {
      if (!page.url().includes("/verify/")) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 启动批量评论采集：按标签（可选）捞出还没采过评论的商品快照，
 * 逐个走 collectRatings（PDP 详情在同一窗口顺带截获入库，等于
 * 「商品信息 + 评论」一起采）。任务与进度持久化到 collect_tasks 表，
 * server 重启后历史仍可查。断点续采天然成立 —— review_file 已存在的
 * 商品不会进快照。
 */
export function startRatingsBatch(
  tag: string | undefined,
  limit: number,
  maxPagesPerItem: number,
  concurrency = 2,
): { started: boolean; taskId?: number; message: string } {
  if (anyBatchRunning()) {
    return { started: false, message: "已有采集任务在跑（搜索或评论批量），请先等它结束或点停止" };
  }
  const items = listPendingRatings(tag, limit);
  if (!items.length) {
    return { started: false, message: "没有待采评论的商品（所有商品都已有 review_file）" };
  }
  const taskId = createCollectTask("ratings", tag, maxPagesPerItem, items);
  Object.assign(ratingsBatch, {
    running: true,
    taskId,
    tag: tag ?? null,
    total: items.length,
    done: 0,
    success: 0,
    failed: 0,
    reviews: 0,
    currentItem: null,
    currentStep: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    waitingCaptcha: false,
    errors: [],
    abort: false,
  });
  void runRatingsBatch(taskId, items, maxPagesPerItem, { concurrency });
  return { started: true, taskId, message: `批量采集任务 #${taskId} 已启动，共 ${items.length} 个商品` };
}

/**
 * 在原任务上重试失败的评论商品（不新建任务）：failed/僵死 running 明细重置回
 * pending，任务行清终态复活，进度从明细表重算，然后只把待采商品入队续跑。
 * 已在其他跑批补采到评论的商品自动标 done 跳过，绝不重复采集。
 */
export function startRatingsRetry(
  sourceTaskId: number,
  maxPagesPerItem: number,
  concurrency = 2,
): { started: boolean; taskId?: number; message: string } {
  if (anyBatchRunning()) {
    return { started: false, message: "已有采集任务在跑（搜索或评论批量），请先等它结束或点停止" };
  }
  const tasks = listCollectTasks(200).filter((t) => t.id === sourceTaskId);
  if (!tasks.length) {
    return { started: false, message: `任务 #${sourceTaskId} 不存在` };
  }
  const task = tasks[0];
  // DB 里的 running 可能是 server 重启/崩溃留下的僵死状态（内存已无批量在跑），
  // 这种情况要允许恢复；真正在跑时才拒绝
  if (task.status === "running" && anyBatchRunning()) {
    return { started: false, message: `任务 #${sourceTaskId} 还在进行中，无需重试` };
  }
  const reset = resetFailedTaskItems(sourceTaskId);
  const items = listTaskItemsByStatus(sourceTaskId, "pending");
  if (!items.length) {
    return { started: false, message: `任务 #${sourceTaskId} 没有失败的商品，无需重试` };
  }
  const stats = getTaskItemStats(sourceTaskId);
  const isSearch = task.kind === "search";
  reviveCollectTask(sourceTaskId);
  // 任务行进度按明细表重算：done=已采成/已补采，failed 清零（重置过了），
  // 搜索任务的 success/failed 是「新增/跳过」口径，保持原值不动
  updateCollectTaskProgress(sourceTaskId, {
    total: stats.total,
    done: stats.done,
    success: isSearch ? undefined : stats.done,
    failed: isSearch ? undefined : 0,
    reviews: stats.reviews,
    currentStep: "重试排队中",
    currentItem: null,
  });
  Object.assign(ratingsBatch, {
    running: true,
    taskId: sourceTaskId,
    tag: task.tag,
    total: stats.total,
    done: stats.done,
    success: isSearch ? 0 : stats.done,
    failed: 0,
    reviews: stats.reviews,
    currentItem: null,
    currentStep: "重试排队中",
    startedAt: task.createdAt ?? new Date().toISOString(),
    finishedAt: null,
    waitingCaptcha: false,
    errors: [],
    abort: false,
  });
  void runRatingsBatch(sourceTaskId, items, maxPagesPerItem, {
    base: { done: stats.done, success: isSearch ? 0 : stats.done, failed: 0, reviews: stats.reviews },
    preserveSearchCounters: isSearch,
    concurrency,
  });
  const skipNote = reset.recovered > 0 ? `（${reset.recovered} 个已在其他跑批补采，自动跳过）` : "";
  return {
    started: true,
    taskId: sourceTaskId,
    message: `任务 #${sourceTaskId} 已恢复采集：${items.length} 个失败商品重新入队${skipNote}`,
  };
}

/** 请求停止批量：不硬中断，跑完当前商品/当前屏后退出 */
export function stopRatingsBatch(): void {
  // 搜索与评论批量共用一个浏览器页，停止指令对两者都生效
  if (ratingsBatch.running) ratingsBatch.abort = true;
  if (searchTask.running) searchTask.abort = true;
}

/**
 * 停止指定任务（单任务粒度）：批量互斥，同一时刻至多一个任务在跑，
 * 按 taskId 匹配到对应的内存状态后置 abort；不匹配说明该任务没在跑。
 */
export function stopCollectTask(taskId: number): { stopped: boolean; message: string } {
  if (ratingsBatch.running && ratingsBatch.taskId === taskId) {
    ratingsBatch.abort = true;
    return { stopped: true, message: `任务 #${taskId} 已发送停止指令，跑完当前商品后退出` };
  }
  if (searchTask.running && searchTask.taskId === taskId) {
    searchTask.abort = true;
    return { stopped: true, message: `任务 #${taskId} 已发送停止指令，跑完当前步骤后退出` };
  }
  return { stopped: false, message: `任务 #${taskId} 不在运行中，无需停止` };
}

/** 评论采集阶段的进度快照（写内存状态 + 落库由调用方的 persist 决定口径） */
interface RatingsProgress {
  done: number;
  success: number;
  failed: number;
  reviews: number;
  currentItem: string | null;
  currentStep: string | null;
}

/**
 * 评论采集执行体：逐个商品跑 collectRatings（验证码等一次人工、商品间限速），
 * 进度通过 persist 回调写内存状态与任务行，明细行直接落 collect_task_items。
 * 独立评论批量任务与搜索任务的第二阶段共用 —— 两者只差进度口径与中止来源。
 * 注意：调用前明细行必须已在表里（updateCollectTaskItem 是纯 UPDATE）。
 */
/** 历史遗留常量：低频模式（2026-10-19）后并发强制为 1，此常量仅保留参数兼容，
 *  不再参与 worker 数计算。恢复并发的决策依据：shopee.tw 登录账号能否承受 2 worker
 *  的节奏 —— 在账号没被风控盯上前不要开 */
const RATINGS_CONCURRENCY = 2;

async function runRatingsItems(
  taskId: number,
  items: { shopId: string; itemId: string; name: string }[],
  maxPagesPerItem: number,
  opts: {
    isAborted: () => boolean;
    persist: (p: RatingsProgress) => void;
    setWaitingCaptcha?: (v: boolean) => void;
    errors: string[];
    /** 续跑基数：原任务重试时从明细表重算出的已有进度接着累加，不清零 */
    base?: { done: number; success: number; failed: number; reviews: number };
    /** 并发 worker 数（1~3，缺省 2）：worker 越多越快，但共享登录态风控一弹全停 */
    concurrency?: number;
  },
): Promise<{ stopReason?: string }> {
  const p: RatingsProgress = {
    done: opts.base?.done ?? 0,
    success: opts.base?.success ?? 0,
    failed: opts.base?.failed ?? 0,
    reviews: opts.base?.reviews ?? 0,
    currentItem: null,
    currentStep: null,
  };
  const tick = () => opts.persist({ ...p });
  let stopReason: string | undefined;
  await ensureBrowser();
  const context = session!.context;

  // 共享游标：worker 各自从队列里领商品，直到领空
  let next = 0;

  //先把所有 worker 页开好再清理残留 —— Edge（Windows）在关光标签时会整个退出，
  // 必须先有常驻页兜底，否则清理动作等于把浏览器关了（已实锤踩坑）。
  // 低频模式：强制单 worker（shopee.tw 登录买家账号采集，去掉并发降低风控暴露面；
  // 2026-10-18 的警告+强制登出证明了并发匀速节奏不可承受）。opts.concurrency 保留
  // 参数签名不动（前端表单还在传），但此处不再生效。
  const n = Math.min(items.length, 1);
  const workerPages: Page[] = [];
  for (let i = 0; i < n; i++) workerPages.push(await context.newPage());

  // 清掉上一轮残留的商品页/风控页 —— 旧版单发模式每商品新开标签从不关闭，
  // 一次批量能攒下几十个标签（用户反馈「页面越开越多」的根源）。
  // worker 自己的页（about:blank）不匹配 PDP/verify 正则，天然安全；其余
  // 非商品标签（搜索页等）一律保留。
  for (const pg of context.pages()) {
    if (workerPages.includes(pg)) continue;
    if (/(?:xiapi\.xiapibuy\.com|shopee\.tw)\/(?:product\/|verify\/)/i.test(pg.url())) {
      await pg.close().catch(() => undefined);
    }
  }

  const worker = async (workerId: number): Promise<void> => {
    // worker 错峰启动：两个标签页不要同时 goto（齐步走像机器人编队）
    await sleep(workerId * (2_500 + Math.random() * 2_500));
    // 每个 worker 独占一个标签页，商品间直接 goto 覆盖，结束统一关闭
    const page = workerPages[workerId];
    try {
      for (;;) {
        if (opts.isAborted()) {
          stopReason = stopReason ?? "用户手动停止";
          return;
        }
        const idx = next;
        if (idx >= items.length) return;
        next += 1;
        const item = items[idx];
        p.currentItem = `${item.shopId}_${item.itemId} ${item.name.slice(0, 40)}`;
        p.currentStep = "排队开始";
        updateCollectTaskItem(taskId, item.shopId, item.itemId, { status: "running" });
        tick();

        let ok = false;
        let errMsg: string | undefined;
        // 步骤回调带 worker 编号：并发时任务表能看到两个页在干什么
        const onStep = (step: string) => {
          p.currentStep = `[${workerId + 1}] ${step}`;
          tick();
        };
        // 无固定尝试上限：验证码等待不消耗预算（只有其他错误才直接记败），
        // 触发风控就原地循环等人工，通过后继续采当前商品
        for (;;) {
          if (opts.isAborted()) break;
          const r = await collectRatings(item.shopId, item.itemId, maxPagesPerItem, onStep, { page });
          if (!r.navError) {
            ok = true;
            errMsg = undefined;
            // 商品信息（PDP）与评论产出都记进明细
            updateCollectTaskItem(taskId, item.shopId, item.itemId, {
              status: "done",
              reviews: r.stats.new,
              pdpSaved: r.stats.pdpSaved > 0,
            });
            p.reviews += r.stats.new;
            break;
          }
          if (r.navError.includes("验证码")) {
            opts.setWaitingCaptcha?.(true);
            // 原地循环等待，不跳下一个商品：每分钟刷新一次步骤文案（带已等时长），
            // 直到人工过滑块（URL 离开 /verify/）才重采当前商品。
            // 退出等待只有两条路：点停止，或浏览器窗口被整个关掉。
            const waitStart = Date.now();
            for (;;) {
              const mins = Math.floor((Date.now() - waitStart) / 60_000);
              onStep(mins > 0 ? `等待人工过验证码（已等 ${mins} 分钟）` : "等待人工过验证码");
              const solved = await waitForCaptchaSolved(page, 60_000);
              if (solved) break;
              if (opts.isAborted() || page.isClosed()) break;
            }
            opts.setWaitingCaptcha?.(false);
            if (page.isClosed()) {
              errMsg = "等待验证码期间浏览器窗口被关闭";
              break;
            }
            if (opts.isAborted()) break;
            continue; // 过了滑块，重采当前商品
          }
          errMsg = r.navError;
          break;
        }
        if (ok) {
          p.success += 1;
        } else {
          p.failed += 1;
          updateCollectTaskItem(taskId, item.shopId, item.itemId, {
            status: "failed",
            error: errMsg,
          });
          if (errMsg) {
            opts.errors.unshift(`${p.currentItem}：${errMsg.slice(0, 120)}`);
            if (opts.errors.length > 20) opts.errors.length = 20;
          }
        }
        p.done += 1;
        p.currentStep = "商品间隔等待";
        tick();
        // 商品之间随机停 6~12 秒（低频模式：登录账号采集，节奏向人手速看齐；
        // 单 worker 下整批吞吐 ≈ 4-6 商品/分钟，宁慢勿封）
        if (!opts.isAborted() && next < items.length) {
          await sleep(6_000 + Math.random() * 6_000);
        }
      }
    } catch (error) {
      // 兜底：worker 异常不能拖死整个任务，把剩余商品交给别的 worker 收尾
      stopReason = String(error).slice(0, 300);
      opts.errors.unshift(`worker#${workerId + 1} 异常：${stopReason.slice(0, 120)}`);
      if (opts.errors.length > 20) opts.errors.length = 20;
    } finally {
      // 无论正常跑完、停止还是异常，worker 的标签页都必须关掉
      await page.close().catch(() => undefined);
    }
  };

  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
  p.currentItem = null;
  p.currentStep = null;
  return { stopReason };
}

async function runRatingsBatch(
  taskId: number,
  items: { shopId: string; itemId: string; name: string }[],
  maxPagesPerItem: number,
  opts?: {
    /** 续跑基数：进度从已有值继续累加（原任务重试场景） */
    base?: { done: number; success: number; failed: number; reviews: number };
    /** 搜索任务的评论阶段续跑：success/failed 是搜索口径（新增/跳过），不能被评论成败覆盖 */
    preserveSearchCounters?: boolean;
    /** 并发 worker 数（1~3） */
    concurrency?: number;
  },
): Promise<void> {
  let stopReason: string | undefined;
  try {
    // 进度口径：success/failed=商品成败，done/total=商品进度，reviews=评论文数
    const r = await runRatingsItems(taskId, items, maxPagesPerItem, {
      isAborted: () => ratingsBatch.abort,
      base: opts?.base,
      concurrency: opts?.concurrency,
      persist: (p) => {
        Object.assign(ratingsBatch, p);
        updateCollectTaskProgress(taskId, {
          done: p.done,
          // 搜索任务续跑时保住搜索阶段的 success/failed（COALESCE 跳过 undefined）
          success: opts?.preserveSearchCounters ? undefined : p.success,
          failed: opts?.preserveSearchCounters ? undefined : p.failed,
          reviews: p.reviews,
          currentItem: p.currentItem,
          currentStep: p.currentStep ?? undefined,
        });
      },
      setWaitingCaptcha: (v) => {
        ratingsBatch.waitingCaptcha = v;
      },
      errors: ratingsBatch.errors,
    });
    stopReason = r.stopReason;
  } catch (error) {
    // 兜底：任何未捕获异常都不能把任务永远挂在 running 上
    stopReason = String(error).slice(0, 300);
    ratingsBatch.errors.unshift(`任务 #${taskId} 异常中止：${stopReason.slice(0, 120)}`);
  } finally {
    ratingsBatch.running = false;
    ratingsBatch.currentItem = null;
    ratingsBatch.currentStep = null;
    ratingsBatch.waitingCaptcha = false;
    ratingsBatch.finishedAt = new Date().toISOString();
    finishCollectTask(
      taskId,
      // abort 优先于 stopReason：手动停止时 stopReason 是「用户手动停止」，
      // 不能因为它是错误文案就把状态记成 failed
      ratingsBatch.abort ? "stopped" : stopReason ? "failed" : "done",
      stopReason,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 搜索采集任务（kind=search）：输入关键字 → 按关键字抓商品入库打标。
 * 与评论批量共用同一个托管浏览器页，两者互斥运行。
 * ------------------------------------------------------------------ */

/** 搜索采集任务状态（内存快照，权威数据在 collect_tasks 表） */
export interface SearchTaskState {
  running: boolean;
  taskId: number | null;
  keyword: string | null;
  /** 当前阶段：search=采商品 / ratings=采评论（两阶段任务），null=未在跑 */
  phase: "search" | "ratings" | null;
  /** 已入库商品数（实时增量，商品阶段口径） */
  added: number;
  /** 已跳过（库中已有）商品数（商品阶段口径） */
  skipped: number;
  currentStep: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  abort: boolean;
}

const searchTask: SearchTaskState = {
  running: false,
  taskId: null,
  keyword: null,
  phase: null,
  added: 0,
  skipped: 0,
  currentStep: null,
  startedAt: null,
  finishedAt: null,
  abort: false,
};

export function getSearchTaskState(): SearchTaskState {
  return { ...searchTask };
}

/** 两个跑批共用一个浏览器页，同一时刻只允许一个在跑 */
function anyBatchRunning(): boolean {
  return ratingsBatch.running || searchTask.running;
}

/**
 * 创建搜索采集任务（两阶段）：阶段①按关键字翻页抓商品入库打标，
 * 阶段②自动对该关键字下所有还没采过评论的商品逐个采评论。
 * 任务与进度持久化到 collect_tasks 表（kind=search, tag=关键字）。
 * 计数口径：success/failed=商品新增/跳过；total/done/reviews=评论阶段的
 * 待采商品数/已处理数/新增评论文（两阶段共用一行任务，字段互不覆盖）。
 */
export function startSearchTask(
  keyword: string,
  screens: number,
  autoRatings = true,
  ratingsPages = 20,
  concurrency = 2,
): { started: boolean; taskId?: number; message: string } {
  if (anyBatchRunning()) {
    return { started: false, message: "已有采集任务在跑（搜索或评论批量），请先等它结束或点停止" };
  }
  // 搜索任务没有固定商品清单，明细为空快照；进度靠 searchStats 增量心跳
  const taskId = createCollectTask("search", keyword, screens, []);
  Object.assign(searchTask, {
    running: true,
    taskId,
    keyword,
    phase: "search",
    added: 0,
    skipped: 0,
    currentStep: "排队开始",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    abort: false,
  });
  void runSearchTask(taskId, keyword, screens, autoRatings, ratingsPages, concurrency);
  return {
    started: true,
    taskId,
    message: `搜索采集任务 #${taskId} 已创建（关键字：${keyword}${autoRatings ? "，采完商品自动续采评论" : ""}）`,
  };
}

export function stopSearchTask(): void {
  if (searchTask.running) searchTask.abort = true;
}

async function runSearchTask(
  taskId: number,
  keyword: string,
  screens: number,
  autoRatings: boolean,
  ratingsPages: number,
  concurrency: number,
): Promise<void> {
  const start: SearchStats = { ...searchStats };
  const tick = (step?: string) => {
    if (step) searchTask.currentStep = step;
    searchTask.added = searchStats.added - start.added;
    searchTask.skipped = searchStats.skipped - start.skipped;
    updateCollectTaskProgress(taskId, {
      currentStep: searchTask.currentStep ?? undefined,
      success: searchTask.added,
      failed: searchTask.skipped,
    });
  };
  let stopReason: string | undefined;
  try {
    const onStep = (step: string) => tick(`①采商品 ${step}`);
    const r = await collectSearch(keyword, screens, onStep);
    if (r.navError) {
      stopReason = r.navError;
    } else if (r.limited) {
      // 限流说明 Shopee 已有风控压力，此时立刻接评论采集只会雪上加霜，直接收尾
      stopReason = "收到空响应，疑似 Shopee 限流，已提前终止（建议隔段时间再采）";
    }
    searchTask.added = r.stats.added;
    searchTask.skipped = r.stats.skipped;
  } catch (error) {
    stopReason = String(error).slice(0, 300);
  }

  // 阶段②：商品采完（且没被限流/中止）就自动续采该关键字下待采评论的商品。
  // 快照是「review_file IS NULL + 该关键字标签」，天然覆盖之前搜过但没采评论的商品。
  if (!stopReason && !searchTask.abort && autoRatings) {
    try {
      const pending = listPendingRatings(keyword, 500);
      if (pending.length) {
        searchTask.phase = "ratings";
        // 待采明细此刻才可知：补插明细行，任务行 total 切到评论口径
        insertCollectTaskItems(taskId, pending);
        updateCollectTaskProgress(taskId, { total: pending.length, done: 0, reviews: 0 });
        // 进度口径：total/done/reviews=评论阶段；success/failed 保留商品阶段（新增/跳过）
        await runRatingsItems(taskId, pending, ratingsPages, {
          isAborted: () => searchTask.abort,
          concurrency,
          persist: (p) => {
            searchTask.currentStep = p.currentStep ? `②采评论 ${p.currentStep}` : null;
            updateCollectTaskProgress(taskId, {
              done: p.done,
              reviews: p.reviews,
              currentItem: p.currentItem,
              currentStep: searchTask.currentStep ?? undefined,
            });
          },
          errors: [],
        });
      }
    } catch (error) {
      stopReason = String(error).slice(0, 300);
    }
  }

  searchTask.running = false;
  searchTask.currentStep = null;
  searchTask.phase = null;
  searchTask.finishedAt = new Date().toISOString();
  // 终态只写商品口径的计数（评论阶段计数已随跑随写，这里 COALESCE 不会覆盖）
  updateCollectTaskProgress(taskId, {
    success: searchTask.added,
    failed: searchTask.skipped,
  });
  finishCollectTask(taskId, stopReason ? "failed" : searchTask.abort ? "stopped" : "done", stopReason);
}
