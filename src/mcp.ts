import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config";
import type { Connection } from "@lancedb/lancedb";
import { search } from "./search";
import { getDocument } from "./documents";
import { enqueue } from "./ingest";
import { getAuth, validateAclTags, AuthError, ValidationError } from "./acl";

const TOOL_DESCRIPTIONS = {
  rag_search: `Search the knowledge base for relevant passages. Use this as your first step when you need information. After reviewing results, use get_document to read full documents, then search again with refined queries if needed.

Returns passages with relevance scores. Each result includes the source document name, section path, and a coherent passage with surrounding context.`,
  get_document: `Retrieve the full content of a document or a specific section. Use this after rag_search to read complete documents. The response includes the document content and a list of available sections you can request individually.`,
  upload_document: `Upload a document to the knowledge base. The document will be automatically chunked, embedded, and indexed for search. Returns a task_id to track progress. Use get_task_status to check when indexing is complete. Only plain text or markdown content is accepted; for binary files (pptx, pdf, docx, xlsx) convert them to markdown first (e.g. with markitdown)and paste the text.`,
  get_task_status: `Check the status of an upload task. Returns one of: pending, converting, indexing, done, or failed. A "done" status means the document is fully indexed and searchable.`,
};

export async function createMcpServer(
  db: Connection,
  cfg: Config,
  onSessionInit?: (sessionId: string) => void,
): Promise<{ server: Server; transport: WebStandardStreamableHTTPServerTransport }> {
  const server = new Server(
    { name: "contextvault", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "rag_search",
        description: TOOL_DESCRIPTIONS.rag_search,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            top_k: { type: "number", description: "Number of results (max 20)", default: 3 },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tag filter (intersected with ACL tags)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_document",
        description: TOOL_DESCRIPTIONS.get_document,
        inputSchema: {
          type: "object",
          properties: {
            source: { type: "string", description: "Document source name" },
            section: { type: "string", description: "Optional section path to retrieve" },
          },
          required: ["source"],
        },
      },
      {
        name: "upload_document",
        description: TOOL_DESCRIPTIONS.upload_document,
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Document content (plain text or markdown)" },
            source: { type: "string", description: "Document source name (filename or URL)" },
            acl_tags: {
              type: "array",
              items: { type: "string" },
              description: "Access control tags (must be from the controlled vocabulary)",
            },
          },
          required: ["content", "source", "acl_tags"],
        },
      },
      {
        name: "get_task_status",
        description: TOOL_DESCRIPTIONS.get_task_status,
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task ID from upload_document" },
          },
          required: ["task_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const auth = getAuth();

    try {
      switch (req.params.name) {
        case "rag_search":
          return await handleRagSearch(db, cfg, auth, req.params.arguments);
        case "get_document":
          return await handleGetDocument(db, cfg, auth, req.params.arguments);
        case "upload_document":
          return await handleUploadDocument(db, cfg, auth, req.params.arguments);
        case "get_task_status":
          return await handleGetTaskStatus(db, auth, req.params.arguments);
        default:
          return { content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }], isError: true };
      }
    } catch (e) {
      if (e instanceof AuthError || e instanceof ValidationError) {
        return { content: [{ type: "text" as const, text: e.message }], isError: true };
      }
      throw e;
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => onSessionInit?.(sessionId),
  });
  await server.connect(transport);

  return { server, transport };
}

export async function createMcpRouter(
  db: Connection,
  cfg: Config,
): Promise<{ handle(req: Request): Promise<Response> }> {
  const sessions = new Map<string, { server: Server; transport: WebStandardStreamableHTTPServerTransport }>();

  return {
    async handle(req: Request): Promise<Response> {
      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const s = sessions.get(sid);
        if (s) return await s.transport.handleRequest(req);
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      const { server, transport } = await createMcpServer(db, cfg, (newSid) => {
        sessions.set(newSid, { server, transport });
        transport.onclose = () => sessions.delete(newSid);
      });
      return await transport.handleRequest(req);
    },
  };
}

async function handleRagSearch(db: Connection, cfg: Config, auth: any, args: any) {
  const query = String(args?.query ?? "");
  const topK = Math.max(1, Math.min(Number(args?.top_k) || 3, cfg.limits.topKMax));
  const tags = Array.isArray(args?.tags) ? args.tags.map(String) : undefined;

  const results = await search(db, cfg, {
    query,
    topK,
    tags,
    allowedTags: auth.allowedTags,
  });

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: "No results found." }] };
  }

  const lines = results.map((r, i) => {
    const parts = [
      `[${i + 1}] Source: ${r.source}`,
      `    Section: ${r.section}`,
      `    Score: ${r.score.toFixed(4)}${r.rerank_score !== null ? ` (rerank: ${r.rerank_score.toFixed(4)})` : ""}`,
      `    ${r.text}`,
    ];
    return parts.join("\n");
  });

  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
}

async function handleGetDocument(db: Connection, cfg: Config, auth: any, args: any) {
  const source = String(args?.source ?? "");
  const section = args?.section ? String(args.section) : undefined;

  const doc = await getDocument(db, cfg, {
    source,
    section,
    allowedTags: auth.allowedTags,
  });

  const lines = [
    `Source: ${doc.source}`,
    `Status: ${doc.status}`,
    `Sections: ${doc.sections.join(", ")}`,
    section ? `Section: ${section}` : "",
    "",
    doc.content,
  ];

  if (doc.truncated) {
    lines.push(`\n[Content truncated at ${cfg.limits.getDocumentMax} bytes. Available sections: ${doc.sections.join(", ")}]`);
  }

  return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
}

async function handleUploadDocument(db: Connection, cfg: Config, auth: any, args: any) {
  const content = String(args?.content ?? "");
  const source = String(args?.source ?? "");
  const aclTags = Array.isArray(args?.acl_tags) ? args.acl_tags.map(String) : [];

  if (!content.trim()) {
    return { content: [{ type: "text" as const, text: "Content cannot be empty" }], isError: true };
  }
  if (!source.trim()) {
    return { content: [{ type: "text" as const, text: "Source cannot be empty" }], isError: true };
  }
  if (source.length > cfg.limits.sourceMaxLen) {
    return { content: [{ type: "text" as const, text: `Source exceeds max length of ${cfg.limits.sourceMaxLen}` }], isError: true };
  }
  if (aclTags.length === 0) {
    return { content: [{ type: "text" as const, text: "At least one acl_tag is required" }], isError: true };
  }
  if (content.length > cfg.limits.maxUploadBytes) {
    return { content: [{ type: "text" as const, text: `Content exceeds max upload size of ${cfg.limits.maxUploadBytes} bytes` }], isError: true };
  }

  validateAclTags(aclTags, auth.allowedTags, cfg.vocabulary.tags);

  const docs = await db.openTable("documents");

  const existing = await docs
    .query()
    .where(`source = '${source.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray();

  if (existing.length > 0) {
    const existingTags = [...(existing[0].acl_tags as any)] as string[];
    if (!existingTags.some((t) => auth.allowedTags.includes(t))) {
      return { content: [{ type: "text" as const, text: "Access denied" }], isError: true };
    }
    const status = existing[0].status as string;
    if (status === "pending" || status === "indexing" || status === "converting") {
      return {
        content: [{ type: "text" as const, text: `Document "${source}" is currently being indexed. Wait for completion before re-uploading.` }],
        isError: true,
      };
    }
  }

  const docId = crypto.randomUUID();
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
      status: "pending",
      error: null,
      embedding_model: "",
      created_at: existing[0].created_at as string,
      updated_at: now,
    }]);
    enqueue(existingId);
    return { content: [{ type: "text" as const, text: `Re-upload scheduled. Task ID: ${existingId}` }] };
  }

  await docs.add([{
    doc_id: docId,
    source,
    content,
    acl_tags: aclTags,
    llm_keywords: [],
    llm_summary: "",
    status: "pending",
    error: null,
    embedding_model: "",
    created_at: now,
    updated_at: now,
  }]);

  enqueue(docId);

  return { content: [{ type: "text" as const, text: `Upload scheduled. Task ID: ${docId}` }] };
}

async function handleGetTaskStatus(db: Connection, auth: any, args: any) {
  const taskId = String(args?.task_id ?? "");
  if (!taskId) {
    return { content: [{ type: "text" as const, text: "task_id is required" }], isError: true };
  }

  const docs = await db.openTable("documents");
  const rows = await docs
    .query()
    .where(`doc_id = '${taskId.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray();

if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: `Task not found: ${taskId}` }],isError: true };
  }

  const docTags = [...(rows[0].acl_tags as any)] as string[];
  if (!docTags.some((t) => auth.allowedTags.includes(t))) {
    return { content: [{ type: "text" as const, text: `Task not found: ${taskId}` }],isError: true };
  }

  const row = rows[0];
  const status = row.status as string;
  const error = row.error as string | null;

  let text = `Status: ${status}`;
  if (status === "failed" && error) {
    text += `\nError: ${error}`;
  }

  return { content: [{ type: "text" as const, text }] };
}