# AGENTS.md

## Project status

Pre-implementation. `PRD.md` (v2) is the single source of truth — architecture, MCP tool contracts, and invariants were settled there through requirements review. Read it fully before writing code. Do not reintroduce rejected options: stdio transport, RBAC, LangChain/LlamaIndex, server-side agentic search loops, MCP-side delete/update tools (lifecycle is UI-only).

## Gate before implementation

Run the 4 spikes in PRD §11 first (LanceDB FTS token behavior, Bun + LanceDB native bindings in Docker, Bun + onnxruntime-node, Ollama bge-m3 CPU latency). Each has a documented fallback. Do not scaffold the app before spikes pass.

**Status: completed 2026-09 — all passed, results in PLAN.md Phase 0; scripts removed post-verification, re-verification lives in Phase 7 regression tests.**

## Pinned stack

- Runtime: **Bun** (not Node). TypeScript throughout.
- MCP: `@modelcontextprotocol/sdk`, Streamable HTTP only.
- Vector DB: `@lancedb/lancedb` — embedded, single storage dir, two tables (`documents`, `chunks`).
- Zero-framework: Ollama / OpenAI-compatible APIs via raw `fetch`.
- All tunables live in a config file: embedding baseURL/model, metadata LLM model, reranker enable/candidates, chunk sizes, static API keys + allowed tags, controlled tag vocabulary.

## Hard-won API facts (verified against LanceDB source and official tests)

- TS SDK has **no** `search(query, "hybrid")` — that API is Python-only. Hybrid search is the chained builder:
  `table.query().nearestTo(vec).fullTextSearch(q).rerank(await RRFReranker.create()).limit(n).toArray()`
- FTS index creation is async: `await table.createIndex("text", { config: Index.fts() })` then `await table.waitForIndex([...])`. Background ingest marks a task `done` only after FTS is queryable — otherwise uploads finish but are unsearchable.
- Ollama has **no rerank endpoint** (embed/generate only). Reranker = in-process via `@huggingface/transformers` (bge-reranker-base); fallback = v2-m3 ONNX / TEI container.

## Non-negotiable invariants (easy to violate)

- ACL tags come **only** from the uploader, validated against the controlled vocabulary in config. LLM-generated keywords/summaries live in separate fields and must never influence access control.
- The search path makes **zero LLM calls**. Multi-turn retrieval orchestration belongs to the calling agent, not this server.
- `rag_search` / `get_document` always apply the API key's `allowed_tags` filter — no bypass path.
- Embedding model name is stored per table/chunk; on mismatch, refuse search and prompt re-embed.
- Reranker failure degrades to RRF ordering with `reranked: false` in results — search must never hard-fail because of the reranker.
- FTS is English/alphanumeric only (machine IDs, model numbers); Chinese retrieval is vector-only. Future upgrade path: `Index.fts({ baseTokenizer: "ngram" })`.
