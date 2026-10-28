/**
 * 任务执行器：逐产品调 LLM 改写描述，进度实时写库。
 *
 * 单进程内每个任务同时只跑一个实例（内存 guard）。两种跑法：
 * - 续跑（reset=false）：只处理 pending/failed 的明细，已完成的保留，省 token；
 * - 全量重跑（reset=true）：先把所有明细重置为 pending 再跑 —— 改了提示词后
 *   想让全部产品按新提示词重新生成时用，已有改写结果会被覆盖。
 * 处理是 fire-and-forget 的：接口立刻返回，前端轮询任务列表看进度。
 */
import { getDb } from "./client";
import { callLlm } from "./llm";

/** 默认提示词：建任务时写入，用户可随时编辑覆盖 */
export const DEFAULT_PROMPT = `你是跨境电商 Shopee 台湾站的产品文案助手。请根据产品标题、类目和原描述，重写一份更好的产品描述。

要求：
1. 原描述里的事实信息（材质、品牌、尺寸、功能、颜色等）必须完整保留，不允许编造
2. 保留「键：值」逐行的结构，可适当补充有吸引力的卖点行
3. 语言简洁、符合台湾买家的阅读习惯
4. 只输出新描述正文，不要任何解释、前后缀或代码块`;

const runningTasks = new Set<number>();

export function isTaskRunning(taskId: number): boolean {
  return runningTasks.has(taskId);
}

/** 启动任务处理。reset=true 时先清空已有改写结果全量重跑。已在跑返回 false */
export function startTask(taskId: number, reset = false): boolean {
  if (runningTasks.has(taskId)) return false;
  if (reset) {
    getDb()
      .prepare(
        "UPDATE items SET status = 'pending', rewritten = NULL, error = NULL WHERE task_id = ?",
      )
      .run(taskId);
  }
  runningTasks.add(taskId);
  void processTask(taskId).finally(() => runningTasks.delete(taskId));
  return true;
}

async function processTask(taskId: number): Promise<void> {
  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
    | { id: number; prompt: string; status: string }
    | undefined;
  if (!task) return;

  db.prepare("UPDATE tasks SET status = 'running', error = NULL, updated_at = ? WHERE id = ?").run(
    nowStamp(),
    taskId,
  );

  const items = db
    .prepare("SELECT id, product_id, title, category, original FROM items WHERE task_id = ? AND status != 'done' ORDER BY id")
    .all(taskId) as { id: number; product_id: string; title: string | null; category: string | null; original: string }[];

  for (const item of items) {
    const userContent = [
      item.title ? `产品标题：${item.title}` : "",
      item.category ? `产品类目：${item.category}` : "",
      `原描述：\n${item.original}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const rewritten = await callLlm(task.prompt, userContent);
      db.prepare("UPDATE items SET rewritten = ?, status = 'done', error = NULL WHERE id = ?").run(
        rewritten,
        item.id,
      );
    } catch (error) {
      db.prepare("UPDATE items SET status = 'failed', error = ? WHERE id = ?").run(
        String(error).slice(0, 500),
        item.id,
      );
    }
    // 每条处理完都刷新任务计数，前端轮询能实时看到进度
    refreshCounts(taskId);
  }

  finishTask(taskId);
}

function refreshCounts(taskId: number): void {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM items WHERE task_id = ?`,
    )
    .get(taskId) as { total: number; done: number | null; failed: number | null };
  db.prepare("UPDATE tasks SET total = ?, done = ?, failed = ?, updated_at = ? WHERE id = ?").run(
    row.total,
    row.done ?? 0,
    row.failed ?? 0,
    nowStamp(),
    taskId,
  );
}

function finishTask(taskId: number): void {
  const db = getDb();
  refreshCounts(taskId);
  const task = db.prepare("SELECT total, done, failed FROM tasks WHERE id = ?").get(taskId) as {
    total: number;
    done: number;
    failed: number;
  };
  if (task.done === task.total) {
    db.prepare("UPDATE tasks SET status = 'done', error = NULL, updated_at = ? WHERE id = ?").run(
      nowStamp(),
      taskId,
    );
  } else {
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      `${task.failed}/${task.total} 条改写失败，可修复后重新处理（已完成的不会重跑）`,
      nowStamp(),
      taskId,
    );
  }
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
