/**
 * 描述改写接口：/api/descbatch
 *
 * 流程：上传 ERP 导出表建任务 → 编辑提示词 → 开始处理（后台跑 LLM）
 * → 全部完成后导出「批量修改详情导入模板」xlsx。
 * 导出有门禁：有任何明细未完成就拒绝，防止把空描述灌回 ERP。
 */
import { Router } from "express";
import { getDb } from "../descbatch/client";
import { buildExportBuffer } from "../descbatch/exporter";
import { parseErpExport } from "../descbatch/ingest";
import { callLlm, loadConfig, saveConfig } from "../descbatch/llm";
import { DEFAULT_PROMPT, isTaskRunning, startTask } from "../descbatch/runner";
import { handle, int } from "../lib/params";

export const descBatchRouter = Router();

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 建任务：body 为 {filename, dataBase64}。xlsx 二进制走 base64 过 JSON，省掉 multipart 依赖 */
descBatchRouter.post(
  "/tasks",
  handle(async (req, res) => {
    const { filename, dataBase64 } = (req.body ?? {}) as { filename?: string; dataBase64?: string };
    if (!filename || !dataBase64) {
      res.status(400).json({ error: "缺少 filename 或 dataBase64" });
      return;
    }
    const products = await parseErpExport(Buffer.from(dataBase64, "base64"));

    const db = getDb();
    const now = nowStamp();
    const result = db
      .prepare("INSERT INTO tasks (filename, status, prompt, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)")
      .run(filename, DEFAULT_PROMPT, now, now);
    const taskId = Number(result.lastInsertRowid);
    const insert = db.prepare(
      "INSERT INTO items (task_id, product_id, title, category, original) VALUES (?, ?, ?, ?, ?)",
    );
    for (const p of products) {
      insert.run(taskId, p.productId, p.title || null, p.category || null, p.original);
    }
    db.prepare("UPDATE tasks SET total = ? WHERE id = ?").run(products.length, taskId);

    res.json(getTask(taskId));
  }),
);

descBatchRouter.get(
  "/tasks",
  handle((_req, res) => {
    const tasks = getDb()
      .prepare("SELECT * FROM tasks ORDER BY id DESC")
      .all();
    res.json({ items: tasks.map(withRuntimeFlag) });
  }),
);

/** 提取并校验路径参数 id，非法直接回 400 并返回 null */
function pathId(req: { params: Record<string, string> }): number | null {
  const id = int(req.params.id);
  if (id === undefined || id < 1) {
    return null;
  }
  return id;
}

descBatchRouter.get(
  "/tasks/:id",
  handle((req, res) => {
    const id = pathId(req);
    if (id === null) {
      res.status(400).json({ error: "任务 id 非法" });
      return;
    }
    const task = getTask(id);
    if (!task) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json(task);
  }),
);

/** 任务明细预览（改写结果抽查用） */
descBatchRouter.get(
  "/tasks/:id/items",
  handle((req, res) => {
    const id = pathId(req);
    if (id === null) {
      res.status(400).json({ error: "任务 id 非法" });
      return;
    }
    const rows = getDb()
      .prepare(
        "SELECT id, product_id, title, original, rewritten, status, error FROM items WHERE task_id = ? ORDER BY id",
      )
      .all(id);
    res.json({ items: rows });
  }),
);

descBatchRouter.put(
  "/tasks/:id/prompt",
  handle((req, res) => {
    const id = pathId(req);
    if (id === null) {
      res.status(400).json({ error: "任务 id 非法" });
      return;
    }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) {
      res.status(400).json({ error: "提示词不能为空" });
      return;
    }
    const db = getDb();
    const result = db
      .prepare("UPDATE tasks SET prompt = ?, updated_at = ? WHERE id = ?")
      .run(prompt, nowStamp(), id);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json(getTask(id));
  }),
);

/**
 * 开始处理。body {reset:true} = 全量重跑（清空已有改写结果，按当前提示词重新生成）；
 * 否则续跑：只跑 pending+failed 的明细，已完成的保留（省 token）。
 */
descBatchRouter.post(
  "/tasks/:id/run",
  handle((req, res) => {
    const id = pathId(req);
    if (id === null) {
      res.status(400).json({ error: "任务 id 非法" });
      return;
    }
    const task = getTask(id);
    if (!task) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    const body = (req.body ?? {}) as { reset?: unknown };
    const reset = body.reset === true;
    if (!startTask(id, reset)) {
      res.status(409).json({ error: "该任务正在处理中" });
      return;
    }
    res.json({ ok: true, reset });
  }),
);

descBatchRouter.delete(
  "/tasks/:id",
  handle((req, res) => {
    const id = pathId(req);
    if (id === null) {
      res.status(400).json({ error: "任务 id 非法" });
      return;
    }
    if (isTaskRunning(id)) {
      res.status(409).json({ error: "任务正在处理中，请等处理完成后再删除" });
      return;
    }
    const result = getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json({ ok: true });
  }),
);

/** 导出「批量修改详情导入模板」xlsx。门禁：全部明细 done 才放行 */
descBatchRouter.get(
  "/tasks/:id/export",
  handle(async (req, res) => {
    const id = pathId(req);
    if (id === null) {
      res.status(400).json({ error: "任务 id 非法" });
      return;
    }
    const task = getTask(id);
    if (!task) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    try {
      const buffer = await buildExportBuffer(id);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`批量修改详情导入模板_任务${id}.xlsx`)}`,
      );
      res.end(buffer);
    } catch (error) {
      res.status(409).json({ error: String(error).replace(/^Error:\s*/, "").slice(0, 300) });
    }
  }),
);

/* ---------------- 模型设置 ---------------- */

descBatchRouter.get(
  "/settings",
  handle((_req, res) => {
    const { apiKey, model } = loadConfig();
    // key 不回传明文，只告诉前端有没有配过
    res.json({ hasKey: !!apiKey, model });
  }),
);

descBatchRouter.put(
  "/settings",
  handle((req, res) => {
    const { apiKey, model } = (req.body ?? {}) as { apiKey?: string; model?: string };
    const current = loadConfig();
    saveConfig({
      // apiKey 传空串/缺省视为不修改，避免每次保存设置都要重贴 key
      apiKey: typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : current.apiKey,
      model: typeof model === "string" && model.trim() ? model.trim() : current.model,
    });
    const saved = loadConfig();
    res.json({ hasKey: !!saved.apiKey, model: saved.model });
  }),
);

/** 连通性自检：用一条极短的真实调用验证 key 和模型可用 */
descBatchRouter.post(
  "/settings/test",
  handle(async (_req, res) => {
    try {
      const reply = await callLlm("你是连通性测试。", "只回复两个字：正常");
      res.json({ ok: true, reply: reply.slice(0, 20) });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error).replace(/^Error:\s*/, "").slice(0, 300) });
    }
  }),
);

/* ---------------- 内部 ---------------- */

function getTask(id: number): Record<string, unknown> | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? withRuntimeFlag(row as Record<string, unknown>) : null;
}

function withRuntimeFlag(task: Record<string, unknown>): Record<string, unknown> {
  return { ...task, running: isTaskRunning(Number(task.id)) };
}
