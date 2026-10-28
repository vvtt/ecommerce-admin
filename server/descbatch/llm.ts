/**
 * LLM 调用层：智谱 GLM（open.bigmodel.cn）。
 *
 * 教训固化：之前批量 VLM 任务因 requests 无硬超时反复卡死 —— 这里每个请求
 * 都挂 AbortSignal 硬超时 + 有限重试，绝不无限等。
 */
import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./client";

const CONFIG_PATH = path.join(DB_DIR, "config.json");

export interface LlmConfig {
  apiKey: string;
  model: string;
}

const DEFAULT_MODEL = "glm-4.7-flash";

export function loadConfig(): LlmConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<LlmConfig>;
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_MODEL,
    };
  } catch {
    return { apiKey: "", model: DEFAULT_MODEL };
  }
}

export function saveConfig(config: LlmConfig): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const TIMEOUT_MS = 90_000;
const RETRIES = 2;

/** 带硬超时与有限重试的一次补全调用；失败抛出带原因的 Error */
export async function callLlm(systemPrompt: string, userContent: string): Promise<string> {
  const { apiKey, model } = loadConfig();
  if (!apiKey) throw new Error("未配置模型 API Key，请先在页面「设置」里填写");

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      // 指数退避：1s、2s —— 批量场景下慢一点比打死供应商接口强
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          temperature: 0.6,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`LLM 接口 ${res.status}：${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("LLM 返回了空内容");
      return content;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `LLM 调用失败（已重试 ${RETRIES} 次）：${String(lastError).slice(0, 300)}`,
  );
}
