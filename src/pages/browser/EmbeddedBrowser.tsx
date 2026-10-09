/**
 * 内嵌浏览器页：canvas 渲染服务端 Edge 的截屏流，鼠标/键盘事件回传给 CDP。
 *
 * 坐标约定：页面内所有交互坐标都换算成「视口坐标」（服务端 VIEWPORT 1280x800）
 * 再发给后端 —— 前端 canvas 是响应式缩放的，鼠标位置必须除以缩放比。
 *
 * 事件转发策略：
 * - 鼠标 move/down/up + 滚轮 → 原样转发（滚轮 preventDefault，宿主页面不滚动）
 * - 可打印字符 → Input.insertText（中文/输入法友好）
 * - 功能键（Enter/Backspace/方向键/Ctrl 组合）→ keyDown/keyUp
 * - Tab/space 等会移动宿主页焦点的按键一律 preventDefault 后转发
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Loader2, RotateCw, X } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { getSession } from "@/src/lib/auth";

/** 与服务端 VIEWPORT 一致；WS hello 消息会再次确认 */
const VIEWPORT = { width: 1280, height: 800 };

type ConnState = "connecting" | "starting" | "live" | "error";

function EmbeddedBrowserPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const viewportRef = useRef(VIEWPORT);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [url, setUrl] = useState("");
  /** 地址栏输入与当前实际 URL 分离：回车才导航 */
  const [urlInput, setUrlInput] = useState("");
  const frameSeqRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 竞品列表「打开」跳转进来时携带的初始 URL：WS 建连后自动导航一次。
  // 用 ref 记状态而非 state —— 只在连接回调里消费，不需要触发渲染
  const [searchParams] = useSearchParams();
  const initialUrlRef = useRef(searchParams.get("url"));
  const initialNavSentRef = useRef(false);

  const send = useCallback((payload: Record<string, unknown>) => {
    wsRef.current?.send(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const session = getSession();
      if (!session) return; // 路由守卫已保证有会话；防御性返回

      const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
      const ws = new WebSocket(
        `${proto}${window.location.host}/api/browser/ws?token=${encodeURIComponent(session.token)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConn("starting");
        // 携带 ?url= 进入（如竞品商品页跳转）：建连即导航，且只导航一次 ——
        // 断线重连后不再重发，那时服务端会把当前 URL 推回来同步地址栏
        if (!initialNavSentRef.current && initialUrlRef.current) {
          initialNavSentRef.current = true;
          ws.send(JSON.stringify({ type: "navigate", url: initialUrlRef.current }));
        }
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          data?: string;
          url?: string;
          viewport?: typeof VIEWPORT;
          message?: string;
        };
        if (msg.type === "hello" && msg.viewport) {
          viewportRef.current = msg.viewport;
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = msg.viewport.width;
            canvas.height = msg.viewport.height;
          }
        } else if (msg.type === "frame" && msg.data) {
          drawFrame(msg.data);
          setConn("live");
        } else if (msg.type === "url" && msg.url) {
          setUrl(msg.url);
          setUrlInput(msg.url === "about:blank" ? "" : msg.url);
        } else if (msg.type === "error") {
          setConn("error");
          setErrorMsg(msg.message ?? "浏览器启动失败");
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setConn("connecting");
        reconnectTimer.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    const drawFrame = (base64: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const img = new Image();
      frameSeqRef.current += 1;
      img.onload = () => {
        const ctx2d = canvas.getContext("2d");
        ctx2d?.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = `data:image/jpeg;base64,${base64}`;
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  /* ------- 坐标换算：canvas 显示尺寸 → 服务端视口坐标 ------- */
  const toViewport = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const vp = viewportRef.current;
    return {
      x: ((clientX - rect.left) * vp.width) / rect.width,
      y: ((clientY - rect.top) * vp.height) / rect.height,
    };
  }, []);

  const onMouse = useCallback(
    (e: React.MouseEvent, action: "move" | "down" | "up") => {
      const { x, y } = toViewport(e.clientX, e.clientY);
      const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
      send({ type: "mouse", action, x, y, button });
    },
    [send, toViewport]
  );

  // wheel 必须用非 passive 原生监听才能 preventDefault（React 的 onWheel 是 passive）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const vp = viewportRef.current;
      send({
        type: "wheel",
        dx: e.deltaX,
        dy: e.deltaY,
        x: ((e.clientX - rect.left) * vp.width) / rect.width,
        y: ((e.clientY - rect.top) * vp.height) / rect.height,
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [send]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 会改变宿主页面状态或触发浏览器快捷键的按键全部拦截后转发
      if (["Tab", " ", "F5", "F3"].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        send({ type: "text", text: e.key });
        return;
      }
      send({
        type: "key",
        action: "down",
        key: e.key,
        code: e.code,
        // Chromium 编辑类按键按 keyCode 分发，必须透传真实值，否则退格/回车/方向键失效
        keyCode: e.keyCode,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      });
    },
    [send]
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      send({ type: "key", action: "up", key: e.key, code: e.code, keyCode: e.keyCode });
    },
    [send]
  );

  const submitUrl = useCallback(() => {
    const target = urlInput.trim();
    if (target) send({ type: "navigate", url: target });
    canvasRef.current?.focus();
  }, [send, urlInput]);

  const statusBadge = {
    connecting: { label: "连接中…", cls: "text-slate-500" },
    starting: { label: "浏览器启动中…", cls: "text-amber-600" },
    live: { label: "实时", cls: "text-emerald-600" },
    error: { label: "启动失败", cls: "text-rose-600" },
  }[conn];

  return (
    <div className="space-y-4">
      <PageHeader
        title="内嵌浏览器"
        description="在平台内直接打开 1688 / Shopee 等外部页面。登录态与插件保留在本机 Edge 实例中，空闲 5 分钟自动关闭。"
      />

      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-slate-600"
            title="后退"
            onClick={() => send({ type: "back" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-slate-600"
            title="刷新"
            onClick={() => send({ type: "reload" })}
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitUrl()}
            placeholder="输入网址，如 detail.1688.com 或 shopee.tw"
            className="h-8 flex-1 text-xs"
          />
          <Button size="sm" className="h-8 shrink-0" onClick={submitUrl}>
            打开
          </Button>
          <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${statusBadge.cls}`}>
            {conn === "starting" && <Loader2 className="h-3 w-3 animate-spin" />}
            {statusBadge.label}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-slate-400 hover:text-rose-600"
            title="关闭浏览器（立即释放资源）"
            onClick={() => send({ type: "close" })}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {conn === "error" ? (
            <div className="flex h-[480px] flex-col items-center justify-center gap-2 text-sm text-rose-600">
              <p>内嵌浏览器启动失败</p>
              <p className="max-w-md text-xs text-slate-500">{errorMsg}</p>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              width={VIEWPORT.width}
              height={VIEWPORT.height}
              tabIndex={0}
              className="block w-full cursor-default select-none outline-none"
              onMouseMove={(e) => onMouse(e, "move")}
              onMouseDown={(e) => {
                canvasRef.current?.focus();
                onMouse(e, "down");
              }}
              onMouseUp={(e) => onMouse(e, "up")}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
            />
          )}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          当前页面：{url || "—"}（键盘输入需先点击画面获得焦点）
        </p>
      </div>
    </div>
  );
}

export default EmbeddedBrowserPage;
