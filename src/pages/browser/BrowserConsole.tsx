/**
 * 浏览器监控控制台：弹出式 Edge 窗口的查看与管理入口。
 *
 * 浏览器本体是服务端拉起的真实 Edge 窗口（用户在桌面上原生操作），本页做
 * 四件事：展示托管状态（PID / CDP 端口 / 标签页）、远程打开 URL、关闭进程、
 * 监控批量采集任务（collect_tasks 表，含每步进度与商品明细）。
 * 每 3 秒轮询一次 —— 控制指令是低频操作，HTTP 轮询足够，不需要 WS。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RotateCw, X } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { ApiError } from "@/src/lib/api";
import { getSession } from "@/src/lib/auth";
import type { CollectTask, CollectTaskItem } from "@/src/types";

interface BrowserStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  url: string;
  tabs: string[];
  extensions: ExtensionCheck | null;
}

interface ExtensionCheck {
  checkedAt: string;
  items: { name: string; enabled: boolean }[];
  error?: string;
}

const IDLE_STATUS: BrowserStatus = {
  running: false,
  pid: null,
  port: null,
  startedAt: null,
  url: "about:blank",
  tabs: [],
  extensions: null,
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = getSession();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    },
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(payload?.error ?? `请求失败 (HTTP ${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

function BrowserConsolePage() {
  const [status, setStatus] = useState<BrowserStatus>(IDLE_STATUS);
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState<"open" | "close" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [searchParams] = useSearchParams();
  // 竞品商品页「打开」跳转携带的初始 URL：只在首次进入时消费一次
  const initialUrlRef = useRef<string | null>(searchParams.get("url"));
  const initialOpenedRef = useRef(false);
  // ---- 批量采集任务监控 ----
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [taskItems, setTaskItems] = useState<CollectTaskItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        request<BrowserStatus>("/api/browser/status"),
        request<{ tasks: CollectTask[] }>("/api/browser/tasks"),
      ]);
      setStatus(s);
      setTasks(t.tasks);
      setErrorMsg("");
    } catch (error) {
      // 轮询失败不打断页面，只显示最近一次错误；状态保留旧值
      if (error instanceof ApiError) setErrorMsg(error.message);
    }
  }, []);

  // 展开的任务明细：running 任务每次轮询都跟着刷新，能看到逐商品推进
  const loadItems = useCallback(async (taskId: number) => {
    setItemsLoading(true);
    try {
      const resp = await request<{ task: CollectTask; items: CollectTaskItem[] }>(
        `/api/browser/tasks/${taskId}`,
      );
      setTaskItems(resp.items);
    } catch {
      setTaskItems([]);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const toggleTask = useCallback(
    (id: number) => {
      setExpandedId((prev) => {
        const next = prev === id ? null : id;
        if (next) void loadItems(next);
        else setTaskItems([]);
        return next;
      });
    },
    [loadItems],
  );

  const open = useCallback(
    async (url: string) => {
      setBusy("open");
      setErrorMsg("");
      try {
        const resp = await request<BrowserStatus & { navError?: string }>("/api/browser/open", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        setStatus(resp);
        setUrlInput("");
        // 服务端会如实带回导航失败原因（DNS/代理/超时），错误页不冒充成功
        if (resp.navError) setErrorMsg(`导航失败：${resp.navError}`);
      } catch (error) {
        setErrorMsg(error instanceof ApiError ? error.message : "打开失败");
      } finally {
        setBusy(null);
      }
    },
    []
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
      // 展开的是运行中任务 → 明细跟着轮询一起刷新（看逐商品推进）
      if (expandedId && tasks.some((t) => t.id === expandedId && t.status === "running")) {
        void loadItems(expandedId);
      }
    }, 3000);
    // 携带 ?url= 进入（如竞品商品页跳转）：首次进入自动在弹出窗口打开一次
    if (!initialOpenedRef.current && initialUrlRef.current) {
      initialOpenedRef.current = true;
      void open(initialUrlRef.current);
    }
    return () => clearInterval(timer);
  }, [refresh, open, expandedId, tasks, loadItems]);

  const close = useCallback(async () => {
    if (!window.confirm("确定关闭弹出浏览器进程？登录态保留在 profile 中不会丢失。")) return;
    setBusy("close");
    try {
      await request("/api/browser/close", { method: "POST", body: JSON.stringify({}) });
      await refresh();
    } catch (error) {
      setErrorMsg(error instanceof ApiError ? error.message : "关闭失败");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const submitUrl = useCallback(() => {
    const target = urlInput.trim();
    if (target) void open(target);
  }, [open, urlInput]);

  const runningLabel = busy === "open" ? "启动中…" : status.running ? "运行中" : "未运行";

  return (
    <div className="space-y-4">
      <PageHeader
        title="浏览器监控"
        description="服务端托管的真实 Edge 窗口，在你的桌面上弹出、原生操作。登录态与插件保留在本机 profile 中；后续商品抓取都在这个进程里执行。"
      />

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {/* 状态行 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
          <span
            className={`flex items-center gap-1.5 font-medium ${
              status.running ? "text-emerald-600" : "text-slate-400"
            }`}
          >
            {busy === "open" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  status.running ? "bg-emerald-500" : "bg-slate-300"
                }`}
              />
            )}
            {runningLabel}
          </span>
          {status.running && (
            <>
              <span>PID：{status.pid ?? "接管实例（未知）"}</span>
              <span>CDP 端口：{status.port}</span>
              {status.startedAt && (
                <span>启动于：{new Date(status.startedAt).toLocaleTimeString()}</span>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7 text-slate-400"
            title="刷新状态"
            onClick={() => void refresh()}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
          {!status.running && (
            <Button
              size="sm"
              className="h-7"
              disabled={busy === "open"}
              onClick={() => void open("about:blank")}
            >
              启动浏览器
            </Button>
          )}
          {status.running && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-rose-600 hover:text-rose-700"
              disabled={busy === "close"}
              onClick={() => void close()}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              关闭浏览器
            </Button>
          )}
        </div>

        {/* 远程打开 URL */}
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitUrl()}
            placeholder="输入网址，在弹出窗口打开，如 detail.1688.com 或 shopee.tw"
            className="h-8 flex-1 text-xs"
          />
          <Button size="sm" className="h-8 shrink-0" disabled={busy === "open"} onClick={submitUrl}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            打开
          </Button>
        </div>

        {errorMsg && <p className="mt-2 text-xs text-rose-600">{errorMsg}</p>}

        {/* 插件健康检查 */}
        {status.running && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2">
              <p className="text-[11px] font-medium text-slate-500">插件加载状态</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-slate-500"
                title="重跑健康检查（会短暂闪现扩展管理页）"
                onClick={() => {
                  void request<BrowserStatus>("/api/browser/extensions/check", {
                    method: "POST",
                    body: JSON.stringify({}),
                  })
                    .then(setStatus)
                    .catch(() => undefined);
                }}
              >
                重新检查
              </Button>
            </div>
            {!status.extensions ? (
              <p className="mt-1 text-xs text-slate-400">检查中…（启动后自动执行一次）</p>
            ) : status.extensions.error ? (
              <p className="mt-1 text-xs text-amber-600">
                检查失败：{status.extensions.error}（不影响浏览器使用）
              </p>
            ) : (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {status.extensions.items.map((it) => (
                    <span
                      key={it.name}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        it.enabled
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          it.enabled ? "bg-emerald-500" : "bg-rose-500"
                        }`}
                      />
                      {it.name}{it.enabled ? " 已加载" : " 未加载"}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  检查于 {new Date(status.extensions.checkedAt).toLocaleTimeString()}。1688
                  采集浮层只出现在商品详情页（/offer/）右下角；插件图标默认未固定到工具栏，属正常现象。
                </p>
              </>
            )}
          </div>
        )}

        {/* 当前页面 + 标签页 */}
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-[11px] font-medium text-slate-500">当前页面</p>
          <p className="mt-0.5 break-all text-xs text-slate-700">
            {status.running ? status.url || "—" : "浏览器未运行"}
          </p>
          {status.running && status.tabs.length > 1 && (
            <>
              <p className="mt-2 text-[11px] font-medium text-slate-500">
                全部标签页（{status.tabs.length}）
              </p>
              <ul className="mt-1 space-y-0.5">
                {status.tabs.map((tab, i) => (
                  <li key={i} className="break-all text-[11px] text-slate-500">
                    {i + 1}. {tab}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <p className="mt-2 text-[11px] text-slate-400">
          在 Edge 窗口里手动关闭浏览器后，状态会在几秒内同步为「未运行」。dev server 重启不会重复拉起窗口，会自动接管旧实例。
        </p>
      </div>

      {/* 批量采集任务监控：collect_tasks 表 + 明细 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">采集任务</h2>
          <span className="text-[11px] text-slate-400">每 3 秒自动刷新 · 历史任务持久保存</span>
        </div>
        {!tasks.length ? (
          <p className="mt-3 text-xs text-slate-400">
            还没有采集任务。去「竞品商品」页点「批量采评论」启动一个（商品详情 + 评论一起采）。
          </p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {tasks.map((t) => {
              const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
              const running = t.status === "running";
              return (
                <div key={t.id} className="rounded-lg border border-slate-200 bg-slate-50">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
                    onClick={() => toggleTask(t.id)}
                  >
                    {expandedId === t.id ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    )}
                    <span className="text-xs font-semibold text-slate-700">#{t.id}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        running
                          ? "bg-sky-100 text-sky-700"
                          : t.status === "done"
                            ? "bg-emerald-50 text-emerald-700"
                            : t.status === "stopped"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      {running ? "进行中" : t.status === "done" ? "已完成" : t.status === "stopped" ? "已停止" : "失败"}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {t.kind === "search" ? "搜索+评论" : "商品+评论"}
                      {t.tag ? ` · ${t.tag}` : " · 全部"}
                    </span>
                    <span className="min-w-[120px] text-[11px] text-slate-600">
                      {t.kind === "search"
                        ? t.total > 0
                          ? `商品 ${t.success}新增/${t.failed}跳过 · 评论 ${t.done}/${t.total} · 评${t.reviews}条`
                          : `商品 新增${t.success}/跳过${t.failed}`
                        : `${t.done}/${t.total} · 成 ${t.success} 败 ${t.failed} · 评${t.reviews}条`}
                    </span>
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full rounded-full transition-all ${running ? "bg-sky-500" : "bg-emerald-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {running && t.currentStep && (
                      <span className="text-[11px] font-medium text-sky-600">
                        {t.currentStep}
                        {t.currentItem ? ` · ${t.currentItem}` : ""}
                      </span>
                    )}
                    {!running && t.error && (
                      <span className="max-w-[240px] truncate text-[11px] text-rose-500" title={t.error}>
                        {t.error}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-slate-400">
                      {t.finishedAt
                        ? `结束 ${new Date(t.finishedAt).toLocaleTimeString()}`
                        : `开始 ${new Date(t.createdAt ?? "").toLocaleTimeString()}`}
                    </span>
                  </button>
                  {expandedId === t.id && (
                    <div className="border-t border-slate-200 px-3 py-2">
                      {itemsLoading && !taskItems.length ? (
                        <p className="flex items-center gap-1.5 py-1 text-[11px] text-slate-400">
                          <Loader2 className="h-3 w-3 animate-spin" /> 加载明细…
                        </p>
                      ) : !taskItems.length ? (
                        <p className="py-1 text-[11px] text-slate-400">无明细</p>
                      ) : (
                        <ul className="divide-y divide-slate-100">
                          {taskItems.map((it) => (
                            <li key={`${it.shopId}_${it.itemId}`} className="flex items-center gap-2 py-1.5 text-[11px]">
                              <span
                                className={`w-14 shrink-0 rounded px-1.5 py-0.5 text-center font-medium ${
                                  it.status === "done"
                                    ? "bg-emerald-50 text-emerald-600"
                                    : it.status === "failed"
                                      ? "bg-rose-50 text-rose-600"
                                      : it.status === "running"
                                        ? "bg-sky-50 text-sky-600"
                                        : "bg-slate-100 text-slate-500"
                                }`}
                              >
                                {it.status === "done" ? "完成" : it.status === "failed" ? "失败" : it.status === "running" ? "采集中" : "待采"}
                              </span>
                              <span className="max-w-[320px] truncate text-slate-700" title={it.name ?? ""}>
                                {it.name || `${it.shopId}_${it.itemId}`}
                              </span>
                              <span className="text-slate-500">评 {it.reviews} 条</span>
                              {it.pdpSaved && (
                                <span className="text-emerald-600" title="PDP 商品详情已截获入库">
                                  详情✓
                                </span>
                              )}
                              {it.error && (
                                <span className="max-w-[260px] truncate text-rose-500" title={it.error}>
                                  {it.error}
                                </span>
                              )}
                              <a
                                className="ml-auto shrink-0 text-slate-400 underline-offset-2 hover:text-sky-600 hover:underline"
                                href={`https://xiapi.xiapibuy.com/product/${it.shopId}/${it.itemId}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                打开
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default BrowserConsolePage;
