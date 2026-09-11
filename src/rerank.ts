import { env, AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";
import type { Config } from "./config";

const MAX_LENGTH = 512;

let model: any = null;
let tokenizer: any = null;
let modelPromise: Promise<void> | null = null;
let rerankerConfig: { model: string; cacheDir: string } | null = null;

// D34: lazy — stores config only; the model loads on first search.
export function initReranker(cfg: Config): void {
  if (!cfg.reranker.enabled) return;
  rerankerConfig = { model: cfg.reranker.model, cacheDir: cfg.models.cacheDir };
}

async function loadModel(): Promise<void> {
  if (!rerankerConfig) return;
  tokenizer = await AutoTokenizer.from_pretrained(rerankerConfig.model);
  model = await AutoModelForSequenceClassification.from_pretrained(rerankerConfig.model, { dtype: "int8" });
}

async function getReranker(): Promise<{ model: any; tokenizer: any } | null> {
  if (model && tokenizer) return { model, tokenizer };
  if (!rerankerConfig) return null;
  try {
    if (!modelPromise) {
      env.cacheDir = rerankerConfig.cacheDir;
      modelPromise = loadModel();
    }
    await modelPromise;
  } catch (e) {
    modelPromise = null;
    console.warn("Reranker load failed, degraded to RRF ordering:", (e as Error).message);
    return null;
  }
  return model && tokenizer ? { model, tokenizer } : null;
}

export async function rerank(query: string, texts: string[]): Promise<number[] | null> {
  if (texts.length === 0) return [];
  const r = await getReranker();
  if (!r) return null;

  try {
    const queries = texts.map(() => query);
    const inputs = await r.tokenizer(queries, {
      text_pair: texts,
      padding: true,
      truncation: true,
      max_length: MAX_LENGTH,
    });
    const output = await r.model(inputs);
    const logits = output.logits.data as Float32Array;
    const scores: number[] = [];
    for (let i = 0; i < logits.length; i++) {
      scores.push(1 / (1 + Math.exp(-logits[i])));
    }
    return scores;
  } catch (e) {
    console.warn("Reranker failed:", (e as Error).message);
    return null;
  }
}