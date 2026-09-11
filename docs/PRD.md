# ContextVault — Lightweight Private Data RAG MCP Platform (PRD v2)

## 1. 專案概述 (Overview)

本專案旨在建立一個**輕量、高效能且低資源佔用**的私有資料 RAG (Retrieval-Augmented Generation) 服務，專為客戶內部使用設計（目標規模：< 10 人、< 10,000 chunks）。

核心形態為**常駐 HTTP Server**，同時提供兩個介面：

1. **MCP (Streamable HTTP)**：供外部 Agent（Claude Desktop、Cursor、自建 Agent）進行私有資料檢索與上傳
2. **Web UI**：極簡管理頁，供使用者維護文件生命週期（列表、上傳、刪除、tag 管理、任務狀態）

設計哲學：**Client Agent 是大腦，Server 是圖書館員**。檢索的多輪迭代、query 改寫、問題拆解全部交給外部 Agent 編排；Server 端搜尋路徑零額外 LLM 呼叫，僅提供「笨而好用」的檢索原語。

> **v2 變更摘要**：移除 stdio 傳輸與多租戶 RBAC；新增 Web UI、`get_document`、`get_task_status`、ONNX reranker、LLM metadata tagging、Docker Compose 部署；確立 tag-based ACL 與背景任務復原機制。
>
> **v3 變更摘要**：Embedding 與 Metadata LLM 從外部 Ollama 改為 `@huggingface/transformers` v3 in-process（ONNX Runtime）；Embedding 模型為 multilingual-e5-small（384d）；Metadata LLM 為 Qwen2.5-0.5B-Instruct（可切換 OpenAI-style API 模式）；部署簡化為單一容器；記憶體預算修訂。

---

## 2. 技術架構與選型 (Tech Stack)

| 元件 | 選型 | 說明 |
|---|---|---|
| Runtime | Bun (TypeScript) | 免編譯步驟、原生支援 TS、冷啟動快 |
| MCP 框架 | `@modelcontextprotocol/sdk` | 僅 Streamable HTTP 傳輸（stdio 已移除） |
| 向量資料庫 | `@lancedb/lancedb` | Embedded、零容器維護、原生 Hybrid Search（Vector + FTS + RRF） |
| Embedding | `@huggingface/transformers` v3（ONNX Runtime）in-process | `Xenova/multilingual-e5-small`（384d，config 可換）；**資料完全不出進程** |
| Reranker | `@huggingface/transformers` in-process + `Xenova/bge-reranker-base` | In-process、零額外容器；CPU only 環境；fallback = v2-m3 ONNX / TEI 容器 |
| Metadata LLM | `@huggingface/transformers` v3 text-generation in-process | `onnx-community/Qwen2.5-0.5B-Instruct`（local）\| OpenAI-style API（api）；僅於背景任務中生成 keywords / 摘要，不在搜尋路徑上；lazy-load + 閒置 dispose |
| 架構原則 | **Zero-Framework** | 不使用 LangChain / LlamaIndex，無黑盒子 |

---

## 3. MCP Tools 介面規格

共 4 個 tools。Tool description 需寫入引導語，讓 Agent 自然形成「search → 檢視 → get_document 深入 → 換 query 再 search」的檢索迴圈。MCP 傳輸為 multi-session：每 session 獨立 Server+Transport 實例，以 `mcp-session-id` header 路由，未知 sid → 404。

### 3.1 `rag_search`（知識檢索）

* **輸入**：
  * `query` (String, Required)：查詢問題或關鍵字
  * `top_k` (Number, Optional, Default: 3)：回傳匹配數量
  * `tags` (Array\<String\>, Optional)：額外 tag 過濾（與 ACL tags 取交集）
* **輸出**：JSON 陣列，每筆含 `text`（含鄰居擴展後的連貫段落）、`source`、`section`（markdown 標題路徑）、`chunk_id`、`score`（RRF）、`rerank_score`、`reranked`（bool，reranker 降級時為 false 並回退 RRF 排序）、`preview`（~200 chars 預覽）、`truncated`（bool，全文需 `get_document` 深入）

### 3.2 `get_document`（文件深入閱讀）

* **輸入**：
  * `source` (String, Required)：文件識別名稱
  * `section` (String, Optional)：markdown 標題路徑（如 `"維護紀錄"`）；省略則回傳全文
* **輸出**：文件全文或指定 section 內容。強制 ACL 檢查，無權限回傳明確錯誤。

### 3.3 `upload_document`（文件上傳與索引）

* **輸入**：
  * `content` (String, Required)：純文字或 Markdown 內容（單檔上限 1MB）
  * `source` (String, Required)：文件識別名稱、檔名或 URL
  * `acl_tags` (Array\<String\>, Required)：權限標籤，須來自受控詞彙表（config 定義）
* **輸出**：`task_id`、`status: "pending"`。實際切片 / 嵌入 / LLM 打 tag 於背景執行。
* **行為**：同 `source` 重傳 = 覆蓋（刪舊 chunks 再重建）。若該 `source` 已存在但呼叫者無權檢視 → `403 "Access denied"`（無權 ≡ 不存在，不洩漏存在性）。

### 3.4 `get_task_status`（任務狀態查詢）

* **輸入**：`task_id` (String, Required)
* **輸出**：`pending | indexing | done | failed`（含失敗原因）。`done` 保證 FTS 索引已可查詢（見 §7）。

> 文件刪除 / 更新**不提供** MCP tool，由 Web UI 管理（MVP 決策）。

---

## 4. 檢索管線 (Agentic RAG Search Pipeline)

```
query
  → ACL 過濾（API key 的 allowed_tags，強制套用，不可跳過）
  → Hybrid Search（LanceDB 鏈式 API）：
      table.query()
        .nearestTo(embed(query))     // multilingual-e5-small 向量（384d）
        .fullTextSearch(query)       // BM25（僅英數 token 有效）
        .rerank(RRFReranker)         // 內建 RRF 融合
        .limit(candidates)             // 預設 12（CPU only 故不開大）
      // 註：LanceDB 0.23 hybrid + where() 會 core panic（D37）——
      // 故 hybrid 路徑不帶 where，改以 JS 端過濾 acl_tags ∩ allowed_tags
  → ONNX Cross-Encoder Rerank（bge-reranker-base, in-process）
  → 取 top_k
  →鄰居擴展：同 section 內合併前後相鄰 chunks 成連貫段落
  →回傳結構化結果（含 preview + truncated，，全文走 get_document）
```

* **降級策略**：reranker 載入失敗或 config 關閉時，直接回傳 RRF 排序結果並標註 `reranked: false`。搜尋**永不**因 reranker 異常而失敗。
* **延遲預算（CPU only）**：embed ~30-100ms（in-process ONNX，，e5-small 118M INT8）+ hybrid ~50ms + rerank 12 對 ~0.5-1.5s → 單次搜尋約 0.6-1.7s，，agentic loop 場景可接受。
* **FTS 範圍**：僅負責英數精確比對（機台號碼、型號、英文術語）；中文語意檢索全靠向量（multilingual-e5-small）。未來如需中文關鍵字搜尋，LanceDB `Index.fts({ baseTokenizer: "ngram" })` 為現成升級路徑。

---

## 5. 資料處理規格 (Ingest Pipeline)

1. **Chunking（規則式，LLM 不參與切片）**：
   * Markdown 標題（`#`/`##`）優先切 section，section 內再以滑動視窗切
   * 無結構純文字：直接滑動視窗
   * 預設 512 tokens / overlap 64，config 可調
   * 每個 chunk 記錄 `section`（標題路徑）與 `chunk_index`，供鄰居擴展與 `get_document` 使用

2. **LLM Metadata Tagging（與 ACL 嚴格分離）**：
   * Dual-mode：local（`@huggingface/transformers` text-generation pipeline 載入 `onnx-community/Qwen2.5-0.5B-Instruct`）\| api（OpenAI-style chat completions，，`baseURL` + `apiKeyEnv`）；每 chunk 上限 30 個 tag、生成 `llm_keywords` 與 `llm_summary`
   * 生成失敗時降級為空值（不阻擋上傳完成）；lazy-load + 閒置後 dispose 釋放記憶體
   * 存於**獨立欄位**，僅供檢索輔助與 UI 顯示，**永不參與 ACL 過濾**——權限只能由上傳者明確指定的 `acl_tags` 決定

3. **Embedding 一致性**：
   * `embedding_model` 名稱寫入 `documents` 表（LanceDB TS SDK 無 table metadata API，以 documents 記錄實作）
   * 換 embedding model = 全庫重嵌入；搜尋時 model 不一致則**拒絕搜尋**並提示重嵌

4. **資料 Schema（LanceDB 兩張表，單一儲存目錄）**：
   * `documents`：`doc_id`, `source`, `content`, `acl_tags`, `llm_keywords`, `llm_summary`, `status`, `error`（nullable）、`embedding_model`, `created_at`, `updated_at`
   * `chunks`：`chunk_id`, `doc_id`, `source`, `section`, `chunk_index`, `text`, `vector`, `acl_tags`（冗餘存放，供搜尋時直接過濾）

5. **Binary Upload（pptx/pdf/docx/xlsx）**：
   * `src/convert.ts`：markitdown CLI subprocess（`cfg.convert.bin`），timeout kill，，temp UUID 檔
   * REST 上傳走 base64 → 解碼 → raw 檔（`dataDir/../uploads/<docId>.<ext>`），NUL 檢查、ext whitelist、、`maxBinaryBytes = 20MB`
   * Ingest：`converting` 狀態（先於 status 轉換前取 row），轉換後刪 raw 檔；空文字 → `failed`；MCP 維持純文字上傳
   * config：`[convert]` enabled / bin / formats / timeoutSec / maxBinaryBytes

---

## 6. 認證與 ACL (Auth & Access Control)

* **靜態 API Key**：定義於 config 檔，MCP 與 Web UI 共用同一組 key
* **Key 對應**：`key → user → allowed_tags`
* **ACL 模型**：tag 對應制——文件 `acl_tags` ∩ key 的 `allowed_tags` 非空即可見；`rag_search` 與 `get_document` 強制套用，不可跳過
* **受控詞彙表**：合法的 `acl_tags` 由 config 定義，上傳時驗證；不開放自由填寫（避免 tag 爆炸與權限漂移）
* `< 10` 人規模，**不做** RBAC、帳號密碼、session 機制
* **Admin gate**：`[[keys]] admin = true`（default false）；`/api/reembed` 僅 admin 可用（未來 `/debug/traces` 同欄位）
* **editTags 邊界**：呼叫者不可移除自身 `allowedTags` 之外的 tag（`403 "Cannot remove tags outside your access scope"`）；自身範圍內可自由增刪
* **重傳 ACL 碰撞**：`source` 全域唯一；上傳已存在但呼叫者無權檢視的 source → `403 "Access denied"`（無權 ≡ 不存在，，不洩漏存在性）

---

## 7. 背景任務與復原 (Background Jobs & Recovery)

* **狀態機**：`pending → indexing → done | failed`（狀態存於 `documents.status`）
* **復原機制**：無獨立 queue 系統。Server 啟動時掃描 `pending` / `indexing` 狀態的文件，重新排入處理——crash 不丟資料
* **FTS 就緒門檻**：LanceDB FTS 索引為異步建立（`waitForIndex`），任務需在 FTS 索引可查詢後才標記 `done`，避免「上傳完成卻搜不到」的隱形 bug
* **處理順序**：單一 worker 依序處理（< 10,000 chunks 規模無需並發）
* **failed 文件**：僅能手動重新上傳（`recoverOnBoot` / `reembedAll` 不再排入 failed）；`reembedAll` = 所有 done 文件（手動「Re-embed all」按鈕），`reembedStale` = 僅 stale 的 done 文件（boot 自癒）；re-embed 跳過已有 keywords/summary 的文件的 LLM tagging
* **重傳失敗**：保留前一版本的 chunks 可搜（舊內容 + 舊 tags，，內部一致）；文件顯示 `failed`，，重傳修復

---

## 8. Web UI（極簡管理頁）

* **技術**：單頁 HTML + vanilla JS，由 Bun 直接 serve，**零 build step**
* **功能**：文件列表（含 status / tags / keywords）、上傳、刪除、acl_tags 編輯、任務狀態檢視
* **認證**：同一組靜態 API key（localStorage 記住）

---

## 9. 部署 (Deployment)

* **目標環境**：客戶內網 Linux + Docker Compose
* **組成**：
  * `app`：ContextVault server（Bun），內含 embedding、reranker、metadata tagging 全部 in-process
  * 模型於首次啟動時下載至 HF cache volume（e5-small、、Qwen2.5-0.5B-Instruct（local 模式）、、bge-reranker-base）；api tagging 模式不需下載 Qwen
* **單一指令部署**：`docker compose up -d`
* **MCP multi-session**：每 session 獨立 Server+Transport 實例，，以 `mcp-session-id` header 路由，，未知 sid → 404

---

## 10. 非功能性需求 (Non-Functional Requirements)

* **冷啟動**：< 200ms（不含模型載入；**所有模型 lazy-load**——首次使用才載入，，ingest 時載入 tagging LLM）
* **記憶體**：
  * 穩態（搜尋為主，embedding + reranker）：~1.1GB
  * ingest 尖峰（三模型同時在記憶體）：≤ 1.5GB（tagging LLM 閒置後 dispose）
  * 無 reranker 模式：~500MB
* **搜尋延遲**：CPU only 環境單次搜尋 0.6-1.7s（見 §4 延遲預算）
* **擴充性**：資料量過大時，LanceDB 可無縫切換儲存路徑至 S3/R2

---

## 11. Spike 清單（開工前驗證）

> 狀態：已於 2026-09 全數執行完畢並通過（11 個 spike：FTS tokenizer、、Docker binding、、onnxruntime-node、、transformers.js、、hybrid+where panic 等），結果記錄於 PLAN.md Phase 0；驗證腳本已移除，，重驗需求由 Phase 7 regression tests 承接。

---

## 12. 風險與注意事項

* **隱私紅線**：Embedding / LLM 的輸入即為原始私有文本。所有模型皆為 in-process ONNX Runtime 推論，**原始文本完全不出進程**，無外洩風險
* **向量空間一致性**：不同 provider / model 的向量空間互不相容，切換即全庫重嵌入（見 §5.3）
* **Windows 環境**：客戶若為 Windows 環境，Bun 與 LanceDB native binding 相容性需另行驗證（目前假設 Linux）
* **LanceDB hybrid+where panic**：0.23 版 hybrid（vector+FTS）+ `where()` 會觸發 core panic（arrow cast.rs:758）；現以 JS 端 ACL 過濾繞過（見 §4）。升級 `@lancedb/lancedb` 後需先過 Phase 7 回歸測試再恢復 SQL `where`。
