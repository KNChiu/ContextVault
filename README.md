# ContextVault

Lightweight private RAG context vault for AI agents, exposed as an MCP server (Streamable HTTP).
Documents are chunked, embedded (multilingual-e5-small), ACL-tagged, and searchable via hybrid
vector + FTS retrieval — all in-process with zero external services. Optionally reranked
(bge-reranker-base) and optionally tagged by a local Qwen model or any OpenAI-compatible API.

## Quick start (local)

Requires [Bun](https://bun.sh) ≥ 1.3. Binary uploads (pptx/pdf/docx/xlsx) need the
[markitdown](https://github.com/microsoft/markitdown) CLI in an accessible Python venv.

```bash
bun install
cp config.example.toml config.toml        # edit: dataDir, models, convert.bin, keys
cp .env.example .env                      # edit: API keys (Bun auto-loads .env)
bun run dev
```

- Server: `http://localhost:8787` (MCP endpoint: `/mcp`)
- Health: `curl http://localhost:8787/health`
- Models download on first use into `cacheDir` (no pre-baking). First search/ingest pays the
  one-time load cost; everything after is lazy and fast.
- WSL dev note: keep `dataDir` on the WSL native filesystem, not `/mnt/*` (drvfs file locking).

## MCP client setup

Point the MCP client at the HTTP endpoint with a config key as Bearer token.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "contextvault": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer your-admin-key" }
    }
  }
}
```

**Cursor** — add a new MCP server in Cursor settings (`mcp.json` or UI):

```json
{
  "mcpServers": {
    "contextvault": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer your-admin-key" }
    }
  }
}
```

## Docker deployment

1. `cp config.example.toml config.toml` and set `convert.bin = "/opt/cv-venv/bin/markitdown"`
   plus your key env names in `[[keys]]`.
2. `cp .env.example .env` and set the actual secrets (`CV_KEY_ADMIN=...`, `CV_KEY_VIEWER=...`).
3. `docker-compose up -d --build`

Single volume `/data/contextvault` holds LanceDB, the HF model cache, and uploads.
API keys and tagging keys are passed only via environment variables.

> Note: some Docker daemons fail to bind-mount a single file onto `/app/config.toml`.
> If `docker-compose up` errors with "not a directory", mount the config elsewhere and point
> `CONFIG_PATH` at it instead (e.g. `-v ./config.toml:/app/config.docker.toml:ro -e CONFIG_PATH=/app/config.docker.toml`).

## Config

All tunables live in `config.toml` (see `config.example.toml`): embedding model/dims, tagging
provider (`local` in-process Qwen | `api` OpenAI-compatible), reranker enable/candidates, chunk
sizes, API keys (by env var name), and the controlled ACL tag vocabulary.

## Project status

Pre-Phase 7 (verification) — see `PLAN.md` and `PRD.md` for the full plan and invariants.