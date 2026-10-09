/**
 * 内嵌浏览器管理器：单例有头 Edge + CDP 截屏流。
 *
 * 为什么是「有头 + 截屏」而不是 iframe：1688/Shopee 都设置了 X-Frame-Options，
 * iframe 会被拒绝渲染；无头浏览器又会被反爬识别。有头 Edge 通过 CDP
 * （Chrome DevTools Protocol）把画面以 JPEG 帧推给前端 canvas，前端把
 * 鼠标/键盘事件原样回传 —— 用户看到并操作的是一个真浏览器，插件、登录态、
 * 反爬指纹全部保留。
 *
 * 生命周期：第一个 WebSocket 客户端接入时启动，最后一个断开后空闲
 * IDLE_CLOSE_MS 自动关闭（释放 ~400MB 内存）。登录态保存在 profile 目录，
 * 关闭再开不丢。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

/** 浏览器视口（CDP 帧坐标与前端坐标换算的基准） */
export const VIEWPORT = { width: 1280, height: 800 } as const;

const PROFILE_DIR = path.join(process.cwd(), "server", "browser", "profile");
/** 插件清单：路径相对项目根（与 PROFILE_DIR 同基准），绝对路径也兼容 */
const EXTENSIONS_FILE = path.join(process.cwd(), "server", "browser", "extensions.json");
/** 最后一个观看者离开后保留浏览器的时长（快速切页/刷新不重启浏览器） */
const IDLE_CLOSE_MS = 5 * 60_000;

let ctx: BrowserContext | null = null;
let page: Page | null = null;
let cdp: CDPSession | null = null;
/** 当前观看者的帧回调；null = 无人观看 */
let frameSink: ((jpegBase64: string) => void) | null = null;
/** 帧序号：CDP 要求每帧必须 ack，否则不再推新帧 */
let frameSessionId = 0;
let idleTimer: NodeJS.Timeout | null = null;
let starting: Promise<void> | null = null;

/**
 * 从 server/browser/extensions.json 读取要挂载的未打包插件目录。
 * 相对路径相对项目根解析（clone 即用，不绑定机器），绝对路径也兼容；
 * 文件不存在视为不挂载。插件随浏览器启动加载一次，挂在 profile 里长期有效。
 */
function extensionArgs(): string[] {
  let list: unknown;
  try {
    list = JSON.parse(fs.readFileSync(EXTENSIONS_FILE, "utf-8"));
  } catch {
    return []; // 不存在或 JSON 坏了都静默跳过——插件是可选能力，不该让浏览器起不来
  }
  const dirs = (Array.isArray(list) ? list : (list as { extensions?: unknown[] })?.extensions ?? [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => path.resolve(process.cwd(), d.trim()))
    .filter((d) => fs.existsSync(d));
  if (!dirs.length) return [];
  // disable-extensions-except 必须与 load-extension 同时给，否则其他内置插件会干扰截屏流
  return [`--disable-extensions-except=${dirs.join(",")}`, `--load-extension=${dirs.join(",")}`];
}

async function startBrowser(): Promise<void> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "msedge", // 系统已装的 Edge，免下载；独立于用户日常浏览器的 profile
    headless: false, // 有头：反爬不识别、插件完整支持。窗口在任务栏，但不抢占前台
    viewport: VIEWPORT,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      ...extensionArgs(),
    ],
  });

  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("about:blank", { waitUntil: "commit" }).catch(() => undefined);

  cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (event: { sessionId: number; data: string }) => {
    // 必须先 ack 再分发，否则 CDP 认为上一帧没被消费、停止推送
    void cdp?.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    frameSessionId = event.sessionId;
    if (frameSink) frameSink(event.data);
  });
  // 主框架跳转后通知前端更新地址栏
  cdp.on("Page.frameNavigated", (event: { frame: { parentId?: string; url?: string } }) => {
    if (!event.frame.parentId && event.frame.url) {
      currentUrl = event.frame.url;
      urlSink?.(currentUrl);
    }
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 65,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  }).catch(() => undefined);

  ctx.on("close", () => {
    // 用户在 Edge 窗口里手动关闭 → 同步清理内部状态
    ctx = null;
    page = null;
    cdp = null;
    frameSink = null;
    currentUrl = "about:blank";
  });

  console.log("[browser] 内嵌浏览器已启动（profile: server/browser/profile）");
}

let currentUrl = "about:blank";
let urlSink: ((url: string) => void) | null = null;

/** 确保浏览器在跑（并发调用共享同一个启动 Promise，避免重复拉起） */
export async function ensureBrowser(): Promise<void> {
  if (ctx) return;
  if (starting) return starting;
  starting = startBrowser()
    .catch((error) => {
      // 启动失败要清掉缓存状态，否则后续调用永远撞同一个失败 Promise
      ctx = null;
      throw error;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

export function isRunning(): boolean {
  return ctx !== null;
}

export function getStatus(): { running: boolean; url: string; viewport: typeof VIEWPORT } {
  return { running: isRunning(), url: currentUrl, viewport: VIEWPORT };
}

/** 注册帧/URL 接收方（单观看者模型：新观看者直接顶掉旧的） */
export function attachViewer(sinks: {
  onFrame: (jpegBase64: string) => void;
  onUrl: (url: string) => void;
}): void {
  frameSink = sinks.onFrame;
  urlSink = sinks.onUrl;
  sinks.onUrl(currentUrl);
  touchActivity();
}

export function detachViewer(): void {
  frameSink = null;
  urlSink = null;
  touchActivity();
}

/** 空闲计时：任何客户端活动都重置；归零且无人观看时关闭浏览器释放资源 */
function touchActivity(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!frameSink) {
      void closeBrowser();
    }
  }, IDLE_CLOSE_MS);
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (ctx) {
    await ctx.close().catch(() => undefined);
    console.log("[browser] 内嵌浏览器已关闭（空闲超时）");
  }
  ctx = null;
  page = null;
  cdp = null;
  frameSink = null;
  currentUrl = "about:blank";
}

/* ---------------- 操作（供 WS 消息分发调用） ---------------- */

export async function navigate(url: string): Promise<void> {
  await ensureBrowser();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  await page!.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  currentUrl = page!.url();
  urlSink?.(currentUrl);
}

export async function goBack(): Promise<void> {
  await page?.goBack({ timeout: 30_000 }).catch(() => undefined);
  currentUrl = page?.url() ?? currentUrl;
  urlSink?.(currentUrl);
}

export async function reload(): Promise<void> {
  await page?.reload({ timeout: 45_000 }).catch(() => undefined);
}

export interface MouseInput {
  action: "move" | "down" | "up";
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
}

export async function dispatchMouse(input: MouseInput): Promise<void> {
  if (!cdp) return;
  const type = input.action === "move" ? "mouseMoved" : input.action === "down" ? "mousePressed" : "mouseReleased";
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(input.x),
    y: Math.round(input.y),
    button: input.button ?? "left",
    buttons: input.action === "up" ? 0 : input.action === "down" ? 1 : 0,
    clickCount: input.action === "down" || input.action === "up" ? 1 : 0,
  }).catch(() => undefined);
}

export async function dispatchWheel(input: { dx: number; dy: number; x: number; y: number }): Promise<void> {
  if (!cdp) return;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round(input.x),
    y: Math.round(input.y),
    deltaX: input.dx,
    deltaY: input.dy,
  }).catch(() => undefined);
}

export interface KeyInput {
  action: "down" | "up";
  key: string;
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export async function dispatchKey(input: KeyInput): Promise<void> {
  if (!cdp) return;
  await cdp.send("Input.dispatchKeyEvent", {
    type: input.action === "down" ? "keyDown" : "keyUp",
    key: input.key,
    code: input.code,
    windowsVirtualKeyCode: 0,
    modifiers:
      (input.ctrl ? 2 : 0) | (input.shift ? 8 : 0) | (input.alt ? 1 : 0),
  }).catch(() => undefined);
}

/** 文本输入：中文/输入法场景走 insertText，比逐键 keyEvent 可靠 */
export async function insertText(text: string): Promise<void> {
  if (!cdp || !text) return;
  await cdp.send("Input.insertText", { text }).catch(() => undefined);
}
