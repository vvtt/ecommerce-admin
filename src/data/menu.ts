/**
 * 导航菜单树 —— 侧边栏、面包屑、路由的三方单一数据源。
 *
 * 新增页面时只改这里 + App.tsx 的路由表；菜单高亮与面包屑会自动跟上，
 * 不会出现「菜单有、路由没有」的漂移。
 */
import type { MenuNode } from "@/src/types";

export const MENU_TREE: MenuNode[] = [
  {
    id: "overview",
    title: "经营概览",
    iconName: "LayoutDashboard",
    path: "/",
  },
  {
    id: "products",
    title: "商品管理",
    iconName: "Package",
    children: [
      { id: "product-list", title: "商品列表", path: "/products" },
      { id: "category-tree", title: "类目管理", path: "/categories" },
    ],
  },
  {
    id: "inventory",
    title: "库存管理",
    iconName: "Boxes",
    children: [
      { id: "inventory-list", title: "库存总览", path: "/inventory" },
      { id: "stock-movements", title: "库存流水", path: "/inventory/movements" },
    ],
  },
  {
    id: "purchase",
    title: "采购补货",
    iconName: "ClipboardList",
    children: [
      { id: "purchase-list", title: "采购单", path: "/purchase" },
      { id: "purchase-new", title: "新建采购单", path: "/purchase/new" },
    ],
  },
  {
    id: "sourcing",
    title: "货源采集",
    iconName: "Compass",
    children: [
      { id: "sourcing-list", title: "货源库", path: "/sourcing" },
    ],
  },
  {
    id: "competitor",
    title: "竞品分析",
    iconName: "Trophy",
    children: [
      { id: "competitor-products", title: "竞品商品", path: "/competitor/products" },
    ],
  },
];

/**
 * 路径是否归属某菜单项。
 * 根路径 "/" 只做精确匹配，否则它会前缀命中所有页面。
 */
export function matchesPath(pathname: string, path: string): boolean {
  if (pathname === path) return true;
  return path !== "/" && pathname.startsWith(`${path}/`);
}

/**
 * 反查面包屑链路：返回从一级菜单到最深匹配项。
 * 详情页（如 /products/SPU-10001）会命中前缀最长的 /products 叶子，
 * 因此面包屑停在「商品列表」，具体对象名由页面自己的 PageHeader 展示。
 */
export function findBreadcrumbTrail(pathname: string): MenuNode[] {
  let best: MenuNode[] = [];
  let bestScore = -1;

  const walk = (nodes: MenuNode[], trail: MenuNode[]) => {
    for (const node of nodes) {
      const next = [...trail, node];
      if (node.path && matchesPath(pathname, node.path)) {
        // 路径越长匹配越精确，优先级越高
        const score = node.path.length;
        if (score > bestScore) {
          bestScore = score;
          best = next;
        }
      }
      if (node.children?.length) walk(node.children, next);
    }
  };

  walk(MENU_TREE, []);
  return best;
}

/** 菜单树里所有可跳转路径，供路由表对照 */
export function collectPaths(nodes: MenuNode[] = MENU_TREE): string[] {
  return nodes.flatMap((n) => [
    ...(n.path ? [n.path] : []),
    ...(n.children ? collectPaths(n.children) : []),
  ]);
}
