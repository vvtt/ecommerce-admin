/**
 * 登录会话：HMAC 签名的无状态 token。
 *
 * 原型阶段的定位是「挡住随手打开页面的人」，不是安全产品 —— 所以用固定
 * 账号 + HMAC token，不引入用户表与数据库。签名不可伪造，token 泄露的
 * 影响面也仅限内网。
 *
 * 结构：base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload))，
 * payload = { u: 用户名, exp: 过期时间（epoch 秒） }。没有用 JWT 库 ——
 * 需要的只有「签名 + 过期」两件事，手写 20 行比引入依赖划算。
 *
 * secret 与 collect-token 同一套模式：环境变量优先，否则随机生成落盘，
 * 重启服务不变（否则每次重启都把所有登录用户踢下线）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SECRET_FILE = path.join(process.cwd(), "server", "auth-secret.txt");

/** token 有效期 7 天。过期后 401，前端会引导重新登录 */
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (process.env.AUTH_SECRET) {
    cachedSecret = process.env.AUTH_SECRET;
    return cachedSecret;
  }
  if (fs.existsSync(SECRET_FILE)) {
    cachedSecret = fs.readFileSync(SECRET_FILE, "utf-8").trim();
    if (cachedSecret) return cachedSecret;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, generated, "utf-8");
  cachedSecret = generated;
  return cachedSecret;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

function hmac(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export interface SessionClaims {
  username: string;
  /** 过期时间（epoch 秒） */
  expiresAt: number;
}

/** 登录成功后签发 token */
export function issueToken(username: string): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = base64url(JSON.stringify({ u: username, exp: expiresAt }));
  return { token: `${payload}.${hmac(payload)}`, expiresAt };
}

/** 校验 token。签名不匹配 / 已过期 / 结构不对都返回 null */
export function verifyToken(token: string | undefined | null): SessionClaims | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = hmac(payload);
  // 长度不同直接失败；等长再走恒时比较，防时序侧信道
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      u?: string;
      exp?: number;
    };
    if (!claims.u || typeof claims.exp !== "number") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return { username: claims.u, expiresAt: claims.exp };
  } catch {
    return null;
  }
}

/** 从 Authorization: Bearer <token> 头里提取 */
export function bearerOf(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7) || null;
}
