import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bell, ChevronRight, LogOut, Menu } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { findBreadcrumbTrail } from "@/src/data/menu";
import { clearSession, getSession } from "@/src/lib/auth";
import { cn } from "@/src/lib/utils";

interface HeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

type ServerStatus = "checking" | "online" | "offline";

/**
 * 探测 Express 是否可达 —— 决定页面数据会走接口还是走本地兜底。
 *
 * 不能只看 res.ok：纯静态托管（vite preview / 任意 CDN）对 /api/health 会回
 * index.html 并给出 200，那样会在接口根本不存在时误报「已连接」。因此必须校验
 * 响应确实是 JSON 且带了约定的 status 字段。
 */
function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error("bad status");
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) throw new Error("not json");
        const payload = (await res.json()) as { status?: string };
        if (!cancelled) setStatus(payload?.status === "ok" ? "online" : "offline");
      } catch {
        if (!cancelled) setStatus("offline");
      }
    };

    probe();
    // 服务重启（tsx 无 watch）后无需刷新页面即可恢复
    const timer = setInterval(probe, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
}

const statusMeta: Record<ServerStatus, { label: string; dot: string; text: string }> = {
  checking: { label: "检测中", dot: "bg-slate-300", text: "text-slate-500" },
  online: { label: "接口已连接", dot: "bg-emerald-500", text: "text-emerald-700" },
  offline: { label: "本地兜底数据", dot: "bg-amber-500", text: "text-amber-700" },
};

export const Header: React.FC<HeaderProps> = ({ collapsed, onToggleCollapse }) => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const trail = useMemo(() => findBreadcrumbTrail(pathname), [pathname]);
  const status = useServerStatus();
  const meta = statusMeta[status];
  const username = useMemo(() => getSession()?.username ?? "", []);

  const handleLogout = () => {
    clearSession();
    navigate("/login", { replace: true });
  };

  return (
    <header className="sticky top-0 z-20 flex h-16 w-full items-center justify-between border-b border-slate-200 bg-white/95 px-4 sm:px-6 backdrop-blur-xs">
      <div className="flex items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="text-slate-600 hover:text-slate-900 shrink-0"
          title={collapsed ? "展开菜单" : "折叠菜单"}
        >
          <Menu className="h-5 w-5" />
        </Button>

        <nav className="flex items-center space-x-1.5 text-xs text-slate-500 min-w-0 truncate">
          <Link to="/" className="hover:text-slate-800 transition-colors shrink-0">
            控制台
          </Link>
          {trail.map((node, idx) => {
            const isLast = idx === trail.length - 1;
            return (
              <React.Fragment key={node.id}>
                <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                {isLast || !node.path ? (
                  <span className="font-semibold text-slate-800 truncate">{node.title}</span>
                ) : (
                  <Link to={node.path} className="hover:text-slate-800 transition-colors truncate">
                    {node.title}
                  </Link>
                )}
              </React.Fragment>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => window.location.reload()}
          title={
            status === "offline"
              ? "未连上 Express，页面正在用本地兜底数据。点击重新加载。"
              : "Express 接口正常"
          }
          className={cn(
            "hidden sm:flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer hover:bg-slate-100",
            meta.text
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
          {meta.label}
        </button>

        <Button
          variant="ghost"
          size="icon"
          className="relative text-slate-600 hover:text-slate-900"
          title="系统消息"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-rose-500" />
        </Button>

        {/* 当前用户 + 退出。登录功能上线后这里显示会话用户名 */}
        {username && (
          <div className="flex items-center gap-1.5 border-l border-slate-200 pl-2.5">
            <span className="hidden sm:flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
              {username.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden md:block text-xs font-medium text-slate-600">{username}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-slate-400 hover:text-rose-600"
              title="退出登录"
              onClick={handleLogout}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </header>
  );
};
