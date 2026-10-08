import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/src/lib/utils";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const kindMeta: Record<ToastKind, { icon: ReactNode; className: string }> = {
  success: {
    icon: <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-px" />,
    className: "border-emerald-200 bg-emerald-50 text-emerald-900",
  },
  error: {
    icon: <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-px" />,
    className: "border-rose-200 bg-rose-50 text-rose-900",
  },
  info: {
    icon: <Info className="h-4 w-4 text-sky-600 shrink-0 mt-px" />,
    className: "border-sky-200 bg-sky-50 text-sky-900",
  },
};

/**
 * 轻量提示条。
 *
 * 写操作的结果必须让用户看见 —— 尤其是服务端返回的校验失败（售价为 0、
 * 库存低于占用量等），绝不能静默吞掉。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    []
  );

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, kind, message }]);
    const timer = setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
    timers.current.push(timer);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-80 flex-col gap-2">
        {items.map((t) => {
          const meta = kindMeta[t.kind];
          return (
            <div
              key={t.id}
              className={cn(
                "pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2 fade-in-0 duration-200",
                meta.className
              )}
            >
              {meta.icon}
              <p className="flex-1 text-xs font-medium leading-relaxed break-words">
                {t.message}
              </p>
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
                className="shrink-0 opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}
