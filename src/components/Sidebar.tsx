import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Compass,
  LayoutDashboard,
  Menu,
  Package,
  Store,
  Tags,
  Trophy,
} from "lucide-react";
import type { MenuNode } from "@/src/types";
import { MENU_TREE, findBreadcrumbTrail } from "@/src/data/menu";
import { cn } from "@/src/lib/utils";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const iconMap: Record<string, React.ReactNode> = {
  LayoutDashboard: <LayoutDashboard className="h-4 w-4 shrink-0" />,
  Package: <Package className="h-4 w-4 shrink-0" />,
  Boxes: <Boxes className="h-4 w-4 shrink-0" />,
  ClipboardList: <ClipboardList className="h-4 w-4 shrink-0" />,
  Tags: <Tags className="h-4 w-4 shrink-0" />,
  Compass: <Compass className="h-4 w-4 shrink-0" />,
  Trophy: <Trophy className="h-4 w-4 shrink-0" />,
};

const badgeColorClasses: Record<string, string> = {
  blue: "bg-blue-100 text-blue-700 border-blue-200",
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  rose: "bg-rose-100 text-rose-700 border-rose-200",
  slate: "bg-slate-100 text-slate-700 border-slate-200",
};

function Badge({ badge, color = "blue" }: { badge?: string | number; color?: string }) {
  if (!badge) return null;
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 text-[10px] font-semibold rounded-full border leading-none shrink-0",
        badgeColorClasses[color] ?? badgeColorClasses.blue
      )}
    >
      {badge}
    </span>
  );
}

export const Sidebar: React.FC<SidebarProps> = ({ collapsed, onToggleCollapse }) => {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // 当前路径命中的最深菜单节点，以及它到根的链路
  const trail = useMemo(() => findBreadcrumbTrail(pathname), [pathname]);
  const trailIds = useMemo(() => trail.map((n) => n.id), [trail]);
  const activeId = trail[trail.length - 1]?.id;

  // 手动展开/折叠的覆盖项；未覆盖时按「是否在激活链路上」自动展开
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string) => expandedOverride[id] ?? trailIds.includes(id);

  const toggleExpand = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setExpandedOverride((prev) => ({ ...prev, [id]: !isExpanded(id) }));
  };

  // 折叠态下的悬浮子菜单
  const [flyout, setFlyout] = useState<{ node: MenuNode; top: number } | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    },
    []
  );

  useEffect(() => {
    if (!collapsed) setFlyout(null);
  }, [collapsed]);

  const clearHoverTimer = () => {
    if (hoverTimeout.current) {
      clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
  };

  const handleEnter = (node: MenuNode, e: React.MouseEvent<HTMLDivElement>) => {
    if (!collapsed) return;
    clearHoverTimer();
    setFlyout({ node, top: e.currentTarget.getBoundingClientRect().top });
  };

  const handleLeave = () => {
    if (!collapsed) return;
    hoverTimeout.current = setTimeout(() => setFlyout(null), 220);
  };

  const go = (path?: string) => {
    if (!path) return;
    navigate(path);
    setFlyout(null);
  };

  return (
    <aside
      className={cn(
        "relative flex flex-col border-r border-slate-200 bg-white transition-all duration-300 z-30 select-none",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* 品牌区 */}
      <div className="flex h-16 items-center justify-between px-4 border-b border-slate-200">
        {collapsed ? (
          <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
            <Store className="h-5 w-5" />
          </div>
        ) : (
          <>
            <div className="flex items-center space-x-2.5 overflow-hidden">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm font-bold text-base shrink-0">
                <Store className="h-5 w-5" />
              </div>
              <div className="flex flex-col truncate">
                <span className="text-sm font-bold text-slate-900 leading-tight truncate tracking-tight">
                  跨境电商后台
                </span>
                <span className="text-[11px] text-slate-500 font-medium truncate">
                  商品 · 库存 · 采购
                </span>
              </div>
            </div>
            <button
              onClick={onToggleCollapse}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer"
              title="折叠菜单"
            >
              <Menu className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {/* 菜单列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1.5">
        {MENU_TREE.map((item) => {
          const hasChildren = !!item.children?.length;
          const onActivePath = trailIds.includes(item.id);
          const expanded = isExpanded(item.id);

          return (
            <div key={item.id} className="space-y-1" onMouseEnter={(e) => handleEnter(item, e)} onMouseLeave={handleLeave}>
              {/* 一级菜单 */}
              <div
                onClick={() => {
                  if (collapsed) {
                    go(item.path ?? item.children?.[0]?.path);
                  } else if (hasChildren) {
                    toggleExpand(item.id);
                  } else {
                    go(item.path);
                  }
                }}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all cursor-pointer",
                  onActivePath
                    ? "bg-blue-50 text-blue-700 font-semibold"
                    : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
                  collapsed && "justify-center px-2"
                )}
                title={collapsed ? item.title : undefined}
              >
                {item.iconName && iconMap[item.iconName]}
                {!collapsed && (
                  <>
                    <span className="truncate flex-1">{item.title}</span>
                    <Badge badge={item.badge} color={item.badgeColor} />
                    {hasChildren && (
                      <span className="text-slate-400">
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* 二级菜单 */}
              {!collapsed && hasChildren && expanded && (
                <div className="ml-4 pl-3 border-l border-slate-200 space-y-1 my-1">
                  {item.children!.map((sub) => (
                    <div
                      key={sub.id}
                      onClick={() => go(sub.path)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                        sub.id === activeId
                          ? "bg-blue-100/70 text-blue-800 font-semibold"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full shrink-0",
                          sub.id === activeId ? "bg-blue-600" : "bg-slate-400"
                        )}
                      />
                      <span className="truncate flex-1">{sub.title}</span>
                      <Badge badge={sub.badge} color={sub.badgeColor} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 折叠态悬浮子菜单 */}
      {collapsed && flyout && (
        <div
          style={{ top: `${Math.max(12, Math.min(flyout.top, window.innerHeight - 320))}px`, left: "64px" }}
          className="fixed z-50 w-60 rounded-xl border border-slate-200 bg-white p-2 shadow-xl ring-1 ring-black/5 animate-in fade-in-50 zoom-in-95 duration-150"
          onMouseEnter={clearHoverTimer}
          onMouseLeave={handleLeave}
        >
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 mb-1.5 bg-slate-50/60 rounded-lg font-bold text-xs text-slate-900">
            {flyout.node.iconName && <span className="text-blue-600">{iconMap[flyout.node.iconName]}</span>}
            <span className="truncate">{flyout.node.title}</span>
          </div>

          <div className="max-h-[70vh] overflow-y-auto space-y-0.5 text-xs">
            {flyout.node.path && (
              <button
                type="button"
                onClick={() => go(flyout.node.path)}
                className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg font-medium text-left text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <span>全部概览</span>
                <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
              </button>
            )}
            {flyout.node.children?.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => go(child.path)}
                className={cn(
                  "w-full flex items-center justify-between px-2.5 py-2 rounded-lg font-medium text-left transition-colors cursor-pointer",
                  child.id === activeId
                    ? "bg-blue-50 text-blue-700 font-semibold"
                    : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                )}
              >
                <span className="flex items-center gap-2 truncate">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full shrink-0",
                      child.id === activeId ? "bg-blue-600" : "bg-slate-300"
                    )}
                  />
                  <span className="truncate">{child.title}</span>
                </span>
                <Badge badge={child.badge} color={child.badgeColor} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 底部用户区 */}
      <div className="border-t border-slate-200 p-3 bg-slate-50/70">
        <div className="flex items-center gap-3">
          <div className="relative h-9 w-9 shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold">
              运营
            </div>
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
          </div>
          {!collapsed && (
            <div className="flex flex-col truncate">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-800 truncate">陈嘉怡</span>
                <span className="text-[10px] bg-blue-100 text-blue-700 px-1 rounded font-mono">运营</span>
              </div>
              <span className="text-[11px] text-slate-500 truncate">深圳总部 · 在线</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
