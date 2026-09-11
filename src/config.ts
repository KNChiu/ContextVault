import { z } from "zod";

const rawConfigSchema = z.object({
  server: z.object({
    port: z.number().int().positive().default(8787),
    dataDir: z.string().default("/data/contextvault/lancedb"),
  }),
  models: z.object({
    cacheDir: z.string().default("/data/contextvault/hf-cache"),
  }),
  embedding: z.object({
    model: z.string().default("Xenova/multilingual-e5-small"),
    dims: z.number().int().positive().default(384),
  }),
  tagging: z.object({
    model: z.string().default("onnx-community/Qwen2.5-0.5B-Instruct"),
    enabled: z.boolean().default(true),
    provider: z.enum(["local", "api"]).default("local"),
    baseURL: z.string().default(""),
    apiKeyEnv: z.string().default(""),
  }),
  reranker: z.object({
    enabled: z.boolean().default(true),
    candidates: z.number().int().positive().default(12),
    model: z.string().default("Xenova/bge-reranker-base"),
  }),
  chunk: z.object({
    size: z.number().int().positive().default(512),
    overlap: z.number().int().min(0).default(64),
  }),
  convert: z.object({
    enabled: z.boolean().default(true),
    bin: z.string().default("markitdown"),
    formats: z.array(z.string().min(1)).default(["pptx", "pdf", "docx", "xlsx"]),
    timeoutSec: z.number().int().positive().default(300),
    maxBinaryBytes: z.number().int().positive().default(20971520),
  }),
  limits: z.object({
    maxUploadBytes: z.number().int().positive().default(1048576),
    getDocumentMax: z.number().int().positive().default(65536),
    topKMax: z.number().int().positive().max(100).default(20),
    sourceMaxLen: z.number().int().positive().default(256),
    mergedTextMax: z.number().int().positive().default(2000),
  }),
  keys: z.array(z.object({
    keyEnv: z.string().min(1),
    user: z.string().min(1),
    admin: z.boolean().default(false),
    allowedTags: z.array(z.string().min(1)).min(1),
  })).min(1),
  vocabulary: z.object({
    tags: z.array(z.string().min(1)).min(1),
  }),
});

const configSchema = rawConfigSchema.refine(
  (c) => c.reranker.candidates >= c.limits.topKMax,
  { message: "reranker.candidates must be >= limits.topKMax" },
).transform((c) => {
  const keys = c.keys.map((k) => {
    const key = process.env[k.keyEnv];
    if (!key) {
      throw new Error(
        `Missing env var "${k.keyEnv}" (API key for user "${k.user}"); set it or use keyEnv in the [[keys]] config`,
      );
    }
    return { ...k, key };
  });

  let taggingApiKey: string | undefined;
  if (c.tagging.provider === "api") {
    if (!c.tagging.baseURL) {
      throw new Error('tagging.provider = "api" requires [tagging] baseURL');
    }
    if (!c.tagging.apiKeyEnv) {
      throw new Error('tagging.provider = "api" requires [tagging] apiKeyEnv');
    }
    taggingApiKey = process.env[c.tagging.apiKeyEnv];
    if (!taggingApiKey) {
      throw new Error(`Missing env var "${c.tagging.apiKeyEnv}" (tagging API key)`);
    }
  }

  const vocabSet = new Set(c.vocabulary.tags);
  for (const k of c.keys) {
    for (const tag of k.allowedTags) {
      if (!vocabSet.has(tag)) {
        throw new Error(
          `Key "${k.keyEnv}" (user: ${k.user}) has allowedTag "${tag}" not in vocabulary`,
        );
      }
    }
  }

  return { ...c, keys, taggingApiKey };
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ?? process.env.CONFIG_PATH ?? "config.toml";
  const file = Bun.file(configPath);
  if (!file.exists()) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = Bun.TOML.parse(await file.text());
  return configSchema.parse(raw);
}