import type { Connection } from "@lancedb/lancedb";
import type { Config } from "./config";
import { chunkMarkdown } from "./chunk";
import { embedPassages } from "./embed";
import { tagContent, initLlm } from "./llm";
import { convertToMarkdown } from "./convert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const queue: string[] = [];
let running = false;
let db: Connection | null = null;
let cfg: Config | null = null;
let drainResolvers: (() => void)[] = [];
let reembedRunning = false;
const MAX_TAG_CHUNKS = 30;

export function initIngest(database: Connection, config: Config): void {
  db = database;
  cfg = config;
  if (config.tagging.enabled) {
    initLlm(config);
  }
}

export function enqueue(docId: string): void {
  queue.push(docId);
  kickWorker();
}

export function isReembedRunning(): boolean {
  return reembedRunning;
}
export async function reembedAll(): Promise<number> {
  if (!db) return 0;
  reembedRunning = true;
  const docs = await db.openTable("documents");
  const rows = await docs
    .query()
    .where("status = 'done'")
    .limit(10000)
    .toArray();
  for (const row of rows) {
    queue.push(row.doc_id as string);
  }
  kickWorker();
  return rows.length;
}

// Boot check (D34): any done doc whose embedding_model differs from config means a
// previous re-embed was interrupted (e.g. SIGTERM) — search would refuse forever.

export async function reembedStale(): Promise<number> {
  if (!db || !cfg) return 0;
  const docs = await db.openTable("documents");
  const rows = await docs
    .query()
    .where(`status = 'done' AND embedding_model != '${escapeSql(cfg.embedding.model)}'`)
    .limit(10000)
    .toArray();
  for (const row of rows) {
    queue.push(row.doc_id as string);
  }
  kickWorker();
  return rows.length;
}

function escapeSql(val: string): string {
  return val.replace(/'/g, "''");
}

export async function recoverOnBoot(): Promise<void> {
  if (!db) return;
  const docs = await db.openTable("documents");
  const pending = await docs
    .query()
    .where("status = 'pending' OR status = 'indexing' OR status = 'converting'")
    .limit(1000)
    .toArray();
  for (const doc of pending) {
    enqueue(doc.doc_id as string);
  }
}

export function waitForIdle(timeoutMs = 30000): Promise<void> {
  if (!running && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drainResolvers = drainResolvers.filter((r) => r !== done);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    drainResolvers.push(done);
  });
}

function kickWorker(): void {
  if (running) return;
  running = true;
  processNext();
}

async function processNext(): Promise<void> {
  while (queue.length > 0) {
    const docId = queue.shift()!;
    await processOne(docId);
  }
  running = false;
  reembedRunning = false;
  const resolvers = drainResolvers;
  drainResolvers = [];
  for (const r of resolvers) r();
}

function uploadsDir(cfg: Config): string {
  const dir = join(cfg.server.dataDir, "..", "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function findRawFile(cfg: Config, docId: string): Promise<string | null> {
  const dir = uploadsDir(cfg);
  const glob = new Bun.Glob(`${docId}.*`);
  for await (const f of glob.scan({ cwd: dir, onlyFiles: true })) {
    return join(dir, f);
  }
  return null;
}

async function convertIfNeeded(docs: any, docId: string, row: any): Promise<void> {
  if (!cfg) return;
  if ((row.status as string) !== "converting") return;

  const raw = await findRawFile(cfg, docId);
  if (!raw) {
    await docs.update({
      where: `doc_id = '${docId}'`,
      values: { status: "failed", error: "Raw file missing; please re-upload" },
    });
    return;
  }

  const buf = await Bun.file(raw).arrayBuffer();
  const ext = raw.split(".").pop()!;
  const markdown = await convertToMarkdown(new Uint8Array(buf), ext, cfg);

  if (!markdown.trim()) {
    rmSync(raw, { force: true });
    await docs.update({
      where: `doc_id = '${docId}'`,
      values: { status: "failed", error: "No extractable text found (scanned file?)" },
    });
    return;
  }

  await docs.update({
    where: `doc_id = '${docId}'`,
    values: { content: markdown, status: "pending", error: null },
  });
  rmSync(raw, { force: true });
}

async function processOne(docId: string): Promise<void> {
  if (!db || !cfg) return;

  const docs = await db.openTable("documents");
  const chunks = await db.openTable("chunks");

  try {
    const rows = await docs.query().where(`doc_id = '${docId}'`).limit(1).toArray();
    if (rows.length === 0) return;
    const row = rows[0];

    await convertIfNeeded(docs, docId, row);

    const fresh = await docs.query().where(`doc_id = '${docId}'`).limit(1).toArray();
    if (fresh.length === 0) return;
    const freshRow = fresh[0];
    if ((freshRow.status as string) === "failed") return;

    await docs.update({
      where: `doc_id = '${docId}'`,
      values: { status: "indexing", error: null },
    });

    const content = freshRow.content as string;
    const aclTags = [...(freshRow.acl_tags as any)] as string[];
    const source = freshRow.source as string;

const chunked = chunkMarkdown(content, cfg.chunk);
    console.log(`[ingest] ${docId}: converted ${content.length} chars → ${chunked.length} chunks`);
    const texts = chunked.map((c) => c.text);
    const vectors = texts.length > 0 ? await embedPassages(texts) : [];

    let keywords: string[] = [];
    let summary = "";
    const hasTags = (freshRow.llm_keywords?.length > 0) || !!freshRow.llm_summary;
    if (cfg.tagging.enabled && !hasTags) {
      // ponytail: tag only first MAX_TAG_CHUNKS chunks; per-chunk LLM calls on huge docs would take hours
      const tagChunks = chunked.slice(0, MAX_TAG_CHUNKS);
      for (let i = 0; i < tagChunks.length; i++) {
        console.log(`[ingest] ${docId}: tagging ${i + 1}/${tagChunks.length}...`);
        const tagResult = await tagContent(tagChunks[i].text);
        keywords.push(...tagResult.keywords);
        if (!summary) summary = tagResult.summary;
      }
      keywords = [...new Set(keywords)].slice(0, 10);
    }

    await chunks.delete(`doc_id = '${docId}'`);

    if (chunked.length > 0) {
      const chunkRows = chunked.map((c, i) => ({
        chunk_id: `${docId}_${i}`,
        doc_id: docId,
        source,
        section: c.section,
        chunk_index: c.chunk_index,
        text: c.text,
        vector: vectors[i],
        acl_tags: aclTags,
      }));
      await chunks.add(chunkRows);
    }

    const updateValues: Record<string, any> = {
      status: "done",
      embedding_model: cfg.embedding.model,
      updated_at: new Date().toISOString(),
    };
    if (keywords.length > 0) updateValues.llm_keywords = keywords;
    if (summary) updateValues.llm_summary = summary;
    await docs.update({ where: `doc_id = '${docId}'`, values: updateValues });
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`Ingest failed for ${docId}: ${msg}`);
    try {
      await docs.update({
        where: `doc_id = '${docId}'`,
        values: { status: "failed", error: msg },
      });
    } catch (e2) {
      console.error(`Failed to update status for ${docId}:`, (e2 as Error).message);
    }
  }
}