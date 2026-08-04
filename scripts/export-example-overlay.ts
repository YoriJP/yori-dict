import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openExampleOverlay } from "../src/example-overlay";

const overlayPath = readFlag(Bun.argv.slice(2), "--overlay") ?? "data/example-overlay.sqlite";
const outputPath = readFlag(Bun.argv.slice(2), "--out") ?? "sources/ai-examples/generated.jsonl";
const overlay = openExampleOverlay(overlayPath);

try {
  const rows = overlay.accepted().map((record) => ({
    senseId: record.senseId,
    example: record.example,
    attempts: record.attempts
  }));
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, rows.length > 0 ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : "");
  console.log(`Exported ${rows.length} accepted example(s) to ${outputPath}`);
} finally {
  overlay.close();
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}
