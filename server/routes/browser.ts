/**
 * 内嵌浏览器路由：REST 只做状态查询，实时交互（帧流/输入）全走 WebSocket。
 *
 * 为什么不走 HTTP 轮询：截屏流每秒 10-20 帧、每帧几十 KB，HTTP 轮询延迟和
 * 开销都不可接受；WebSocket 单连接双向推送刚好匹配「帧下行 + 事件上行」。
 *
 * 鉴权：WS 不能带 Authorization 头（浏览器 WebSocket API 限制），改为
 * /api/browser/ws?token=<会话token> 查询参数校验 —— token 与登录会话同一套。
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Router } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { bearerOf, verifyToken } from "../auth/session";
import {
  attachViewer,
  closeBrowser,
  detachViewer,
  dispatchKey,
  dispatchMouse,
  dispatchWheel,
  ensureBrowser,
  getStatus,
  goBack,
  insertText,
  navigate,
  reload,
  VIEWPORT,
} from "../browser/manager";

/** REST 面板状态查询（挂在全局鉴权之后，自带会话保护） */
export const browserRouter = Router();

browserRouter.get("/status", (_req, res) => {
  res.json(getStatus());
});

browserRouter.post("/close", (_req, res) => {
  void closeBrowser().then(() => res.json({ ok: true }));
});

const wss = new WebSocketServer({ noServer: true });

/** 每个 WS 连接一个观看者；接入即拉起浏览器，关闭时若无人观看则启动空闲倒计时 */
wss.on("connection", (ws: WebSocket) => {
  attachViewer({
    onFrame: (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "frame", data }));
      }
    },
    onUrl: (url) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "url", url }));
      }
    },
  });

  // 观看即启动：首帧延迟 = Edge 冷启动时间（~1-2s），期间前端显示「启动中」
  void ensureBrowser().catch((error: unknown) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: String(error).slice(0, 200) }));
    }
  });

  ws.on("message", (raw) => {
    void handleClientMessage(ws, raw.toString()).catch(() => undefined);
  });

  ws.on("close", () => detachViewer());
  ws.on("error", () => detachViewer());
});

/** 客户端消息按 type 分发。所有输入坐标都是「视口坐标」（前端已按缩放换算） */
async function handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = msg.type as string;
  switch (type) {
    case "navigate":
      await navigate((msg.url as string) ?? "");
      break;
    case "back":
      await goBack();
      break;
    case "reload":
      await reload();
      break;
    case "close":
      await closeBrowser();
      break;
    case "mouse":
      await dispatchMouse(msg as never);
      break;
    case "wheel":
      await dispatchWheel(msg as { dx: number; dy: number; x: number; y: number });
      break;
    case "key":
      await dispatchKey(msg as never);
      break;
    case "text":
      await insertText((msg.text as string) ?? "");
      break;
    default:
      break;
  }
}

/**
 * http server 的 upgrade 处理：校验 token 后交给 wss。
 * token 从查询参数取（浏览器 WebSocket API 无法自定义请求头）。
 */
export function handleBrowserUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/browser/ws") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token") ?? bearerOf(request.headers.authorization);
  if (!verifyToken(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    // 连接建立即告知视口尺寸，前端据此换算坐标与画布比例
    ws.send(JSON.stringify({ type: "hello", viewport: VIEWPORT }));
    wss.emit("connection", ws, request);
  });
}
