/**
 * 前端登录会话。
 *
 * token 存 localStorage（原型阶段单机内网工具，XSS 面就是自家代码，不引入
 * cookie 方案的复杂度）。API 层（api.ts）每次请求带上它，401 时清会话跳登录。
 *
 * 本文件不 import api.ts —— login 自己发请求（登录接口不能带旧 token，
 * 也不该走 api.ts 的离线兜底），否则两个模块互相依赖。
 */

const SESSION_KEY = "authSession";

export interface AuthSession {
  token: string;
  username: string;
  /** 过期时间（epoch 秒），由服务端签发 */
  expiresAt: number;
}

export function getSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!session.token || !session.username || typeof session.expiresAt !== "number") return null;
    // 本地过期预判：不用等一次必然 401 的请求才发现过期
    if (session.expiresAt <= Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

export function setSession(session: AuthSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * 登录。网络失败 / 账号错误都直接抛错给表单展示，不走离线兜底 ——
 * 「登录成功」这件事在服务端不可达时是无意义的，伪造它没有价值。
 */
export async function login(username: string, password: string): Promise<AuthSession> {
  let res: Response;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error("无法连接服务，请确认 npm run dev 已启动");
  }

  const payload = (await res.json().catch(() => null)) as
    | (AuthSession & { error?: string })
    | null;

  if (!res.ok || !payload?.token) {
    throw new Error(payload?.error ?? `登录失败 (HTTP ${res.status})`);
  }
  const session: AuthSession = {
    token: payload.token,
    username: payload.username,
    expiresAt: payload.expiresAt,
  };
  setSession(session);
  return session;
}
