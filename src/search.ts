import type { Connection } from "@lancedb/lancedb";
import * as lancedb from "@lancedb/lancedb";
const { RRFReranker } = lancedb.rerankers;
import type { Config } from "./config";
import { embedQuery } from "./embed";
import { rerank } from "./rerank";

export interface SearchResult {
  text: string;
  source: string;
  section: string;
  chunk_id: string;
  score: number;
  rerank_score: number | null;
  reranked: boolean;
}

export interface SearchOptions {
  query: string;
  topK: number;
  tags?: string[];
  allowedTags: string[];
}
function escapeSql(val: string): string {
  return val.replace(/'/g, "''");
}

function overlapDedup(left: string, right: string): string {
  for (let len = Math.min(left.length, right.length); len > 20; len--) {
    if (left.endsWith(right.slice(0, len))) {
      return left + right.slice(len);
    }
  }
  return left + "\n\n" + right;
}

export async function search(
  db: Connection,
  cfg: Config,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const { query, topK, tags, allowedTags } = opts;

  if (!query.trim()) return [];

  const docs = await db.openTable("documents");
  const chunks = await db.openTable("chunks");

  const mismatch = await docs
    .query()
    .where(
      `status = 'done' AND embedding_model != '${escapeSql(cfg.embedding.model)}'`,
    )
    .limit(1)
    .toArray();
  if (mismatch.length > 0) {
    throw new Error(
      `Embedding model mismatch: some documents use a different model. Run re-embed to fix.`,
    );
  }

  const effective = tags
    ? allowedTags.filter((t) => tags.includes(t))
    : allowedTags;
  const aclWhere = effective.length === 0
    ? null
    : `array_has_any(acl_tags, Array[${effective.map((t) => `'${escapeSql(t)}'`).join(", ")}])`;
  if (!aclWhere) return [];

  const vec = await embedQuery(query);

  const indices = await chunks.listIndices();
  const hasFts = indices.some(
    (i) => i.columns.includes("text") && i.indexType === "FTS",
  );

  let candidates: any[];
  if (hasFts) {
    // ponytail: LanceDB 0.23 core panics ("primitive array") on hybrid (vector+FTS) + any where() clause (spike s9-lance-hybrid-where). Fetch without where, ACL-filter in JS. Upgrade @lancedb/lancedb when a fixed version lands.

    const rrf = await RRFReranker.create();
    const fetched = await chunks
      .query()
      .nearestTo(vec)
      .fullTextSearch(query)
      .rerank(rrf)
      .limit(Math.max(cfg.reranker.candidates * 3,  100))
      .toArray();
    candidates = fetched
      .filter((r) => (r.acl_tags ? [...(r.acl_tags as any)] as string[] : []).some((t) => effective.includes(t)))
      .slice(0, cfg.reranker.candidates);
  } else {
    candidates = await chunks
      .query()
      .nearestTo(vec)
      .where(aclWhere)
      .limit(cfg.reranker.candidates)
      .toArray();
  }

  if (candidates.length === 0) return [];

  const candidateTexts = candidates.map((c) => c.text as string);
  const rerankScores = await rerank(query, candidateTexts);

  let ranked: { row: any; rerankScore: number | null }[];
  if (rerankScores) {
    ranked = candidates.map((row, i) => ({
      row,
      rerankScore: rerankScores[i],
    }));
    ranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  } else {
    ranked = candidates.map((row) => ({ row, rerankScore: null }));
  }

  const top = ranked.slice(0, topK);

  const results: SearchResult[] = [];
  for (const { row, rerankScore } of top) {
    const docId = row.doc_id as string;
    const section = row.section as string;
    const chunkIndex = row.chunk_index as number;

    const neighborRows = await chunks
      .query()
      .where(
        `doc_id = '${escapeSql(docId)}' AND section = '${escapeSql(section)}' AND chunk_index IN (${chunkIndex - 1}, ${chunkIndex}, ${chunkIndex + 1})`,
      )
      .limit(3)
      .toArray();
    neighborRows.sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));

    let merged = "";
    for (const nr of neighborRows) {
      const t = nr.text as string;
      if (!merged) {
        merged = t;
      } else {
        merged = overlapDedup(merged, t);
      }
    }

    if (merged.length > cfg.limits.mergedTextMax * 4) {
      merged = merged.slice(0, cfg.limits.mergedTextMax * 4) + "...";
    }

    results.push({
      text: merged,
      source: row.source as string,
      section,
      chunk_id: row.chunk_id as string,
      score: (row._score ?? row._distance ?? 0) as number,
      rerank_score: rerankScore,
      reranked: rerankScores !== null,
    });
  }

  return results;
}