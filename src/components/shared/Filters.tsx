import type { KeyboardEvent, ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { cn } from "@/src/lib/utils";

/** 带放大镜的搜索框 */
export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
  className,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 需要「回车触发查询」的页面可透传按键事件（如竞品商品页） */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="h-9 pl-8 pr-8 text-sm"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
          title="清空"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * 下拉筛选。
 * value 为 "all" 表示不筛选 —— 这是各查询层约定的哨兵值。
 */
export function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  /** 「全部」选项的文案，如「全部仓库」 */
  allLabel: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-9 w-[150px] text-sm", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 列表页工具条：左侧筛选控件、右侧统计文字 */
export function FilterBar({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {right && <div className="text-xs text-slate-500">{right}</div>}
    </div>
  );
}
