import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import { Schema, Field, Utf8, Float32, FixedSizeList, Int32, List } from "apache-arrow";
import type { Config } from "./config";

const documentsSchema = new Schema([
  new Field("doc_id", new Utf8(), false),
  new Field("source", new Utf8(), false),
  new Field("content", new Utf8(), false),
  new Field("acl_tags", new List(new Field("item", new Utf8(), true)), false),
  new Field("llm_keywords", new List(new Field("item", new Utf8(), true)), false),
  new Field("llm_summary", new Utf8(), false),
  new Field("status", new Utf8(), false),
  new Field("error", new Utf8(), true),
  new Field("embedding_model", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("updated_at", new Utf8(), false),
]);

function chunksSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("doc_id", new Utf8(), false),
    new Field("source", new Utf8(), false),
    new Field("section", new Utf8(), false),
    new Field("chunk_index", new Int32(), false),
    new Field("text", new Utf8(), false),
    new Field("vector", new FixedSizeList(dims, new Field("item", new Float32(), true)), false),
    new Field("acl_tags", new List(new Field("item", new Utf8(), true)), false),
  ]);
}

export async function connectDb(cfg: Config) {
  return await lancedb.connect(cfg.server.dataDir);
}

export async function ensureTables(db: lancedb.Connection, dims: number) {
  const names = await db.tableNames();
  if (!names.includes("documents")) {
    await db.createEmptyTable("documents", documentsSchema);
  }
  if (!names.includes("chunks")) {
    await db.createEmptyTable("chunks", chunksSchema(dims));
  }
}

// D34: embed dims mismatch self-heal. Vectors are derived data — drop and recreate,
// then re-embed. Returns true if re-embed is needed.
export async function ensureDimsMatch(db: lancedb.Connection, dims: number): Promise<boolean> {
  const names = await db.tableNames();
  if (!names.includes("chunks")) return false;
  const table = await db.openTable("chunks");
  const schema = await table.schema();
  const vectorField = schema.fields.find((f) => f.name === "vector");
  if (!vectorField) return false;
  const type = vectorField.type;
  if (!(type instanceof FixedSizeList)) return false;
  const currentDims = type.listSize;
  if (currentDims === dims) return false;
  console.log(
    `[db] chunks vector dims mismatch: ${currentDims} != ${dims}; dropping + recreating (vectors are derived data)`,
  );
  await db.dropTable("chunks");
  await db.createEmptyTable("chunks", chunksSchema(dims));
  return true;
}

export async function ensureFtsIndex(table: lancedb.Table) {
  const indices = await table.listIndices();
  const hasFts = indices.some(
    (i) => i.columns.includes("text") && i.indexType === "FTS",
  );
  if (!hasFts) {
    await table.createIndex("text", { config: Index.fts() });
  }
}