/** 展示层格式化工具。数值一律走这里，避免各页面各写一套。 */

/** 千分位整数 */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

/** 人民币金额：¥1,234,567 */
export function formatCny(n: number): string {
  return `¥${formatInt(n)}`;
}

/** 大额金额缩写：¥123.4万 —— 用于 KPI 卡片，避免数字撑破卡片 */
export function formatCnyCompact(n: number): string {
  if (Math.abs(n) >= 10_000) return `¥${(n / 10_000).toFixed(1)}万`;
  return formatCny(n);
}

/** 美元售价，保留两位 */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** 价格区间：同价时只显示一个 */
export function formatPriceRange(min: number, max: number): string {
  return min === max ? formatUsd(min) : `${formatUsd(min)} ~ ${formatUsd(max)}`;
}

/**
 * 采购单价：保留两位小数，如 ¥22.40。
 *
 * 不能复用 formatCny —— 它走 formatInt 会把 22.4 抹成 ¥22，
 * 而 1688 的阶梯价普遍带小数，抹掉小数位会让相邻档位看起来是同一个价。
 */
export function formatCnyAmount(n: number): string {
  return `¥${n.toFixed(2)}`;
}

/** 采集价区间：同价时只显示一个 */
export function formatCnyRange(min: number, max: number): string {
  return min === max ? formatCnyAmount(min) : `${formatCnyAmount(min)} ~ ${formatCnyAmount(max)}`;
}

/** 2026-03-15 14:32 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 2026-03-15 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对时间：3 小时前 —— 流水列表用它比绝对时间好读 */
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatDate(iso);
}

/** 带正负号的变动量：+120 / -8 */
export function formatDelta(n: number): string {
  return n > 0 ? `+${formatInt(n)}` : formatInt(n);
}
