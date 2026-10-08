import { useMemo } from "react";
import { useApi } from "@/src/hooks/useApi";
import { api } from "@/src/lib/api";
import type { Category, DataSource } from "@/src/types";
import type { FilterOption } from "@/src/components/shared/Filters";

interface CategoryLookup {
  /** 一级带 children 的树，供类目页渲染 */
  tree: Category[];
  /** 扁平列表，供下拉选项 */
  flat: Category[];
  options: FilterOption[];
  nameOf: (categoryId: string | undefined) => string;
  loading: boolean;
  source: DataSource;
}

/**
 * 类目字典。
 *
 * 商品列表、商品表单、类目页都要「id → 中文名」的映射，集中在这里取一次，
 * 避免各页面重复请求同一份几乎不变的数据。
 */
export function useCategories(): CategoryLookup {
  const { data, loading, source } = useApi(() => api.listCategories(), []);

  const tree = useMemo(() => data?.items ?? [], [data]);

  const flat = useMemo(() => {
    const out: Category[] = [];
    const walk = (nodes: Category[]) => {
      for (const node of nodes) {
        out.push(node);
        if (node.children?.length) walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const options = useMemo<FilterOption[]>(
    () =>
      flat.map((c) => ({
        value: c.id,
        // 二级类目加缩进，让层级在下拉里可读
        label: c.level === 1 ? c.name : `　└ ${c.name}`,
      })),
    [flat]
  );

  const byId = useMemo(() => new Map(flat.map((c) => [c.id, c])), [flat]);

  // 返回值也 memo 掉 —— 否则引用每次渲染都变，调用方的 useMemo 会持续失效
  return useMemo(
    () => ({
      tree,
      flat,
      options,
      nameOf: (id: string | undefined) => (id ? (byId.get(id)?.name ?? id) : "—"),
      loading,
      source,
    }),
    [tree, flat, options, byId, loading, source]
  );
}
