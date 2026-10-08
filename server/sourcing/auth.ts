/**
 * 采集接口的写入令牌。
 *
 * 采集是一个**写接口**，不能裸奔：一旦这个服务从 localhost 挪到公网，
 * 没有这道门它就是一个任何人都能往里灌数据的开放写入点。
 *
 * 令牌来源优先级：
 *  1. 环境变量 `SOURCING_COLLECT_TOKEN` —— 部署时用这个；
 *  2. 数据目录下的 collect-token.txt —— 首次运行时随机生成并落盘。
 *
 * 为什么不在缺省时用一个固定的 "dev" 之类弱令牌：那种默认值最终一定会
 * 被带进生产。随机生成 + 落盘既没有弱默认，又不用每次重启重新填一遍 ——
 * 令牌在控制台打印一次，复制到扩展设置页即可。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { SOURCING_DATA_DIR } from "./client";

const TOKEN_FILE = path.join(SOURCING_DATA_DIR, "collect-token.txt");

let cached: string | null = null;

export function getCollectToken(): string {
  if (cached) return cached;

  const fromEnv = process.env.SOURCING_COLLECT_TOKEN?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) {
      cached = existing;
      return cached;
    }
  } catch {
    /* 首次运行，文件还不存在 */
  }

  const token = randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(SOURCING_DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (error) {
    // 写不了盘就退化成「每次启动一个新令牌」，但要把原因说出来
    console.warn(`[sourcing] 令牌文件写入失败，本次启动的令牌是临时的: ${error}`);
  }

  cached = token;
  return cached;
}

/** 定长比较，避免用 === 比较令牌时泄漏前缀信息 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 校验 `X-Collect-Token` 头。
 *
 * 只保护写入类接口（collect / reingest / delete）；列表与详情是只读的，
 * 保持开放，方便直接在浏览器里查看到底采到了什么。
 */
export const requireCollectToken: RequestHandler = (req, res, next) => {
  const provided = req.header("X-Collect-Token")?.trim() ?? "";
  if (!provided || !safeEqual(provided, getCollectToken())) {
    res.status(401).json({ error: "采集令牌无效，请在扩展设置页填写正确的 token" });
    return;
  }
  next();
};

/** 启动时打印一次，供开发者复制到扩展设置页 */
export function describeCollectToken(): string {
  if (process.env.SOURCING_COLLECT_TOKEN?.trim()) {
    return "采集令牌来自环境变量 SOURCING_COLLECT_TOKEN";
  }
  return `采集令牌: ${getCollectToken()}\n  （已写入 ${TOKEN_FILE}，粘贴到扩展设置页即可）`;
}
