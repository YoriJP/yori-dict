import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openExampleOverlay, type EnrichmentAttempt } from "../src/example-overlay";
import type { PublicExample } from "../src/types";

type SourceRow = {
  senseId: string;
  example: PublicExample;
  attempts: EnrichmentAttempt[];
};

const overlayPath = readFlag(Bun.argv.slice(2), "--overlay") ?? "data/example-overlay.sqlite";
const outputPath = readFlag(Bun.argv.slice(2), "--out") ?? "sources/ai-examples/generated.jsonl";
const overlay = openExampleOverlay(overlayPath);

try {
  const rowsBySense = new Map((await readExisting(outputPath)).map((row) => [row.senseId, row]));
  for (const record of overlay.accepted()) {
    if (!record.example) throw new Error(`Accepted overlay row has no example: ${record.senseId}`);
    rowsBySense.set(record.senseId, {
      senseId: record.senseId,
      example: record.example,
      attempts: record.attempts
    });
  }
  const rows = Array.from(rowsBySense.values()).sort((left, right) =>
    left.senseId < right.senseId ? -1 : left.senseId > right.senseId ? 1 : 0
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, rows.length > 0 ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : "");
  console.log(`Exported ${rows.length} accepted example(s) to ${outputPath}`);
} finally {
  overlay.close();
}

async function readExisting(path: string): Promise<SourceRow[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const rows = text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as SourceRow);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.senseId || !row.example || !Array.isArray(row.attempts)) throw new Error(`Invalid existing example source row`);
    if (seen.has(row.senseId)) throw new Error(`Duplicate existing example source row: ${row.senseId}`);
    seen.add(row.senseId);
  }
  return rows;
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}
