import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";

export class ConversionError extends Error {}

export async function convertToMarkdown(
  buf: Uint8Array,
  ext: string,
  cfg: Config,
): Promise<string> {
  if (!cfg.convert.enabled) {
    throw new ConversionError("Binary conversion is disabled in config");
  }

  const tmpDir = join(tmpdir(), "cv-convert");
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${crypto.randomUUID()}.${ext}`);
  const outFile = `${tmpFile}.md`;

  try {
    await Bun.write(tmpFile, buf);

    const proc = Bun.spawn([cfg.convert.bin, tmpFile, "-o", outFile], {
      stdout: "ignore",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, cfg.convert.timeoutSec * 1000);

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeout);

    if (exitCode !== 0) {
      throw new ConversionError(`markitdown failed (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`);
    }

    const out = Bun.file(outFile);
    if (!(await out.exists())) {
      throw new ConversionError("markitdown produced no output file");
    }
    return await out.text();
  } finally {
    rmSync(tmpFile, { force: true });
    rmSync(outFile, { force: true });
  }
}