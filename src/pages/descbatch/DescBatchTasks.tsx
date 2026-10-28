/**
 * 描述改写任务页。
 *
 * 流程：上传 ERP 导出表（自动按产品 ID 排重）→ 编辑提示词 → 开始处理
 * （后台调 LLM，进度实时轮询）→ 全部完成后导出「批量修改详情导入模板」。
 * 导出按钮在任务未全部完成时禁用 —— 门禁做在前后端两层。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Plus, RefreshCw, Settings2, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/src/components/shared/PageHeader";
import { ConfirmDialog } from "@/src/components/shared/ConfirmDialog";
import { useToast } from "@/src/components/shared/Toast";
import { Button } from "@/src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Textarea } from "@/src/components/ui/textarea";
import { useApi } from "@/src/hooks/useApi";
import { api, type DescTask } from "@/src/lib/api";
import { formatRelative } from "@/src/lib/format";
import { cn } from "@/src/lib/utils";

const STATUS_META: Record<DescTask["status"], { label: string; cls: string }> = {
  pending: { label: "待处理", cls: "bg-slate-100 text-slate-600" },
  running: { label: "处理中", cls: "bg-blue-50 text-blue-700" },
  done: { label: "已完成", cls: "bg-emerald-50 text-emerald-700" },
  failed: { label: "部分失败", cls: "bg-rose-50 text-rose-700" },
};

export default function DescBatchTasks() {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DescTask | null>(null);
  /** 待确认「全量重跑」的任务 —— 会覆盖已有改写结果，需要用户确认 */
  const [pendingRerun, setPendingRerun] = useState<DescTask | null>(null);
  /** 正在编辑提示词的任务；promptDraft 与弹窗输入绑定 */
  const [editing, setEditing] = useState<DescTask | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<{ hasKey: boolean; model: string }>({ hasKey: false, model: "" });
  const [keyInput, setKeyInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [testing, setTesting] = useState(false);

  const { data, loading, error, reload } = useApi(() => api.listDescTasks(), []);
  const tasks = data?.items ?? [];
  const hasRunning = tasks.some((t) => t.status === "running");

  // 有任务在跑时 3s 轮询进度；全部静止后停轮询
  const refresh = useCallback(() => void reload(), [reload]);
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [hasRunning, refresh]);

  useEffect(() => {
    if (settingsOpen) {
      void api.getDescSettings().then(({ data: s }) => {
        setSettings(s);
        setModelInput(s.model);
        setKeyInput("");
      }).catch(() => undefined);
    }
  }, [settingsOpen]);

  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const buffer = await file.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        const { data: task } = await api.createDescTask(file.name, base64);
        toast.success(`已创建任务 #${task.id}，解析出 ${task.total} 个产品`);
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "上传失败");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [refresh, toast]
  );

  const openPromptEditor = (task: DescTask) => {
    setEditing(task);
    setPromptDraft(task.prompt);
  };

  const savePrompt = async () => {
    if (!editing) return;
    setSavingPrompt(true);
    try {
      await api.updateDescPrompt(editing.id, promptDraft.trim());
      toast.success(`任务 #${editing.id} 提示词已保存`);
      setEditing(null);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingPrompt(false);
    }
  };

  const runTask = async (task: DescTask, reset = false) => {
    try {
      await api.runDescTask(task.id, reset);
      toast.success(reset ? `任务 #${task.id} 全量重跑中（结果将按当前提示词覆盖）` : `任务 #${task.id} 开始处理`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "启动失败");
    }
  };

  const deleteTask = async (task: DescTask) => {
    if (!pendingDelete) return;
    try {
      await api.deleteDescTask(task.id);
      toast.success(`已删除任务 #${task.id}`);
      setPendingDelete(null);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
      setPendingDelete(null);
    }
  };

  const exportTask = async (task: DescTask) => {
    try {
      // 下载要带 Authorization 头，不能走 <a href>，用 fetch + blob
      const session = (await import("@/src/lib/auth")).getSession();
      const res = await fetch(`/api/descbatch/tasks/${task.id}/export`, {
        headers: session ? { Authorization: `Bearer ${session.token}` } : {},
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `导出失败 (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `批量修改详情导入模板_任务${task.id}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`任务 #${task.id} 导出成功`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败");
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const { data: s } = await api.saveDescSettings(keyInput.trim(), modelInput.trim());
      setSettings(s);
      toast.success("模型设置已保存");
      setSettingsOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingSettings(false);
    }
  };

  const testSettings = async () => {
    setTesting(true);
    try {
      const { data } = await api.testDescSettings();
      if (data.ok) toast.success(`连接正常，模型回复：${data.reply ?? ""}`);
      else toast.error(data.error ?? "连接失败");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };

  const canExport = (task: DescTask) => task.status === "done";

  return (
    <div className="space-y-4">
      <PageHeader
        title="描述改写"
        description="上传妙手导出的产品表，批量用大模型改写产品描述，导出后回导 ERP。"
        meta={
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" />
            模型设置{settings.hasKey ? "" : "（未配置 Key）"}
          </Button>
        }
      />

      {/* 上传卡片 */}
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <Button
            size="sm"
            className="h-9 gap-1.5"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {uploading ? "解析上传中…" : "上传 ERP 产品表"}
          </Button>
          <p className="text-xs text-slate-500">
            支持「导出#SKU_*.xlsx」格式，自动按产品 ID 排重（同一产品多 SKU 行只改写一次）
          </p>
          <Plus className="ml-auto h-4 w-4 text-slate-300" />
        </div>
      </div>

      {/* 任务表 */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
              <th className="px-4 py-2.5">导入文件名</th>
              <th className="px-4 py-2.5">进度</th>
              <th className="px-4 py-2.5">状态</th>
              <th className="px-4 py-2.5">创建时间</th>
              <th className="px-4 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const meta = STATUS_META[task.status];
              return (
                <tr key={task.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <p className="max-w-[280px] truncate font-medium text-slate-800" title={task.filename}>
                      {task.filename}
                    </p>
                    <p className="text-[11px] text-slate-400">任务 #{task.id}</p>
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-slate-600">
                    {task.done}/{task.total}
                    {task.failed > 0 && (
                      <span className="ml-1.5 text-rose-500">{task.failed} 失败</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", meta.cls)}>
                      {meta.label}
                    </span>
                    {task.error && (
                      <p className="mt-1 max-w-[240px] truncate text-[11px] text-rose-500" title={task.error}>
                        {task.error}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatRelative(task.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-slate-600"
                        title="编辑本任务的提示词"
                        onClick={() => openPromptEditor(task)}
                      >
                        提示词编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-slate-600"
                        title={
                          task.failed > 0 && task.done > 0
                            ? "只补跑失败的明细，已完成的不动（省 token）"
                            : "开始调 LLM 逐条改写"
                        }
                        disabled={task.status === "running" || task.running}
                        onClick={() => void runTask(task, false)}
                      >
                        <Play className="mr-1 h-3 w-3" />
                        {task.failed > 0 && task.done > 0 ? "继续处理" : "开始处理"}
                      </Button>
                      {task.done > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-slate-600"
                          title="清空已有改写结果，按当前提示词全部重新生成"
                          disabled={task.status === "running" || task.running}
                          onClick={() => setPendingRerun(task)}
                        >
                          <RefreshCw className="mr-1 h-3 w-3" />
                          重跑全部
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={!canExport(task)}
                        title={canExport(task) ? "导出批量修改详情导入模板" : "全部产品处理完成后才能导出"}
                        onClick={() => void exportTask(task)}
                      >
                        导出
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-slate-400 hover:text-rose-600"
                        title="删除任务"
                        onClick={() => setPendingDelete(task)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!tasks.length && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                  {loading ? "加载中…" : error ? `加载失败：${error}` : "还没有任务，先上传一份 ERP 导出的产品表"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 提示词编辑弹窗 */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>提示词编辑 — 任务 #{editing?.id}</DialogTitle>
            <DialogDescription>
              只作用于本任务。改完提示词后想全部重新生成，请点任务行的「重跑全部」；只想补跑失败行则点「继续处理」。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={14}
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button disabled={savingPrompt || !promptDraft.trim()} onClick={() => void savePrompt()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 模型设置弹窗 */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>模型设置</DialogTitle>
            <DialogDescription>智谱 GLM 接口配置。Key 保存在本机服务端，不会上传。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="apikey">API Key</Label>
              <Input
                id="apikey"
                type="password"
                placeholder={settings.hasKey ? "已配置（留空则不修改）" : "粘贴智谱 API Key"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model">模型</Label>
              <Input id="model" value={modelInput} onChange={(e) => setModelInput(e.target.value)} />
            </div>
          </div>
          <DialogFooter className="flex! justify-between">
            <Button variant="outline" disabled={testing} onClick={() => void testSettings()}>
              {testing ? "测试中…" : "测试连接"}
            </Button>
            <Button disabled={savingSettings} onClick={() => void saveSettings()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 全量重跑确认：会覆盖已有改写结果 */}
      <ConfirmDialog
        open={!!pendingRerun}
        onOpenChange={(open) => !open && setPendingRerun(null)}
        title="全量重跑"
        description={
          pendingRerun
            ? `将清空任务 #${pendingRerun.id} 已有的 ${pendingRerun.done} 条改写结果，按当前提示词重新生成全部 ${pendingRerun.total} 条（消耗 token）。确定继续？`
            : undefined
        }
        confirmLabel="重跑全部"
        onConfirm={() => (pendingRerun ? runTask(pendingRerun, true) : undefined)}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="删除任务"
        description={
          pendingDelete
            ? `将删除任务 #${pendingDelete.id}（${pendingDelete.filename}）及其全部改写结果，该操作不可撤销。`
            : undefined
        }
        confirmLabel="确认删除"
        destructive
        onConfirm={() => (pendingDelete ? deleteTask(pendingDelete) : undefined)}
      />
    </div>
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
