# ContextVault Implementation Plan

**Status: Phases 1–6 implemented** (scaffold, ingest, search, MCP, REST+UI, binary upload, dual-mode tagging, Docker — see git history / code). Remaining: Phase 6.5 trace, Phase 7 verification tests.



## Decision Log (conclusions only)

D01–D32 (early process decisions) removed — final state lives in code, config, and AGENTS.md. D-numbers stable (code comments reference D34).



| # | Decision |
|---|---|
| D33 | Binary upload (pptx/pdf/docx/xlsx) via markitdown CLI subprocess; async `converting` state in ingest worker; raw file on disk (`dataDir/../uploads/`), deleted after conversion; empty text → `failed`; per-chunk tagging (cap 30 chunks, union keywords cap 10, summary = first chunk); MCP stays text-only; `maxBinaryBytes = 20MB`; timeout 300s |
| D34 | Dual-mode **tagging only** (local \| api via OpenAI-style chat completions, per-chunk cap 30, failure → empty keywords); embedding → `Xenova/multilingual-e5-small` (384d), `VECTOR_DIM` from `cfg.embedding.dims`, boot dims-mismatch self-heal (drop chunks → recreate → re-embed); reranker → `Xenova/bge-reranker-base` (fallback v2-m3); **all models lazy-load** — boot preloads removed (supersedes D16/D32); **all secrets via env vars**, config stores env var names (`keyEnv`, `apiKeyEnv`) |
| D35 | L0/L1 summary layer rejected → **preview + drill-down** (`rag_search` returns previews (`search.previewChars`) + `truncated` flag, full text via `get_document`; zero LLM/schema/ACL surface); doc+chunk two-stage **deferred** — if built, doc vector = mean of chunk vectors; trace = structured log line + in-memory ring buffer + `GET /debug/traces` (**admin key only**, never in MCP responses); upgrade triggers: avg returned > 4k tokens, or corpus > 20k chunks, or scattered-results complaint |
| D36 | MCP multi-session: SDK `WebStandardStreamableHTTPServerTransport` is single-session — router in `mcp.ts` creates a fresh Server+Transport per session, routes by `mcp-session-id` header, unknown sid → 404 |
| D37 | LanceDB 0.23 core panics ("primitive array", arrow cast.rs:758)on hybrid (vector+FTS) + **any** `where()` clause; workaround: hybrid path fetches without `where` (limit `max(candidates*3, 100)`), ACL-filters in JS (`acl_tags` is a LanceDB `Vector` wrapper — spread, not `.some`); vector-only path keeps SQL `where`; upgrade `@lancedb/lancedb` when a fixed version lands |
| D38 | Re-upload ACL collision: `source` is globally unique; upload of an existing-but-invisible source → `403 "Access denied"` (無權 ≡ 不存在 — no existence leak), check placed **before** the 409 indexing branch; same in MCP `upload_document` |
| D39 | failed docs = manual re-upload only: `recoverOnBoot`/`reembedAll` no longer enqueue failed; `reembedAll` = all done docs (manual "Re-embed all" button), `reembedStale` = stale-only done docs (boot self-heal); re-embed skips LLM tagging when doc already has keywords/summary (re-upload clears them → fresh uploads still tag) |
| D40 | Admin gate: `[[keys]] admin = true` (default false); `/api/reembed` admin-only; future `/debug/traces` (D35) reuses the field |
| D41 | editTags boundary: caller cannot remove tags outside their `allowedTags` (`403 "Cannot remove tags outside your access scope"`); can freely add/remove within own scope |
| D42 | Re-upload failure keeps previous version's chunks searchable (old content + old tags, internally consistent); doc shows `failed`; re-upload fixes; no code change — documented behavior |

## Phase 0 — Spikes (gate, completed 2026-09)

All 11 spikes PASS — scripts removed post-verification. Results:

S1 hyphenated tokens searchable, Chinese no crash · S2 Docker binding OK · S3 ORT N-API OK ·
S4 transformers.js OK (basis for D34 models) · S5 `array_has_any` + list update OK ·
S6 FTS auto-update confirmed (re-verified 09-11) · S7 Bun.serve×MCP handshake OK ·
S8 hybrid+CJK: zero-FTS-match query still returns vector results (re-verified 09-11) ·
S9 hybrid+where panic found → D37 workaround · S10 reranker-base: 89s load incl. download, 16ms/pair, score sanity OK → D34 ·
S11 reserved-char queries no-throw (verified 09-11).

Re-verification needs (D37 upgrade, FTS coverage) → Phase 7 regression tests.



**Dev environment note**: LanceDB data dir must NOT be on `/mnt/d` (WSL drvfs — file locking unreliable). Use WSL native path or Docker volume.



## Phase 6.5 — Trace + Preview (remaining)

- **Preview + drill-down: shipped** (`rag_search` returns chunk previews (`search.previewChars`, ~200) + `truncated` flag; full text via `get_document`; REST search same shape; MCP tool descriptions instruct agents to drill down)
- **Trace: not built** — structured JSON log line per search + in-memory ring buffer (100) + `GET /debug/traces` (**admin key only**, never in MCP responses); fields: query, mode (vector/fts/hybrid), candidates pre/post rerank,, top-k + scores,, latency breakdown,, `reranked`, `allowed_tags` applied,, embedding model,, returned-token estimate (ascii/4 + CJK count)
- Upgrade triggers for L0/L1 / doc+chunk two-stage (D35): avg returned > 4k tokens, corpus > 20k chunks, or scattered-results complaint



## Phase 7 — Verification (TODO)

- `bun test`: chunker (headings, code fences, overlap, heuristic), ACL (intersection, D04/D08 validation), section prefix match,, overlap dedup,, config validation
- Regression tests ported from removed spikes: hybrid+where repro (D37 — run on `@lancedb/lancedb` upgrade), FTS auto-update coverage (new inserts searchable), FTS reserved-char no-throw
- Integration: fake embedder (fixed vectors) + reranker disabled → search pipeline,, ingest state machine,, overwrite semantics
- Manual E2E: Claude Desktop connection,, UI full flow,, crash recovery (kill -9 + restart)