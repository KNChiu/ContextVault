import type { Connection } from "@lancedb/lancedb";
import type { Config } from "./config";
import type { AuthContext } from "./acl";
import { validateAclTags, ValidationError } from "./acl";
import { enqueue, isReembedRunning, reembedAll } from "./ingest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

function escape(val: string): string {
  return val.replace(/'/g, "''");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function error(msg: string, status: number): Response {
  return Response.json({ error: msg }, { status });
}

function uploadsDir(cfg: Config): string {
  const dir = join(cfg.server.dataDir, "..", "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rawPath(cfg: Config, docId: string, ext: string): string {
  return join(uploadsDir(cfg), `${docId}.${ext}`);
}

export async function handleRest(
  db: Connection,
  cfg: Config,
  auth: AuthContext,
  req: Request,
  url: URL,
): Promise<Response> {
  const method = req.method;
  const path = url.pathname;

  try {
    if (method === "GET" && path === "/api/vocabulary") {
      return json({ tags: cfg.vocabulary.tags });
    }
    if (method === "GET" && path === "/api/documents") {
      return await listDocuments(db, cfg, auth);
    }
    if (method === "POST" && path === "/api/documents") {
      return await uploadDocument(db, cfg, auth, req);
    }
    if (method === "DELETE" && path.startsWith("/api/documents/")) {
      const id = path.slice("/api/documents/".length);
      return await deleteDocument(db, cfg, auth, id);
    }
    if (method === "PATCH" && path.startsWith("/api/documents/") && path.endsWith("/tags")) {
      const id = path.slice("/api/documents/".length, -"/tags".length);
      return await editTags(db, cfg, auth, req, id);
    }
    if (method === "GET" && path.startsWith("/api/tasks/")) {
      const id = path.slice("/api/tasks/".length);
      return await getTaskStatus(db, auth, id);
    }
    if (method === "POST" && path === "/api/reembed") {
      return await triggerReembed(auth);
    }
  } catch (e) {
    if (e instanceof ValidationError) return error(e.message, 400);
    throw e;
  }

  return error("Not Found", 404);
}

async function listDocuments(db: Connection, cfg: Config, auth: AuthContext) {
  const docs = await db.openTable("documents");
  const rows = await docs.query().limit(10000).toArray();

  const documents = [];
  let modelMismatch = false;

  for (const row of rows) {
    const docTags = [...(row.acl_tags as any)] as string[];
    if (!docTags.some((t) => auth.allowedTags.includes(t))) continue;

    const status = row.status as string;
    if (status === "done" && (row.embedding_model as string) !== cfg.embedding.model) {
      modelMismatch = true;
    }

    documents.push({
      doc_id: row.doc_id,
      source: row.source,
      status,
      acl_tags: docTags,
      llm_keywords: [...(row.llm_keywords as any)],
      llm_summary: row.llm_summary,
      updated_at: row.updated_at,
    });
  }

  return json({ documents, modelMismatch });
}

async function uploadDocument(db: Connection, cfg: Config, auth: AuthContext, req: Request) {
  const body = await req.json() as any;
  const aclTags = Array.isArray(body?.acl_tags) ? body.acl_tags.map(String) : [];

  if (aclTags.length === 0) return error("At least one acl_tag is required", 400);
  validateAclTags(aclTags, auth.allowedTags, cfg.vocabulary.tags);

  const docs = await db.openTable("documents");

  let content: string;
  let source: string;
  let status = "pending";
  let rawExt: string | null = null;
  let rawBuf: Uint8Array | null = null;

  if (body?.file_base64 !== undefined) {
    // Binary upload path
    source = String(body?.filename ?? "");
    if (!source.trim()) return error("Filename cannot be empty", 400);
    if (source.length > cfg.limits.sourceMaxLen) return error(`Source exceeds max length of ${cfg.limits.sourceMaxLen}`, 400);

    const dot = source.lastIndexOf(".");
    if (dot < 0) return error("Unsupported file type: no extension", 400);
    rawExt = source.slice(dot + 1).toLowerCase();
    if (!cfg.convert.formats.includes(rawExt)) {

      return error(`Unsupported file type: .${rawExt}`, 400);
    }

    const b64 = String(body.file_base64 ?? "");
    if (!b64) return error("file_base64 cannot be empty", 400);
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (buf.byteLength > cfg.convert.maxBinaryBytes) {


      return error(`File exceeds max binary size of ${cfg.convert.maxBinaryBytes} bytes`, 400);
    }

    rawBuf = buf;
    content = "";
    status = "converting";
  } else {
    // Text upload path
    content = String(body?.content ?? "");
    source = String(body?.source ?? "");

    if (!content.trim()) return error("Content cannot be empty", 400);
    if (!source.trim()) return error("Source cannot be empty", 400);
    if (source.length > cfg.limits.sourceMaxLen) return error(`Source exceeds max length of ${cfg.limits.sourceMaxLen}`, 400);
    if (content.length > cfg.limits.maxUploadBytes) return error(`Content exceeds max upload size of ${cfg.limits.maxUploadBytes} bytes`, 400);
    if (content.includes("\u0000")) return error("Binary content detected; only plain text/markdown is supported", 400);
  }

  const existing = await docs.query().where(`source = '${escape(source)}'`).limit(1).toArray();

  if (existing.length > 0) {
    const existingTags = [...(existing[0].acl_tags as any)] as string[];
    if (!existingTags.some((t) => auth.allowedTags.includes(t))) {
      return error("Access denied", 403);
    }
    const status = existing[0].status as string;
    if (status === "pending" || status === "indexing" || status === "converting") {
      return error(`Document "${source}" is currently being indexed`, 409);
    }
  }

  const now = new Date().toISOString();

  if (existing.length > 0) {
    const existingId = existing[0].doc_id as string;
    await docs.delete(`doc_id = '${existingId}'`);
    await docs.add([{
      doc_id: existingId,
      source,
      content,
      acl_tags: aclTags,
      llm_keywords: [],
      llm_summary: "",
      status,
      error: null,
      embedding_model: "",
      created_at: existing[0].created_at as string,
      updated_at: now,
    }]);
    if (rawExt && rawBuf) await Bun.write(rawPath(cfg, existingId, rawExt), rawBuf);
    enqueue(existingId);
    return json({ task_id: existingId, status });
  }

  const docId = crypto.randomUUID();
  await docs.add([{
    doc_id: docId,
    source,
    content,
    acl_tags: aclTags,
    llm_keywords: [],
    llm_summary: "",
    status,
    error: null,
    embedding_model: "",
    created_at: now,
    updated_at: now,
  }]);
  if (rawExt && rawBuf) await Bun.write(rawPath(cfg, docId, rawExt), rawBuf);
  enqueue(docId);
  return json({ task_id: docId, status });
}

async function deleteDocument(db: Connection, cfg: Config, auth: AuthContext, id: string) {

  const docs = await db.openTable("documents");
  const rows = await docs.query().where(`doc_id = '${escape(id)}'`).limit(1).toArray();
  if (rows.length === 0) return error("Document not found", 404);

  const docTags = [...(rows[0].acl_tags as any)] as string[];
  if (!docTags.some((t) => auth.allowedTags.includes(t))) return error("Access denied", 403);

  const status = rows[0].status as string;
  if (status === "pending" || status === "indexing" || status === "converting") {
    return error("Cannot delete a document that is currently being indexed", 409);
  }

  const chunks = await db.openTable("chunks");
  await chunks.delete(`doc_id = '${escape(id)}'`);
  await docs.delete(`doc_id = '${escape(id)}'`);

  // Clean up raw binary file if present
  const dir = uploadsDir(cfg);
  const glob = new Bun.Glob(`${id}.*`);
  for await (const f of glob.scan({ cwd: dir, onlyFiles: true })) {
    rmSync(join(dir, f), { force: true });
  }

  return json({ deleted: true });
}

async function editTags(db: Connection, cfg: Config, auth: AuthContext, req: Request, id: string) {
  const body = await req.json() as any;
  const newTags = Array.isArray(body?.acl_tags) ? body.acl_tags.map(String) : [];

  if (newTags.length === 0) return error("At least one acl_tag is required", 400);
  validateAclTags(newTags, auth.allowedTags, cfg.vocabulary.tags);

  const docs = await db.openTable("documents");
  const rows = await docs.query().where(`doc_id = '${escape(id)}'`).limit(1).toArray();
  if (rows.length === 0) return error("Document not found", 404);

  const docTags = [...(rows[0].acl_tags as any)] as string[];
  if (!docTags.some((t) => auth.allowedTags.includes(t))) return error("Access denied", 403);

  const outside = docTags.filter((t) => !auth.allowedTags.includes(t));
  if (outside.some((t) => !newTags.includes(t))) {
    return error("Cannot remove tags outside your access scope", 403);
  }

  await docs.update({ where: `doc_id = '${escape(id)}'`, values: { acl_tags: newTags } });

  const chunks = await db.openTable("chunks");
  await chunks.update({ where: `doc_id = '${escape(id)}'`, values: { acl_tags: newTags } });

  return json({ updated: true });
}

async function getTaskStatus(db: Connection, auth: AuthContext, id: string) {
  const docs = await db.openTable("documents");
  const rows = await docs.query().where(`doc_id = '${escape(id)}'`).limit(1).toArray();
  if (rows.length === 0) return error("Task not found", 404);

  const docTags = [...(rows[0].acl_tags as any)] as string[];
  if (!docTags.some((t) => auth.allowedTags.includes(t))) return error("Task not found", 404);

  return json({ status: rows[0].status, error: rows[0].error });
}

async function triggerReembed(auth: AuthContext) {
  if (!auth.admin) return error("Admin access required", 403);
  if (isReembedRunning()) return error("Re-embed is already in progress", 409);

  const count = await reembedAll();
  return json({ count, message: `Re-embed started for ${count} documents` });
}