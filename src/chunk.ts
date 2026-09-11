export interface Chunk {
  text: string;
  section: string;
  chunk_index: number;
}

export interface ChunkOptions {
  size: number;
  overlap: number;
}

export function countTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

export function chunkMarkdown(content: string, options: ChunkOptions): Chunk[] {
  if (!content.trim()) return [];

  const { size, overlap } = options;
  const lines = content.split("\n");

  const sections: { path: string; lines: string[] }[] = [];
  let inFence = false;
  let currentH1 = "";
  let currentH2 = "";
  let currentLines: string[] = [];

  function flushSection() {
    if (currentLines.length === 0) return;
    const path = currentH1 ? (currentH2 ? `${currentH1} > ${currentH2}` : currentH1) : "";
    sections.push({ path, lines: currentLines });
    currentLines = [];
  }

  for (const line of lines) {
    if (/^```/.test(line) || /^~~~/.test(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }

    if (!inFence) {
      const h1 = line.match(/^# (.+)/);
      const h2 = line.match(/^## (.+)/);
      if (h1) {
        flushSection();
        currentH1 = h1[1];
        currentH2 = "";
        currentLines.push(line);
        continue;
      }
      if (h2) {
        flushSection();
        currentH2 = h2[1];
        currentLines.push(line);
        continue;
      }
    }

    currentLines.push(line);
  }
  flushSection();

  const chunks: Chunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    const text = section.lines.join("\n");
    const totalTokens = countTokens(text);

    if (totalTokens <= size) {
      chunks.push({ text, section: section.path, chunk_index: globalIndex++ });
      continue;
    }

    const subChunks = chunkSection(text, section.path, size, overlap);
    for (const sc of subChunks) {
      chunks.push({ ...sc, chunk_index: globalIndex++ });
    }
  }

  return chunks;
}

function chunkSection(text: string, section: string, size: number, overlap: number): { text: string; section: string }[] {
  const paragraphs = text.split(/\n\n+/);
  const result: { text: string; section: string }[] = [];
  let start = 0;

  while (start < paragraphs.length) {
    let end = start;
    let tokens = 0;
    while (end < paragraphs.length) {
      const t = countTokens(paragraphs[end]);
      if (tokens + t > size) break;
      tokens += t;
      end++;
    }

    if (end === start) {
      const hard = hardSplit(paragraphs[start], size, overlap);
      for (const h of hard) result.push({ text: h, section });
      start++;
    } else {
      result.push({ text: paragraphs.slice(start, end).join("\n\n"), section });
      let overlapTokens = 0;
      let newStart = end;
      for (let i = end - 1; i >= start; i--) {
        const t = countTokens(paragraphs[i]);
        if (overlapTokens + t > overlap) break;
        overlapTokens += t;
        newStart = i;
      }
      start = newStart === start ? end : newStart;
    }
  }

  return result;
}

function hardSplit(text: string, size: number, overlap: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    let j = i;
    let tokens = 0;
    while (j < lines.length) {
      const t = countTokens(lines[j]);
      if (tokens + t > size) break;
      tokens += t;
      j++;
    }

    if (j === i) {
      const line = lines[i];
      const maxChars = size * 4;
      for (let k = 0; k < line.length; k += maxChars) {
        chunks.push(line.slice(k, k + maxChars));
      }
      i++;
    } else {
      chunks.push(lines.slice(i, j).join("\n"));
      let overlapTokens = 0;
      let newStart = j;
      for (let k = j - 1; k >= i; k--) {
        const t = countTokens(lines[k]);
        if (overlapTokens + t > overlap) break;
        overlapTokens += t;
        newStart = k;
      }
      i = newStart === i ? j : newStart;
    }
  }

  return chunks;
}