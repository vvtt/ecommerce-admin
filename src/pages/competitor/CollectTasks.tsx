/**
 * 采集任务页：创建「按关键字抓商品」的搜索采集任务，并监控所有任务进度。
 *
 * 任务数据在 collect_tasks 表（服务端持久化），本页只读轮询 —— 进度、
 * 步骤、明细全部来自 DB，server 重启后历史依然可查。评论批量任务
 * （竞品商品页启动的）也会出现在列表里，可展开看逐商品明细。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListPlus, Loader2, RotateCcw, Search, Square, Trash2 } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { useToast } from "@/src/components/shared/Toast";
import { api } from "@/src/lib/api";
import type { CollectTask, CollectTaskItem } from "@/src/types";

/** 状态徽章的配色与文案 */
function statusBadge(status: string) {
  if (status === "running") return { cls: "bg-sky-100 text-sky-700", text: "进行中" };
  if (status === "done") return { cls: "bg-emerald-50 text-emerald-700", text: "已完成" };
  if (status === "stopped") return { cls: "bg-amber-50 text-amber-700", text: "已停止" };
  return { cls: "bg-rose-50 text-rose-700", text: "失败" };
}

function kindLabel(t: CollectTask) {
  if (t.kind === "search") return `搜索+评论${t.tag ? ` · ${t.tag}` : ""}`;
  if (t.kind === "ratings") return `商品+评论${t.tag ? ` · ${t.tag}` : ""}`;
  return t.kind;
}

/** 任务计数口径因类型而异：search 成功=新增入库 / 失败=跳过已有；
 *  两阶段任务（评论阶段已启动，total>0）再叠加评论进度 */
function countersLabel(t: CollectTask) {
  if (t.kind === "search") {
    const pages = (t.maxPages ?? 0) > 0 ? `${t.maxPages} 页` : "不限页";
    const base = `新增 ${t.success} · 跳过 ${t.failed}`;
    if (t.total > 0) {
      return `${base} · 评论 ${t.done}/${t.total} · 评${t.reviews}条`;
    }
    return `${base} · ${pages}`;
  }
  return `${t.done}/${t.total} · 成 ${t.success} 败 ${t.failed} · 评${t.reviews}条`;
}

function CollectTasksPage() {
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const [keyword, setKeyword] = useState("");
  /** 屏数留空（null）= 不限页数，一直翻到末页自然停止 */
  const [screens, setScreens] = useState<number | "">("");
  /** 采完商品自动续采评论（后端默认也是开） */
  const [autoRatings, setAutoRatings] = useState(true);
  /** 评论阶段并发 worker 数（1~3）：3 最快但风控压力大，默认 2 */
  const [concurrency, setConcurrency] = useState(2);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [taskItems, setTaskItems] = useState<CollectTaskItem[]>([]);
  const toast = useToast();
  // 上一轮 running 快照：用于检测「从跑变不跑」的时机弹结束 toast
  const prevRunningRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.listCollectTasks();
      const list = data?.tasks ?? [];
      setTasks(list);
    } catch {
      // 轮询失败不打断页面，保留旧值
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 任一任务从 running → 非 running 时刷新一次列表并提示
  const anyRunning = tasks.some((t) => t.status === "running");
  useEffect(() => {
    if (prevRunningRef.current && !anyRunning) void refresh();
    prevRunningRef.current = anyRunning;
  }, [anyRunning, refresh]);

  // 展开的任务若是运行中，明细跟着轮询一起刷
  useEffect(() => {
    if (!expandedId) return;
    const t = tasks.find((x) => x.id === expandedId);
    if (t?.status !== "running") return;
    let alive = true;
    api
      .getCollectTask(expandedId)
      .then(({ data }) => {
        if (alive) setTaskItems(data?.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [expandedId, tasks]);

  const createTask = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setBusy(true);
    try {
      const { data: r } = await api.startSearchTask({
        keyword: kw,
        // 留空 = 不限页数（后端 screens=0），翻到末页自然停止
        screens: screens === "" ? undefined : screens,
        autoRatings,
        concurrency,
      });
      toast.success(r.message);
      setKeyword("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建任务失败");
    } finally {
      setBusy(false);
    }
  }, [keyword, screens, autoRatings, concurrency, refresh, toast]);

  /** 停止指定任务（行级停止）：非运行中后端 409 提示 */
  const handleStop = useCallback(
    async (t: CollectTask) => {
      try {
        const { data: r } = await api.stopCollectTask(t.id);
        toast.info(r?.message ?? `任务 #${t.id} 已发送停止指令`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "停止失败");
      }
    },
    [toast],
  );

  const toggleTask = useCallback(
    async (id: number) => {
      if (expandedId === id) {
        setExpandedId(null);
        setTaskItems([]);
        return;
      }
      setExpandedId(id);
      try {
        const { data: r } = await api.getCollectTask(id);
        setTaskItems(r?.items ?? []);
      } catch {
        setTaskItems([]);
      }
    },
    [expandedId],
  );

  /** 删除任务并级联清理商品/评论文件 —— 不可恢复，必须二次确认 */
  const handleDelete = useCallback(
    async (t: CollectTask) => {
      const scope =
        t.kind === "search"
          ? `带「${t.tag}」标签的全部商品`
          : `任务明细里的 ${t.total} 个商品`;
      const ok = window.confirm(
        `确定删除任务 #${t.id}？\n\n将级联删除：该任务记录、${scope}、以及对应的商品详情/评论文件（评论 JSONL 一并清理）。\n文件会先移入 data/.trash 隔离区，确认无误后可手动彻底删除；此操作不可撤销。`,
      );
      if (!ok) return;
      try {
        const { data: r } = await api.deleteCollectTask(t.id);
        toast.success(
          `任务 #${t.id} 已删除：清理 ${r?.products ?? 0} 个商品、${r?.files ?? 0} 个文件`,
        );
        if (expandedId === t.id) {
          setExpandedId(null);
          setTaskItems([]);
        }
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "删除失败");
      }
    },
    [expandedId, refresh, toast],
  );

  /** 重试指定任务里失败的商品：后端把 failed 明细快照成新任务跑评论；无失败项时 409 提示 */
  const handleRetry = useCallback(
    async (t: CollectTask) => {
      try {
        const { data: r } = await api.retryFailedRatings({ taskId: t.id });
        toast.success(r?.message ?? `重试任务已启动`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重试失败");
      }
    },
    [refresh, toast],
  );

  const searchRunning = tasks.some((t) => t.status === "running" && t.kind === "search");

  return (
    <div className="space-y-4">
      <PageHeader
        title="采集任务"
        description="输入搜索关键字创建采集任务：先按关键字翻页采商品，再自动续采这些商品的评论。进度与阶段步骤持久化，可随时回来查看。"
      />

      {/* 创建任务 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <ListPlus className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-800">新建搜索采集任务</h2>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void createTask()}
            placeholder="搜索关键字，如：收納架桌上"
            className="h-9 w-64 text-sm"
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            采集页数
            <input
              type="number"
              min={1}
              max={60}
              value={screens}
              onChange={(e) => {
                const v = e.target.value;
                setScreens(v === "" ? "" : Math.min(Math.max(Number(v) || 1, 1), 60));
              }}
              placeholder="不限"
              className="h-9 w-16 rounded-md border border-slate-300 px-2 text-sm placeholder:text-slate-300"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500" title="采完商品后自动对该关键字下还没采过评论的商品逐个采评论">
            <input
              type="checkbox"
              checked={autoRatings}
              onChange={(e) => setAutoRatings(e.target.checked)}
              className="h-3.5 w-3.5 accent-sky-600"
            />
            自动采评论
          </label>
          <label
            className="flex items-center gap-1.5 text-xs text-slate-500"
            title="评论采集并发标签页数：3 最快，但共享登录态下风控一弹全停；2 是速度与风控的平衡点"
          >
            并发
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="h-9 rounded-md border border-slate-300 px-1.5 text-sm"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <Button className="h-9 gap-1.5" disabled={busy || !keyword.trim()} onClick={() => void createTask()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            创建任务
          </Button>
          <span className="text-[11px] text-slate-400">
            留空 = 不限页数；商品采完自动续采评论（停止请在任务行点 ■，跑完当前商品后退出）
          </span>
        </div>
        {searchRunning && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-sky-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            搜索采集进行中：{tasks.find((t) => t.kind === "search" && t.status === "running")?.currentStep ?? "…"}
          </p>
        )}
      </div>

      {/* 任务列表 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">任务列表</h2>
          <span className="text-[11px] text-slate-400">每 3 秒自动刷新 · 历史持久保存</span>
        </div>
        {!tasks.length ? (
          <p className="mt-3 text-xs text-slate-400">还没有任务。输入关键字创建第一个搜索采集任务。</p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {tasks.map((t) => {
              const badge = statusBadge(t.status);
              const running = t.status === "running";
              // 搜索任务：阶段①没有固定总数不画进度条；阶段②（评论，total>0）按 done/total 画
              const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : null;
              return (
                <div key={t.id} className="rounded-lg border border-slate-200 bg-slate-50">
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-slate-100"
                    onClick={() => void toggleTask(t.id)}
                    onKeyDown={(e) => e.key === "Enter" && void toggleTask(t.id)}
                  >
                    {expandedId === t.id ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    )}
                    <span className="text-xs font-semibold text-slate-700">#{t.id}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>
                      {badge.text}
                    </span>
                    <span className="text-[11px] text-slate-500">{kindLabel(t)}</span>
                    <span className="min-w-[150px] text-[11px] text-slate-600">{countersLabel(t)}</span>
                    {pct !== null && (
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full rounded-full transition-all ${running ? "bg-sky-500" : "bg-emerald-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                    {running && t.currentStep && (
                      <span className="text-[11px] font-medium text-sky-600">{t.currentStep}</span>
                    )}
                    {!running && t.error && (
                      <span className="max-w-[260px] truncate text-[11px] text-rose-500" title={t.error}>
                        {t.error}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-slate-400">
                      {t.finishedAt
                        ? `结束 ${new Date(t.finishedAt).toLocaleTimeString()}`
                        : `开始 ${new Date(t.createdAt ?? "").toLocaleTimeString()}`}
                    </span>
                    {running && (
                      <button
                        type="button"
                        className="rounded p-1 text-rose-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                        title={`停止任务 #${t.id}（跑完当前商品后退出）`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleStop(t);
                        }}
                      >
                        <Square className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {!running && (
                      <span className="flex items-center gap-0.5">
                        <button
                          type="button"
                          className="rounded p-1 text-slate-300 transition-colors hover:bg-sky-50 hover:text-sky-600"
                          title="重新采集该任务失败的商品（在原任务上续跑，不新建任务）"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRetry(t);
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
                          title="删除任务（级联删除其产出的商品与评论文件）"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(t);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  {expandedId === t.id && (
                    <div className="border-t border-slate-200 px-3 py-2">
                      {!taskItems.length ? (
                        <p className="py-1 text-[11px] text-slate-400">
                          {t.kind === "search"
                            ? t.total > 0
                              ? "评论阶段明细加载中…"
                              : "商品阶段无固定清单 —— 采到的商品见「竞品商品」页（按关键字标签过滤）；评论阶段开始后这里会显示逐商品进度。"
                            : "无明细"}
                        </p>
                      ) : (
                        <ul className="divide-y divide-slate-100">
                          {taskItems.map((it) => (
                            <li
                              key={`${it.shopId}_${it.itemId}`}
                              className="flex items-center gap-2 py-1.5 text-[11px]"
                            >
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
                                {it.status === "done"
                                  ? "完成"
                                  : it.status === "failed"
                                    ? "失败"
                                    : it.status === "running"
                                      ? "采集中"
                                      : "待采"}
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

export default CollectTasksPage;
