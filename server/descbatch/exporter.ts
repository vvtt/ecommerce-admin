/**
 * 导出器：生成妙手「批量修改详情」导入模板格式的 xlsx。
 *
 * 模板格式（来自用户提供的官方模板）：仅 A 列「产品ID」+ B 列「详情」，
 * 每个产品一行。产品 ID 用解析时保留的原样字符串（含 Tab 前缀），
 * 保证与 ERP 导出时的文本格式完全一致、能匹配上。
 */
import ExcelJS from "exceljs";
import { getDb } from "./client";

interface ItemRow {
  product_id: string;
  rewritten: string | null;
  status: string;
}

export async function buildExportBuffer(taskId: number): Promise<Buffer> {
  const db = getDb();
  const items = db
    .prepare("SELECT product_id, rewritten, status FROM items WHERE task_id = ? ORDER BY id")
    .all(taskId) as unknown as ItemRow[];

  if (!items.length) throw new Error("任务没有任何产品明细");
  const notDone = items.filter((it) => it.status !== "done" || !it.rewritten);
  if (notDone.length) {
    // 导出门禁：模型没处理完不许导出，否则回导会把空描述灌进 ERP
    throw new Error(`还有 ${notDone.length} 条产品未完成改写，全部处理完成后才能导出`);
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.columns = [
    { header: "产品ID", key: "productId", width: 26 },
    { header: "详情", key: "desc", width: 100 },
  ];
  for (const it of items) {
    // 产品 ID 写成字符串（含原 Tab 前缀），exceljs 按文本存储，与导出格式一致
    sheet.addRow({ productId: it.product_id, desc: it.rewritten ?? "" });
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}
