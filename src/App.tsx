/**
 * 路由表。
 *
 * 路径与 src/data/menu.ts 的菜单树一一对应 —— 菜单、面包屑、路由同源，
 * 新增页面时改这两处即可，不会出现「菜单能点但路由 404」。
 */
import { lazy } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import AdminLayout from "@/src/layouts/AdminLayout";
import ProductList from "@/src/pages/products/ProductList";
import ProductDetail from "@/src/pages/products/ProductDetail";
import ProductForm from "@/src/pages/products/ProductForm";
import Categories from "@/src/pages/Categories";
import InventoryList from "@/src/pages/inventory/InventoryList";
import StockMovements from "@/src/pages/inventory/StockMovements";
import PurchaseList from "@/src/pages/purchase/PurchaseList";
import PurchaseNew from "@/src/pages/purchase/PurchaseNew";
import PurchaseDetail from "@/src/pages/purchase/PurchaseDetail";
import SourcingList from "@/src/pages/sourcing/SourcingList";
import SourcingDetail from "@/src/pages/sourcing/SourcingDetail";
import CompetitorProducts from "@/src/pages/competitor/CompetitorProducts";
import Login from "@/src/pages/Login";
import NotFound from "@/src/pages/NotFound";
import { getSession } from "@/src/lib/auth";

/**
 * 路由守卫：无有效会话一律重定向到登录页。
 * API 层还有一道兜底（401 → 清会话跳 /login），两层各管各的 ——
 * 路由守卫管「打开页面」，401 处理管「token 过期后正在用的页面」。
 */
function RequireAuth() {
  if (!getSession()) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

/**
 * 概览页是唯一依赖 recharts 的页面，单独切出来。
 * 其余页面的首屏因此不必为图表库付出 ~600KB。
 */
const Overview = lazy(() => import("@/src/pages/Overview"));

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<RequireAuth />}>
        <Route element={<AdminLayout />}>
          <Route path="/" element={<Overview />} />

          <Route path="/products" element={<ProductList />} />
          {/* 静态段 new 必须先于动态段 :id 声明，否则会被当成 id 吞掉 */}
          <Route path="/products/new" element={<ProductForm mode="create" />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/products/:id/edit" element={<ProductForm mode="edit" />} />

          <Route path="/categories" element={<Categories />} />

          <Route path="/inventory" element={<InventoryList />} />
          <Route path="/inventory/movements" element={<StockMovements />} />

          <Route path="/purchase" element={<PurchaseList />} />
          <Route path="/purchase/new" element={<PurchaseNew />} />
          <Route path="/purchase/:id" element={<PurchaseDetail />} />

          <Route path="/sourcing" element={<SourcingList />} />
          {/* /sourcing 下没有再深的静态段，所以直接挂动态段即可 */}
          <Route path="/sourcing/:id" element={<SourcingDetail />} />

          <Route path="/competitor/products" element={<CompetitorProducts />} />

          <Route path="/404" element={<NotFound />} />
          {/* 布局内兜底：未匹配路径也留在后台外壳里，而不是白屏 */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
