/**
 * 图片转存：把 1688 的图片下载到本地磁盘，转成自己能长期引用的地址。
 *
 * 为什么必须由服务端下载，而不是让扩展直接存：
 * 扩展发起的跨域请求**无法伪造 Referer**（浏览器不允许扩展设置该头），
 * 而 cbu01.alicdn.com 有防盗链。服务端 fetch 可以自己带 Referer，
 * 这是这条路走得通的前提。
 *
 * 为什么异步：一个商品十几张图，同步下载会把扩展的请求挂十几秒。
 * 所以上报接口立即返回、图在后台下，状态先落 pending。
 */
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "./client";
import {
  listImagesByOffer,
  listOffersWithPendingImages,
  markImageResult,
  refreshOfferImageStatus,
} from "./repository";
import { shortHash } from "./repository";
import type { ImageStatus } from "../../src/types";

/**
 * cbu01.alicdn.com 的防盗链是**黑名单式**的：拦的是「Referer 不对」，空 Referer 放行。
 * 实测（见 docs/1688-probe.md 第 6 节）：
 *   无 Referer                 → 200 image/png
 *   Referer: detail.1688.com   → 200 image/png
 *   Referer: 无关站点           → 403 text/html
 * 所以这里不是「CDN 认这个 Referer」，而是「带它不会被判成盗链」。
 * 不带也行，带上更明确地表明来源。
 */
const REFERER = "https://detail.1688.com/";

/** 部分 CDN 按 UA 拦截非浏览器请求 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;
/** 单张图的体积上限，防止异常响应把磁盘写满 */
const MAX_BYTES = 20 * 1024 * 1024;
/** 并发数。太大容易被 CDN 限流，太小则慢 */
const CONCURRENCY = 3;

/**
 * 1688 返回的图片地址常是协议相对形式（`//cbu01...`），
 * 直接丢给 fetch 会报 Invalid URL，必须补上协议。
 */
export function normalizeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

/** 对外可访问的路径；与 server/index.ts 的 /uploads 静态挂载对应 */
const publicPathFor = (offerId: string, filename: string) => `/uploads/${offerId}/${filename}`;

/** 磁盘路径；offerId 来自我们自己生成的主键，这里仍做一次净化以防万一 */
function diskDirFor(offerId: string): string {
  const safe = offerId.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(UPLOAD_DIR, safe);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
};

/** 从 URL 路径猜扩展名，用于响应没给 content-type 的兜底 */
function extFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return /^\.(jpg|jpeg|png|webp|gif|avif|bmp)$/.test(ext) ? ext : ".jpg";
  } catch {
    return ".jpg";
  }
}

interface DownloadResult {
  status: ImageStatus;
  localPath?: string;
  bytes?: number;
  error?: string;
}

/**
 * 下载单张图。
 *
 * 关键防线：**必须校验响应的 content-type 真的是图片**。
 * 防盗链/CDN 异常时常常返回 200 + 一页 HTML 错误页，
 * 只看 res.ok 会把 HTML 当图片存成 .jpg，还标记成功。
 */
async function downloadImage(offerId: string, sourceUrl: string): Promise<DownloadResult> {
  const url = normalizeImageUrl(sourceUrl);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Referer: REFERER, "User-Agent": USER_AGENT, Accept: "image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: `请求失败: ${reason}` };
  }

  if (!response.ok) {
    return { status: "failed", error: `HTTP ${response.status}` };
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    return {
      status: "failed",
      error: `非图片响应 (content-type: ${contentType || "空"})，通常是防盗链拦截`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: `读取响应体失败: ${reason}` };
  }

  if (!buffer.length) {
    return { status: "failed", error: "响应体为空" };
  }
  if (buffer.length > MAX_BYTES) {
    return { status: "failed", error: `文件过大 (${Math.round(buffer.length / 1024 / 1024)}MB)` };
  }

  const ext = EXT_BY_MIME[contentType] ?? extFromUrl(url);
  // 文件名取源 URL 的哈希：同图重复出现时天然复用同一份文件
  const filename = `${shortHash(sourceUrl)}${ext}`;

  try {
    const dir = diskDirFor(offerId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: `写盘失败: ${reason}` };
  }

  return { status: "ok", localPath: publicPathFor(offerId, filename), bytes: buffer.length };
}

/** 简单并发池：按 limit 个一批处理，批内并行、批间串行 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
}

/**
 * 清理该 offer 目录下已不再被任何图片行引用的文件。
 *
 * 重复采集时图片清单可能变短（供应商换了详情图），旧文件就没人引用了。
 * 文件名是源 URL 的哈希，所以「被引用」可以直接用文件名集合判断。
 * 不做这一步的话，孤儿文件会一直堆在磁盘上。
 */
function pruneOrphanFiles(offerId: string): number {
  const dir = diskDirFor(offerId);
  if (!fs.existsSync(dir)) return 0;

  const referenced = new Set(
    listImagesByOffer(offerId)
      .filter((row) => row.local_path)
      .map((row) => path.basename(row.local_path)),
  );

  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (referenced.has(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed++;
    } catch {
      /* 删不掉就算了，不影响主流程 */
    }
  }
  return removed;
}

/** 实际的转存过程 */
async function runIngest(offerId: string): Promise<{ ok: number; failed: number }> {
  const pending = listImagesByOffer(offerId).filter((row) => row.status === "pending");

  let ok = 0;
  let failed = 0;

  if (pending.length) {
    const results = await mapWithConcurrency(pending, CONCURRENCY, (row) =>
      downloadImage(offerId, row.source_url),
    );
    results.forEach((result, i) => markImageResult(pending[i].id, result));
    ok = results.filter((r) => r.status === "ok").length;
    failed = results.length - ok;
  }

  // 这两步无论有没有待办都要跑：
  //  - 清理：重采后不再引用的文件，此时没有任何 pending 图，早退的话就永远清不掉
  //  - 刷状态：上次进程被杀时主表可能没来得及更新，这里顺手纠正
  pruneOrphanFiles(offerId);
  refreshOfferImageStatus(offerId);

  return { ok, failed };
}

/**
 * 转存中的 offer → 该次转存的 Promise。
 *
 * 存 Promise 而不是用一个 Set 占位：上报触发的后台转存与「重新转存」按钮
 * 很容易撞在一起，后来者应该 **await 前一次的结果**，而不是拿到一个
 * 空手而归的 {ok:0,failed:0} —— 那会让 reingest-sync 谎称「已完成」。
 */
const inFlight = new Map<string, Promise<{ ok: number; failed: number }>>();

/**
 * 转存某个 offer 下所有 pending 的图片。
 *
 * 同一 offer 并发调用时复用在跑的那次，返回的始终是真实结果。
 */
export function ingestOfferImages(offerId: string): Promise<{ ok: number; failed: number }> {
  const running = inFlight.get(offerId);
  if (running) return running;

  const task = runIngest(offerId);
  inFlight.set(offerId, task);

  // finally 会派生一个新 Promise，它若 rejected 且无人处理会触发
  // unhandledRejection，所以补一个 catch 把它吃掉（原始 task 仍会向调用方抛）
  void task
    .finally(() => {
      if (inFlight.get(offerId) === task) inFlight.delete(offerId);
    })
    .catch(() => {});

  return task;
}

/**
 * 只等、不触发：若该 offer 正在转存则等它结束，否则立即返回。
 *
 * 「重新转存」需要先重置图片状态再跑，而重置必须等上一次跑完 ——
 * 否则上一次的结果会覆盖掉刚重置出来的 pending，重试就静默失效了。
 */
export async function awaitInFlight(offerId: string): Promise<void> {
  const running = inFlight.get(offerId);
  if (running) await running.catch(() => {});
}

/**
 * 不等待结果的转存触发，供上报接口使用。
 *
 * 必须把 rejection 吃掉：这是游离的 Promise，一旦抛出未捕获异常
 * 会直接终止 Node 进程（Node 15+ 默认行为）。
 */
export function scheduleIngest(offerId: string): void {
  void ingestOfferImages(offerId).catch((error) => {
    console.error(`[sourcing] 图片转存失败 offer=${offerId}`, error);
  });
}

/**
 * 启动时捞回卡在 pending 的图片。
 *
 * 场景：上次进程在上报后、转存完成前被杀，主表和图片行都停在 pending，
 * 而不会再有新的上报来触发它们。启动时补跑一轮即可自愈。
 */
export async function ingestStuckPending(): Promise<void> {
  const offers = listOffersWithPendingImages();
  if (!offers.length) return;

  console.log(`[sourcing] 发现 ${offers.length} 条货源的图片未转存完，开始补跑`);
  for (const offer of offers) {
    await ingestOfferImages(offer.id);
  }
  console.log("[sourcing] 图片补跑完成");
}

/** 删除货源时清掉它的整个图片目录 */
export function removeOfferFiles(offerId: string): void {
  fs.rmSync(diskDirFor(offerId), { recursive: true, force: true });
}
