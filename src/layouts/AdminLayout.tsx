import { Suspense, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "@/src/components/Sidebar";
import { Header } from "@/src/components/Header";
import { Skeleton } from "@/src/components/ui/skeleton";

/**
 * 后台外壳：左侧导航 + 顶部面包屑 + 可滚动内容区。
 * 业务页面全部通过 <Outlet /> 渲染，切换路由时外壳不重新挂载，
 * 侧边栏折叠状态与滚动位置因此得以保留。
 */
export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 font-sans text-slate-900 antialiased">
      <Sidebar collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />

      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Header collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />

        {/* key=pathname：路由切换后内容区回到顶部，符合后台使用直觉 */}
        <main key={pathname} className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

/** 按需加载页面的占位骨架，形状对齐常见的「标题 + 卡片 + 表格」结构 */
function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
