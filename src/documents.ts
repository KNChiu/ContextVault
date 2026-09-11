import type { Connection } from "@lancedb/lancedb";
import type { Config } from "./config";

export interface DocumentResult {
  source: string;
  content: string;
  section: string | null;
  truncated: boolean;
  sections: string[];
  status: string;
}

function escapeSql(val: string): string {
  return val.replace(/'/g, "''");
}

export async function getDocument(
  db: Connection,
  cfg: Config,
  opts: { source: string; section?: string; allowedTags: string[] },
): Promise<DocumentResult> {
  const docs = await db.openTable("documents");
  const chunks = await db.openTable("chunks");

  const rows = await docs
    .query()
    .where(`source = '${escapeSql(opts.source)}'`)
    .limit(1)
    .toArray();
  if (rows.length === 0) {
    throw new Error(`Document not found: ${opts.source}`);
  }

  const doc = rows[0];
  const docTags = [...(doc.acl_tags as any)] as string[];
  const hasAccess = docTags.some((t) => opts.allowedTags.includes(t));
  if (!hasAccess) {
    throw new Error("Access denied: no matching ACL tags");
  }

  const status = doc.status as string;

  if (!opts.section) {
    let content = doc.content as string;
    const truncated = content.length > cfg.limits.getDocumentMax;
    if (truncated) {
content = content.slice(0, cfg.limits.getDocumentMax) + `\n\n[Content truncated at ${cfg.limits.getDocumentMax} bytes]`;
    }

    const chunkRows = await chunks
      .query()
      .where(`source = '${escapeSql(opts.source)}'`)
      .select(["section"])
      .toArray();
    const sections = [
      ...new Set(chunkRows.map((r) => r.section as string).filter(Boolean)),
    ].sort();

    return { source: opts.source, content, section: null, truncated, sections, status };
  }

  const chunkRows = await chunks
    .query()
    .where(`source = '${escapeSql(opts.source)}'`)
    .toArray();

  const filtered = chunkRows.filter((r) => {
    const s = r.section as string;
    return s === opts.section || s.startsWith(opts.section + " > ");
  });
  filtered.sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));

  let content = filtered.map((r) => r.text as string).join("\n\n");
  const truncated = content.length > cfg.limits.getDocumentMax;
  if (truncated) {
    content = content.slice(0, cfg.limits.getDocumentMax) + `\n\n[Content truncated at ${cfg.limits.getDocumentMax} bytes]`;
  }

  const sections = [
    ...new Set(chunkRows.map((r) => r.section as string).filter(Boolean)),
  ].sort();

  return { source: opts.source, content, section: opts.section, truncated, sections, status };
}