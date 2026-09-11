import { env, pipeline } from "@huggingface/transformers";
import type { Config } from "./config";

let extractor: any = null;
let extractorPromise: Promise<any> | null = null;
let embedConfig: { model: string; cacheDir: string } | null = null;

// D34: lazy — stores config only; the model pipeline loads on first use.
export function initEmbedder(cfg: Config): void {
  embedConfig = { model: cfg.embedding.model, cacheDir: cfg.models.cacheDir };
}

async function getExtractor(): Promise<any> {
  if (extractor) return extractor;
  if (extractorPromise) return await extractorPromise;
  if (!embedConfig) throw new Error("Embedder not configured (initEmbedder)");
  env.cacheDir = embedConfig.cacheDir;
  extractorPromise = pipeline("feature-extraction", embedConfig.model);
  try {
    extractor = await extractorPromise;
  } catch (e) {
    extractorPromise = null;
    throw e;
  }
  return extractor;
}

export async function embedQuery(text: string): Promise<number[]> {
  const e = await getExtractor();
  const result = await e(`query: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(result.data as Float32Array);
}

export async function embedPassages(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const e = await getExtractor();
  const prefixed = texts.map((t) => `passage: ${t}`);
  const result = await e(prefixed, { pooling: "mean", normalize: true });
  const dims = result.dims as number[];
  const data = result.data as Float32Array;
  const vecs: number[][] = [];
  for (let i = 0; i < dims[0]; i++) {
    vecs.push(Array.from(data.slice(i * dims[1], (i + 1) * dims[1])));
  }
  return vecs;
}