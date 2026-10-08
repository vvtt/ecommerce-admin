import { CloudOff, Server } from "lucide-react";
import type { DataSource } from "@/src/types";

/**
 * 数据来源徽章。
 *
 * 只有当 Express 不可达、页面真的在读本地兜底数据时才显示 —— 否则会把
 * 「接口正常」这种本该无感的事变成视觉噪音。写入操作在兜底态下会额外提示，
 * 因为那些改动不会持久化。
 */
export function SourceBadge({ source }: { source: DataSource }) {
  if (source === "api") return null;

  return (
    <span
      title="未连上 Express 接口，正在读取本地兜底数据。改动不会保存到服务端。"
      className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
    >
      <CloudOff className="h-3 w-3" />
      本地兜底数据
    </span>
  );
}

/** 接口连接正常时的轻量提示，用在详情页这类需要说明数据来源的位置 */
export function ApiSourceBadge({ source }: { source: DataSource }) {
  if (source === "mock") return <SourceBadge source={source} />;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      <Server className="h-3 w-3" />
      接口实时数据
    </span>
  );
}
