/**
 * 数据请求 hook：把 apiGet/apiSend 的 Promise 包装成 loading / error / source 状态。
 *
 * deps 会被序列化成 key 驱动重新请求；fetcher 存在 ref 里，因此不必用 useCallback
 * 包一层，也不会读到过期闭包。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DataSource } from "@/src/types";
import type { ApiResult } from "@/src/lib/api";
import { ApiError } from "@/src/lib/api";

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  /** 请求失败的原因（业务校验失败或接口错误） */
  error: string | null;
  /**
   * 失败时的 HTTP 状态码；非 HTTP 错误（如网络不可达）为 null。
   *
   * 单独暴露出来是为了区分 404 与其他错误：详情页对「这条记录不存在」应该渲染
   * 空状态并提供返回入口，而不是弹一个红色错误框说"加载失败"。
   */
  errorStatus: number | null;
  /** api = 命中 Express 接口；mock = 服务不可达，已回退本地数据 */
  source: DataSource;
  /** 重新拉取 */
  reload: () => void;
  /** 本地乐观更新（不触发请求） */
  setData: (updater: (prev: T | null) => T | null) => void;
}

export function useApi<T>(
  fetcher: () => Promise<ApiResult<T>>,
  deps: unknown[] = []
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [source, setSource] = useState<DataSource>("api");
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // deps 序列化成稳定 key，避免数组引用变化导致无限请求
  const key = `${JSON.stringify(deps)}#${nonce}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorStatus(null);

    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result.data);
        setSource(result.source);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "加载失败");
        setErrorStatus(err instanceof ApiError ? err.status : null);
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const updateData = useCallback((updater: (prev: T | null) => T | null) => {
    setData((prev) => updater(prev));
  }, []);

  return { data, loading, error, errorStatus, source, reload, setData: updateData };
}
