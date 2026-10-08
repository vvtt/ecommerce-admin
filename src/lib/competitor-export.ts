/**
 * 竞品商品单条导出（txt）。
 *
 * 导出的是完整商品信息而非列表四字段：竞品分析真正要看的是 SKU 结构、
 * 变体维度、评分与店铺背景，列表页那四列只是索引。内容格式用
 * 「字段: 值」逐行平铺，不套 JSON —— 产物是给人看/贴给 LLM 的，不是给程序解析的。
 */
import type { CompetitorProductDetail, CompetitorReview } from "@/src/types";

/** 常见币种的展示符号，未收录的币种回落到 ISO 代码本身 */
const CURRENCY_SYMBOL: Record<string, string> = {
  TWD: "NT$",
  CNY: "¥",
  USD: "$",
  SGD: "S$",
  MYR: "RM",
  THB: "฿",
  VND: "₫",
  PHP: "₱",
  IDR: "Rp",
  BRL: "R$",
};

function money(value: number | undefined, currency: string): string {
  if (value === undefined) return "—";
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}

function formatUnixTime(seconds: number | undefined): string {
  if (!seconds) return "—";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 单条评论的文本行。内容可能带换行，整体缩进保持块状可读 */
function reviewLines(index: number, r: CompetitorReview): string[] {
  const who = r.authorUsername || r.authorName || "匿名用户";
  const stars = r.ratingStar !== undefined ? `★${r.ratingStar.toFixed(1)}` : "未评分";
  const head = [`${who}  ${stars}`, formatUnixTime(r.ctime)].filter(Boolean).join("  ");
  const tag = r.commentTag ? `  [标签: ${r.commentTag}]` : "";
  const body = r.comment
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return [`[${index}] ${head}${tag}`, body || "    (无文字内容)"];
}

/** 拼导出文本。字段顺序按「先身份、后价格、再明细」的阅读习惯排 */
export function buildCompetitorTxt(detail: CompetitorProductDetail): string {
  const lines: string[] = [
    "Shopee 竞品商品信息",
    "========================================",
    `商品 ID:   ${detail.itemId}`,
    `店铺 ID:   ${detail.shopId}`,
    `名称:      ${detail.name || "—"}`,
    `分类:      ${detail.categoryPath || "—"}`,
    ...(detail.feCategoryPath && detail.feCategoryPath !== detail.categoryPath
      ? [`前端分类:  ${detail.feCategoryPath}`]
      : []),
    `价格:      ${money(detail.price, detail.currency)}`,
    `价格区间:  ${money(detail.priceMin, detail.currency)} ~ ${money(detail.priceMax, detail.currency)}`,
    `币种:      ${detail.currency || "—"}`,
    `评分:      ${detail.ratingStar !== undefined ? detail.ratingStar.toFixed(2) : "—"}`,
    `评论数:    ${detail.reviewCount}`,
    `SKU 数量:  ${detail.modelCount ?? detail.models.length}`,
    `店铺名称:  ${detail.shopName || "—"}`,
    `发货地:    ${detail.shopLocation || "—"}`,
    `跨境商品:  ${detail.isCrossBorder === 1 ? "是" : detail.isCrossBorder === 0 ? "否" : "—"}`,
    `状态:      ${detail.itemStatus || "—"}`,
    `上架时间:  ${formatUnixTime(detail.listedAt)}`,
    `商品链接:  ${detail.url || "—"}`,
    `首次采集:  ${detail.capturedAt || "—"}`,
    `最近更新:  ${detail.updatedAt || "—"}`,
  ];

  if (detail.tierVariations.length) {
    lines.push("", "变体维度", "----------------------------------------");
    for (const tv of detail.tierVariations) {
      lines.push(`${tv.name}: ${tv.options.join(" / ")}`);
    }
  }

  if (detail.models.length) {
    lines.push("", "SKU 明细", "----------------------------------------");
    for (const m of detail.models) {
      const stock = m.normal_stock !== undefined ? `  库存 ${m.normal_stock}` : "";
      lines.push(`- ${m.name || m.modelid}  ${money(m.price, detail.currency)}${stock}`);
    }
  }

  if (detail.attributes.length) {
    lines.push("", "商品规格", "----------------------------------------");
    for (const a of detail.attributes) {
      lines.push(`${a.name}: ${a.value}`);
    }
  }

  if (detail.descriptionText) {
    lines.push("", "商品描述", "----------------------------------------", detail.descriptionText);
  }

  // 评论是竞品分析的核心素材（痛点/卖点都在里面）。带文字的逐条导出；
  // 纯评分（Shopee 上占大头）压缩成一行星级分布 —— 32 行「(无文字内容)」
  // 只会稀释正文，星级汇总保留的信号一样多
  const total = detail.reviews.length;
  if (total) {
    const withText = detail.reviews.filter((r) => (r.comment ?? "").trim());
    const ratingOnly = detail.reviews.filter((r) => !(r.comment ?? "").trim());

    const head =
      withText.length === total
        ? `用户评论（共 ${total} 条，按时间倒序）`
        : `用户评论（共 ${total} 条：文字评论 ${withText.length} 条，纯评分 ${ratingOnly.length} 条）`;
    lines.push("", head, "----------------------------------------");

    withText.forEach((r, i) => lines.push(...reviewLines(i + 1, r)));

    if (ratingOnly.length) {
      const dist = new Map<number, number>();
      for (const r of ratingOnly) {
        const star = Math.round(r.ratingStar ?? 0);
        dist.set(star, (dist.get(star) ?? 0) + 1);
      }
      const summary = [...dist.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([star, n]) => `★${star} ×${n}`)
        .join(" / ");
      lines.push(`另有 ${ratingOnly.length} 条纯评分（无文字）：${summary}`);
    }
  }

  return lines.join("\n") + "\n";
}

/** 触发浏览器下载。文件名与 Python 时代的数据文件命名保持同一套 shop_item 心智 */
export function downloadCompetitorTxt(detail: CompetitorProductDetail): void {
  const blob = new Blob([buildCompetitorTxt(detail)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shopee_${detail.shopId}_${detail.itemId}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
