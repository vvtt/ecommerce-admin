import { useEffect, useState } from "react";

/**
 * 输入防抖。
 * 搜索框用它，避免每敲一个字就打一次接口；返回的是「稳定后」的值。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
