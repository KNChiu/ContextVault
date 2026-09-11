import { env, pipeline } from "@huggingface/transformers";
import type { Config } from "./config";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 30 * 1000;

let generator: any = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let llmConfig: {
  provider: "local" | "api";
  model: string;
  cacheDir: string;
  baseURL: string;
  apiKey: string;
} | null = null;

export function initLlm(cfg: Config): void {
  llmConfig = {
    provider: cfg.tagging.provider,
    model: cfg.tagging.model,
    cacheDir: cfg.models.cacheDir,
    baseURL: cfg.tagging.baseURL,
    apiKey: cfg.taggingApiKey ?? "",
  };
}

async function getGenerator(): Promise<any> {
  if (!generator) {
    if (!llmConfig) throw new Error("LLM not configured");
    env.cacheDir = llmConfig.cacheDir;
    generator = await pipeline("text-generation", llmConfig.model);
  }
  resetIdleTimer();
  return generator;
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (generator?.model) {
      await generator.model.dispose();
    }
    generator = null;
    idleTimer = null;
  }, IDLE_TIMEOUT_MS);
}

async function tagViaApi(content: string): Promise<{ keywords: string[]; summary: string }> {
  if (!llmConfig?.baseURL || !llmConfig.apiKey) {
    throw new Error("tagging API provider missing baseURL or apiKey");
  }
  const res = await fetch(`${llmConfig.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: llmConfig.model,
      messages: [
        {
          role: "system",
          content:
            'Extract keywords and a one-sentence summary from the user text. Respond in JSON only: {"keywords": ["..."], "summary": "..."}',
        },
        { role: "user", content: `Text: ${content}` },
      ],
      temperature: 0.1,
      max_tokens: 150,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tagging API returned ${res.status}`);
  const data = await res.json();
  const text: unknown = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("tagging API returned no content");
  return parseTaggingJson(text);
}

export async function tagContent(content: string): Promise<{ keywords: string[]; summary: string }> {
  if (!llmConfig) return { keywords: [], summary: "" };

  try {
    if (llmConfig.provider === "api") {
      return await tagViaApi(content);
    }
    const g = await getGenerator();
    const prompt = `Extract keywords and a one-sentence summary from this text. Respond in JSON format with "keywords" (array of strings) and "summary" (string).

Text: ${content}`;
    const output = await g(prompt, { max_new_tokens: 150, temperature: 0.1, do_sample: false });
    const generated = output[0]?.generated_text || "";
    const newText = generated.slice(prompt.length).trim();
    return parseTaggingJson(newText);
  } catch (e) {
    console.warn("LLM tagging failed:", (e as Error).message);
    return { keywords: [], summary: "" };
  }
}

function parseTaggingJson(text: string): { keywords: string[]; summary: string } {
  let cleaned = text.replace(/```(?:json)?\n?/gi, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return { keywords: [], summary: "" };

  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8).map(String) : [];
    const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 200) : "";
    return { keywords, summary };
  } catch {
    return { keywords: [], summary: "" };
  }
}