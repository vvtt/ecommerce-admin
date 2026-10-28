/**
 * ERP 导出表解析：xlsx → 排重后的产品列表。
 *
 * 妙手导出的表是 SKU 展开的（同一产品多行、描述逐行相同），这里按产品 ID
 * 去重，每个产品只保留一条。产品 ID 原样保留字符串（含导出时带的 Tab
 * 前缀），导出回导模板时原样写回，保证 ERP 能按原格式匹配。
 */
import ExcelJS from "exceljs";

export interface ParsedProduct {
  /** 原样字符串（可能带 Tab 前缀），导出时直接回写 */
  productId: string;
  title: string;
  category: string;
  original: string;
}

export async function parseErpExport(buffer: Buffer): Promise<ParsedProduct[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("文件里没有工作表");

  // 表头在第 1 行：列名 → 列号。允许列顺序变化，只认列名。
  const headerMap = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const name = String(cell.value ?? "").trim();
    if (name) headerMap.set(name, colNumber);
  });

  const idCol = colOf(headerMap, "产品ID");
  const descCol = colOf(headerMap, "产品描述");
  const titleCol = headerMap.get("产品标题");
  const categoryCol = headerMap.get("产品类目");

  const byId = new Map<string, ParsedProduct>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawId = cellText(row.getCell(idCol));
    const original = cellText(row.getCell(descCol));
    // 空行 / 缺 ID 缺描述的行跳过
    if (!rawId.trim() || !original.trim()) return;
    // 排重键去掉 Tab/空白 —— 同一产品多行只留第一条
    const key = rawId.replace(/[\t\s]/g, "");
    if (byId.has(key)) return;
    byId.set(key, {
      productId: rawId,
      title: titleCol ? cellText(row.getCell(titleCol)) : "",
      category: categoryCol ? cellText(row.getCell(categoryCol)) : "",
      original,
    });
  });

  const items = [...byId.values()];
  if (!items.length) throw new Error("没解析到任何产品行（需要包含「产品ID」和「产品描述」两列）");
  return items;
}

function colOf(headerMap: Map<string, number>, name: string): number {
  const col = headerMap.get(name);
  if (!col) throw new Error(`缺少必需列「${name}」，请确认上传的是 ERP 导出的产品表`);
  return col;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("text" in v) return String((v as { text: unknown }).text);
    if ("result" in v) return String((v as { result: unknown }).result);
    if ("richText" in v) {
      return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    }
  }
  return String(v);
}
