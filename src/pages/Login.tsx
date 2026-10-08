/**
 * 登录页。独立于 AdminLayout 之外（未登录时后台外壳没有意义）。
 *
 * 视觉走与后台一致的 slate 色系：居中卡片 + 品牌名。原型阶段没有验证码、
 * 没有记住我 —— 账号固定，唯一要做的是把「输错了」说清楚。
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Package } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { getSession, login } from "@/src/lib/auth";

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 已经登录的人再访问 /login 直接进后台，不用看登录表单。
  // 放在所有 hooks 之后 —— early return 会改变 hooks 调用数量
  if (getSession()) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      // replace：登录后回退键不应回到登录页
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md">
            <Package className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900">跨境电商后台</h1>
          <p className="text-xs text-slate-500">商品 · 库存 · 采购 · 货源 · 竞品</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <label className="mb-1 block text-xs font-medium text-slate-600" htmlFor="username">
            用户名
          </label>
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="请输入用户名"
            className="mb-4"
            autoFocus
          />

          <label className="mb-1 block text-xs font-medium text-slate-600" htmlFor="password">
            密码
          </label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="请输入密码"
            className="mb-4"
          />

          {error && (
            <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={submitting || !username || !password}>
            {submitting ? "登录中…" : "登 录"}
          </Button>
        </form>
      </div>
    </div>
  );
}
