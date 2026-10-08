/**
 * 登录接口：/api/auth
 *
 * 账号是原型阶段的固定账号（test/123456），可用环境变量覆盖 —— 等真的要
 * 多用户时再引入账号存储，那时 login 的实现换掉、verifyToken 不用动。
 *
 * 免鉴权的只有 /login 本身；/me 在 requireApiAuth 的豁免名单之外 ——
 * 它就是用来校验 token 的，自己拦自己没意义，所以中间件放行了它
 * （见 index.ts），校验逻辑在这里做。
 */
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { bearerOf, issueToken, verifyToken } from "../auth/session";

/** 固定账号。env 覆盖入口留给将来改账号不用改代码 */
const AUTH_USERNAME = process.env.AUTH_USERNAME ?? "test";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? "123456";

export const authRouter = Router();

authRouter.post("/login", (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  // 原型阶段直接明文比较 —— 账号是公开的演示账号，不构成新的攻击面
  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    res.status(401).json({ error: "用户名或密码不正确" });
    return;
  }
  const { token, expiresAt } = issueToken(username);
  res.json({ token, username, expiresAt });
});

/** 前端恢复会话时校验 token。校验失败返回 401，前端据此清掉本地会话 */
authRouter.get("/me", (req: Request, res: Response) => {
  const claims = verifyToken(bearerOf(req.headers.authorization));
  if (!claims) {
    res.status(401).json({ error: "登录已过期，请重新登录" });
    return;
  }
  res.json(claims);
});

/**
 * 全局 API 鉴权。
 *
 * 豁免名单的口径：
 *  - /health：探活端点，无敏感信息；Shopee 插件弹窗靠它显示在线灯
 *  - /auth/login：登录本身
 *  - /auth/me：自己校验自己（校验逻辑在上面）
 *  - /sourcing/collect、/sourcing/lookup、/competitor/ingest：浏览器插件的上报面，
 *    插件请求不带本会话 token，它们各自有自己的准入控制（X-Collect-Token / 免鉴权决策）
 */
const PUBLIC_PATHS = [
  "/health",
  "/auth/login",
  "/auth/me",
  "/sourcing/collect",
  "/sourcing/lookup",
  "/competitor/ingest",
];

export const requireApiAuth: RequestHandler = (req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) {
    next();
    return;
  }
  const claims = verifyToken(bearerOf(req.headers.authorization));
  if (!claims) {
    res.status(401).json({ error: "未登录或登录已过期" });
    return;
  }
  // 用户名挂到请求上，留给将来做操作审计用
  (req as Request & { authUser?: string }).authUser = claims.username;
  next();
};
