/**
 * 比特浏览器（BitBrowser）连接器：通过本机 Local API 管理指纹窗口。
 *
 * 为什么走 Local API 而不是直接 spawn 指纹内核：指纹窗口的设备指纹、
 * 代理、时区、cookie 隔离全部由比特管理端负责，绕开它等于放弃了指纹
 * 浏览器的全部意义。API 约定（官方文档）：
 *   - 管理端启动后监听 http://127.0.0.1:54345
 *   - 业务接口全部 POST JSON，返回 { success, msg, data }
 *   - /browser/open 返回的 data.http 即指纹窗口的 CDP 端点（127.0.0.1:端口），
 *     与现有 connectOverCDP 管线无缝对接 —— 这是选比特的根本原因
 *
 * 注意：本模块由 dev server（用户终端环境）调用，spawn 的管理端继承的
 * 是干净环境。绝不能在 WorkBuddy 等注入了 ELECTRON_RUN_AS_NODE /
 * NODE_OPTIONS 的宿主里调 —— 管理端是 Electron 应用，会被毒环境变量
 * 干成 Node 模式（bad option）或启动后秒退（2026-10-21 实测踩坑）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 比特管理端 Local API 地址（v7.x 固定端口，暂不支持自定义） */
const BIT_API = "http://127.0.0.1:54345";

/** 管理端 exe 候选路径：env 显式指定 > 用户目录安装 > Program Files */
function findBitExe(): string | null {
  const candidates = [
    process.env.BITBROWSER_EXE,
    process.env.LocalAppData && path.join(process.env.LocalAppData, "Programs", "BitBrowser", "BitBrowser.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "BitBrowser", "BitBrowser.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "BitBrowser", "BitBrowser.exe"),
  ].filter((p): p is string => !!p);
  for (const exe of candidates) {
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * 管理端 GPU 兼容参数（仅影响管理端自己，不影响指纹窗口）。
 * 背景：这台机器 Intel HD 5500 驱动停留在 2016 年，Chromium GPU 进程
 * 连环崩（0xC0000005 / "GPU process isn't usable. Goodbye."）。
 * 不能用 --disable-gpu：指纹一致性要求真 GPU 渲染，且管理端会自己覆盖。
 * swiftshader 软渲染组合实测初始化全程零崩溃。
 */
const BIT_GPU_ARGS = [
  "--use-angle=swiftshader",
  "--disable-gpu-compositing",
  "--disable-accelerated-2d-canvas",
  "--disable-gpu-sandbox",
  "--disable-vulkan",
];

/** 统一的 POST 调用：非 2xx / success=false 一律抛错，调用方按需兜底 */
async function apiPost<T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${BIT_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let msg = `HTTP ${res.status}`;
  let data: unknown;
  try {
    const json = (await res.json()) as { success?: boolean; msg?: string; data?: T };
    data = json.data;
    if (json.msg) msg = json.msg;
    if (json.success === false) throw new Error(`比特 API ${path} 失败：${msg}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("比特 API")) throw error;
    throw new Error(`比特 API ${path} 响应异常：${msg}`);
  }
  return data as T;
}

/**
 * 管理端是否在运行。探活用 /browser/list（POST）：7.2.0 实测没有 /health
 * 路由（返回 404），而 /browser/list 是最轻的业务接口，还能顺带确认登录态。
 */
export async function bitApiAlive(timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${BIT_API}/browser/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: 0, pageSize: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface BitWindow {
  /** 窗口唯一 id（/browser/open 用它指定窗口） */
  id: string;
  /** 窗口序号，UI 里展示的「窗口1/窗口2」就是它 */
  seq: number;
  name: string;
  remark?: string;
}

/** 拉取窗口清单（一页拉满 200，个人账号量级远用不完） */
export async function listBitWindows(): Promise<BitWindow[]> {
  const data = await apiPost<{ list?: BitWindow[] }>("/browser/list", { page: 0, pageSize: 200 });
  return data?.list ?? [];
}

/**
 * 确保管理端在运行：没运行就 spawn（继承 dev server 的干净环境），
 * 然后轮询 /health 直到就绪。Electron 冷启动实测 10~25 秒。
 */
export async function ensureBitApp(timeoutMs = 40_000): Promise<void> {
  if (await bitApiAlive()) return;
  const exe = findBitExe();
  if (!exe) {
    throw new Error("未找到比特浏览器（BitBrowser.exe），请安装或用 BITBROWSER_EXE 指定路径");
  }
  spawn(exe, BIT_GPU_ARGS, { stdio: "ignore" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    if (await bitApiAlive()) return;
  }
  throw new Error("比特浏览器管理端启动超时（40 秒内 Local API 未就绪）");
}

export interface BitWindowHandle {
  /** 指纹窗口 CDP 端口（data.http = "127.0.0.1:端口"） */
  port: number;
  windowId: string;
  windowName: string;
}

/**
 * 确保指定指纹窗口已打开，返回其 CDP 端口。
 * 窗口选择规则（按优先级）：
 *   1. env BITBROWSER_WINDOW：窗口名精确/包含匹配，纯数字按 seq 匹配
 *   2. 清单里第一个窗口
 * 对已打开的窗口重复调 /browser/open 会直接返回既有端点（官方语义），
 * 所以「确保打开」和「重新拿端口」是同一个调用，无需额外探活。
 *
 * extensionPaths：本地扩展目录列表，走 /browser/open 的 args 参数挂载
 * （官方文档明确支持 --load-extension）。注意：窗口已开着时重复 open
 * 会忽略 args —— 需要挂扩展的调用方必须保证先关窗再调这里。
 * 2026-10-28 实测：两轮冷启动（profile 复用）扩展都能加载，
 * 不存在 Edge 那种二次启动禁用开发者扩展的坑。
 */
export async function ensureBitWindowOpen(opts?: { extensionPaths?: string[] }): Promise<BitWindowHandle> {
  await ensureBitApp();
  const windows = await listBitWindows();
  if (!windows.length) {
    throw new Error("比特浏览器里还没有指纹窗口，请先在窗口管理里创建一个");
  }
  const wanted = process.env.BITBROWSER_WINDOW?.trim();
  let target: BitWindow | undefined;
  if (wanted) {
    const asSeq = Number(wanted);
    target = windows.find((w) => w.name === wanted || w.remark === wanted)
      ?? (Number.isInteger(asSeq) ? windows.find((w) => w.seq === asSeq) : undefined)
      ?? windows.find((w) => w.name.includes(wanted));
  }
  target = target ?? windows[0];
  const body: Record<string, unknown> = { id: target.id };
  const ext = opts?.extensionPaths?.filter(Boolean) ?? [];
  if (ext.length) body.args = [`--load-extension=${ext.join(",")}`];
  const data = await apiPost<{ http?: string }>("/browser/open", body, 30_000);
  const http = data?.http ?? "";
  const port = Number(http.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`比特窗口打开成功但未返回有效 CDP 端点（http=${http}）`);
  }
  return { port, windowId: target.id, windowName: target.name };
}

/** 关闭指纹窗口（保留窗口配置，只关实例）。失败返回 false 交调用方兜底。 */
export async function closeBitWindow(windowId: string): Promise<boolean> {
  try {
    await apiPost("/browser/close", { id: windowId });
    return true;
  } catch {
    return false;
  }
}
