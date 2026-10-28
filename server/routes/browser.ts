/**
 * 弹出浏览器路由：纯 REST。
 *
 * 为什么不再用 WebSocket：旧内嵌方案要靠 WS 推截屏帧（每秒 10-20 帧）+
 * 回传鼠标键盘事件；改成弹出真窗口后用户直接在 Edge 里原生操作，服务端
 * 只剩「打开 URL / 查状态 / 关闭」这类低频控制指令，HTTP 轮询状态页足够。
 *
 * 鉴权：挂在全局 requireApiAuth 之后，走标准 Bearer token。
 */
import { Router } from "express";
import {
  closeBrowser,
  collectRatings,
  collectSearch,
  getRatingsBatchState,
  getStatus,
  openUrl,
  recheckExtensions,
  startRatingsBatch,
  startRatingsRetry,
  stopCollectTask,
  startSearchTask,
  stopRatingsBatch,
  stopSearchTask,
} from "../browser/manager";
import { deleteCollectTaskCascade, getCollectTaskItems, listCollectTasks } from "../competitor/repository";

export const browserRouter = Router();

/** 状态面板轮询：运行中/未运行、PID、CDP 端口、当前 URL、标签页列表 */
browserRouter.get("/status", (_req, res) => {
  res.json(getStatus());
});

/** 打开（或复用已有窗口）并导航到指定 URL */
browserRouter.post("/open", (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url.trim()) {
    res.status(400).json({ error: "缺少 url 参数" });
    return;
  }
  void openUrl(url)
    .then((status) => res.json(status))
    .catch((error: unknown) => {
      res.status(500).json({ error: String(error).slice(0, 300) });
    });
});

/** 手动重跑插件健康检查（结果随下次 /status 返回） */
browserRouter.post("/extensions/check", (_req, res) => {
  void recheckExtensions()
    .then(() => res.json(getStatus()))
    .catch((error: unknown) => {
      res.status(500).json({ error: String(error).slice(0, 300) });
    });
});

/** 关闭浏览器进程（优雅退出，失败兜底强杀进程树） */
browserRouter.post("/close", (_req, res) => {
  void closeBrowser()
    .then(() => res.json({ ok: true }))
    .catch((error: unknown) => {
      res.status(500).json({ error: String(error).slice(0, 300) });
    });
});

/**
 * 搜索批量采集：打开关键字搜索页并限速滚动（默认 5 屏，每屏随机等
 * 2.5~4.5 秒），页面自己发的搜索响应被服务端截获入库打标。
 * 耗时 = 5s 首屏 + 屏数 × (滚动 + 2.5~4.5s) + 3s 收尾，接口同步等待返回增量统计。
 */
browserRouter.post("/collect-search", (req, res) => {
  const keyword = typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";
  if (!keyword) {
    res.status(400).json({ error: "缺少 keyword 参数" });
    return;
  }
  const screensRaw = Number(req.body?.screens);
  const screens = Number.isInteger(screensRaw) ? Math.min(Math.max(screensRaw, 1), 30) : 5;
  void collectSearch(keyword, screens)
    .then((result) => res.json(result))
    .catch((error: unknown) => {
      res.status(500).json({ error: String(error).slice(0, 300) });
    });
});

/**
 * 评论批量采集：打开商品页 → 循环点「更多评论」直到翻尽（默认最多 20 页，
 * 每页随机 2~4 秒间隔）。评论追加写 data/reviews/{shop}_{item}.jsonl，
 * DB 只存路径与条数。PDP 详情接口同窗口内也会被截获补全商品字段。
 */
browserRouter.post("/collect-ratings", (req, res) => {
  const shopId = String(req.body?.shopId ?? "").trim();
  const itemId = String(req.body?.itemId ?? "").trim();
  if (!/^\d+$/.test(shopId) || !/^\d+$/.test(itemId)) {
    res.status(400).json({ error: "shopId/itemId 必须是数字 id" });
    return;
  }
  const pagesRaw = Number(req.body?.maxPages);
  const maxPages = Number.isInteger(pagesRaw) ? Math.min(Math.max(pagesRaw, 1), 100) : 20;
  void collectRatings(shopId, itemId, maxPages)
    .then((result) => res.json(result))
    .catch((error: unknown) => {
      res.status(500).json({ error: String(error).slice(0, 300) });
    });
});

/**
 * 批量评论采集：按标签（可选）捞出还没采过评论的商品快照，逐个自动采集
 * （评论 + PDP 商品详情一起截获入库）。任务持久化到 collect_tasks 表，
 * 返回 taskId；进度走 GET /status 的 ratingsBatch，明细走 GET /tasks/:id。
 * 重复启动返回 409。商品之间随机停 5~10 秒，命中验证码等人工过滑块。
 */
browserRouter.post("/collect-ratings-batch", (req, res) => {
  const tag = typeof req.body?.tag === "string" ? req.body.tag.trim() || undefined : undefined;
  const limitRaw = Number(req.body?.limit);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
  const mpRaw = Number(req.body?.maxPages);
  const maxPages = Number.isInteger(mpRaw) ? Math.min(Math.max(mpRaw, 1), 100) : 20;
  const cRaw = Number(req.body?.concurrency);
  const concurrency = Number.isInteger(cRaw) ? Math.min(Math.max(cRaw, 1), 3) : 2;
  const r = startRatingsBatch(tag, limit, maxPages, concurrency);
  if (!r.started) {
    res.status(409).json({ error: r.message });
    return;
  }
  res.json({ started: true, taskId: r.taskId, message: r.message });
});

/**
 * 重新采集指定任务里失败的评论商品：原任务复活续跑（不新建任务），
 * failed/僵死 running 明细重置回 pending，已在其他跑批补采的自动跳过。
 */
browserRouter.post("/collect-ratings-retry", (req, res) => {
  const taskId = Number(req.body?.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "taskId 必须是正整数" });
    return;
  }
  const mpRaw = Number(req.body?.maxPages);
  const maxPages = Number.isInteger(mpRaw) ? Math.min(Math.max(mpRaw, 1), 100) : 20;
  const cRaw = Number(req.body?.concurrency);
  const concurrency = Number.isInteger(cRaw) ? Math.min(Math.max(cRaw, 1), 3) : 2;
  const r = startRatingsRetry(taskId, maxPages, concurrency);
  if (!r.started) {
    res.status(409).json({ error: r.message });
    return;
  }
  res.json({ started: true, taskId: r.taskId, message: r.message });
});

/** 采集任务列表（最近 20 条）：历史进度 server 重启后依然可查 */
browserRouter.get("/tasks", (_req, res) => {
  res.json({ tasks: listCollectTasks(20) });
});

/** 任务明细：每个商品的状态/评论数/是否补全详情/失败原因 */
browserRouter.get("/tasks/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "任务 id 必须是数字" });
    return;
  }
  const tasks = listCollectTasks(100).filter((t) => t.id === id);
  if (!tasks.length) {
    res.status(404).json({ error: `任务 #${id} 不存在` });
    return;
  }
  res.json({ task: tasks[0], items: getCollectTaskItems(id) });
});

/** 停止指定任务：按 taskId 精确停止（任务行上的停止按钮用），非运行中返回 409 */
browserRouter.post("/tasks/:id/stop", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "任务 id 必须是正整数" });
    return;
  }
  const r = stopCollectTask(id);
  if (!r.stopped) {
    res.status(409).json({ error: r.message });
    return;
  }
  res.json({ ok: true, message: r.message });
});

/**
 * 删除采集任务并级联清理：商品行、标签、商品/评论/PDP 落盘文件、
 * 搜索 raw 快照（search 任务按关键字匹配）。「删任务 = 删它产出的全部数据」。
 * 运行中的任务不允许删（先停止）。
 */
browserRouter.delete("/tasks/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "任务 id 必须是数字" });
    return;
  }
  const tasks = listCollectTasks(100).filter((t) => t.id === id);
  if (!tasks.length) {
    res.status(404).json({ error: `任务 #${id} 不存在` });
    return;
  }
  if (tasks[0].status === "running") {
    res.status(409).json({ error: "任务正在运行，请先停止再删除" });
    return;
  }
  try {
    const r = deleteCollectTaskCascade(id);
    res.json({ ok: true, ...r });
  } catch (error: unknown) {
    res.status(500).json({ error: String(error).slice(0, 300) });
  }
});

/** 停止批量：不硬中断，跑完当前商品/当前屏后退出 */
browserRouter.post("/collect-ratings-batch/stop", (_req, res) => {
  stopRatingsBatch();
  res.json({ ok: true, state: getRatingsBatchState() });
});

/**
 * 创建搜索采集任务：输入关键字，自动打开 Shopee 搜索页限速滚动抓商品
 * （入库 + 打关键字标签）。任务落 collect_tasks 表，异步执行，
 * 进度轮询 GET /tasks。与评论批量互斥（共用同一个浏览器页）。
 */
browserRouter.post("/collect-search-task", (req, res) => {
  const keyword = typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";
  if (!keyword) {
    res.status(400).json({ error: "缺少 keyword 参数" });
    return;
  }
  const screensRaw = Number(req.body?.screens);
  // 0 / 缺省 = 不限屏数，翻到末页自然停止（collectSearch 内部有 60 页安全上限）
  const screens = Number.isInteger(screensRaw) ? Math.min(Math.max(screensRaw, 0), 60) : 0;
  // 采完商品自动续采评论（默认开）：评论阶段逐个商品走 PDP + get_ratings
  const autoRatings = req.body?.autoRatings === undefined ? true : req.body.autoRatings !== false;
  const rpRaw = Number(req.body?.ratingsPages);
  const ratingsPages = Number.isInteger(rpRaw) ? Math.min(Math.max(rpRaw, 1), 100) : 20;
  const cRaw = Number(req.body?.concurrency);
  // 评论阶段并发 worker 数（1~3）：默认 2，3 更快但风控一弹全停
  const concurrency = Number.isInteger(cRaw) ? Math.min(Math.max(cRaw, 1), 3) : 2;
  const r = startSearchTask(keyword, screens, autoRatings, ratingsPages, concurrency);
  if (!r.started) {
    res.status(409).json({ error: r.message });
    return;
  }
  res.json({ started: true, taskId: r.taskId, message: r.message });
});

browserRouter.post("/collect-search-task/stop", (_req, res) => {
  stopSearchTask();
  res.json({ ok: true });
});
