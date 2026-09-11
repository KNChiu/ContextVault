import { loadConfig } from "./config";
import { connectDb, ensureTables, ensureFtsIndex, ensureDimsMatch } from "./db";
import { initIngest, recoverOnBoot, reembedStale, waitForIdle } from "./ingest";
import { initEmbedder } from "./embed";
import { initReranker } from "./rerank";
import { createMcpRouter } from "./mcp";
import { authenticate, runWithAuth, AuthError } from "./acl";
import { handleRest } from "./rest";

const MAX_BODY = 2 * 1024 * 1024;
const B64_OVERHEAD = 1.34;

async function main() {
  const cfg = await loadConfig();
  const db = await connectDb(cfg);
  await ensureTables(db, cfg.embedding.dims);

  await ensureDimsMatch(db, cfg.embedding.dims);
  const chunks = await db.openTable("chunks");
  await ensureFtsIndex(chunks);

  initIngest(db, cfg);
  initEmbedder(cfg);
  initReranker(cfg);
  recoverOnBoot();
  const reembedCount = await reembedStale();
  if (reembedCount > 0) {
    console.log(`[db] stale embeddings detected — enqueued ${reembedCount} docs for re-embed`);
  }

  const mcp = await createMcpRouter(db, cfg);

  const server = Bun.serve({
    port: cfg.server.port,
    // ponytail: idleTimeout 120s — in-process local tagging blocks the event loop
    // 60-90s per chunk; default 10s kills MCP connects mid-request.
    // Upgrade path: move local LLM to a worker thread.
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (url.pathname === "/") {
        const file = Bun.file("web/index.html");
        return new Response(file, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/mcp") {
        const cl = req.headers.get("Content-Length");
        if (cl && parseInt(cl) > MAX_BODY) {
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        try {
          const auth = authenticate(cfg, req);
          const response = await runWithAuth(auth, () => mcp.handle(req));
          return response ?? new Response("No response", { status: 500 });
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: 401 });
          }
          console.error("MCP error:", e);
          return Response.json({ error: "Internal error" }, { status: 500 });
        }
      }

      if (url.pathname.startsWith("/api")) {
        const cl = req.headers.get("Content-Length");
        const maxBody = Math.max(MAX_BODY, Math.ceil(cfg.convert.maxBinaryBytes * B64_OVERHEAD));
        if (cl && parseInt(cl) > maxBody) {
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        try {
          const auth = authenticate(cfg, req);
          return await handleRest(db, cfg, auth, req, url);
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: 401 });
          }
          console.error("API error:", e);
          return Response.json({ error: "Internal error" }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
    error(err) {
      console.error("Server error:", err);
      return new Response("Internal error", { status: 500 });
    },
  });

  console.log(`ContextVault listening on :${cfg.server.port}`);

  const shutdown = async () => {
    console.log("Shutting down...");
    server.stop(true);
    await waitForIdle(30000);
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});