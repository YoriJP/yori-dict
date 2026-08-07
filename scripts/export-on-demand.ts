import { resolve } from "node:path";
import { openLookupDb } from "../src/db";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { exportOnDemandArtifacts } from "../src/on-demand-export";

const argv = Bun.argv.slice(2);
const dbPath = readFlag(argv, "--db") ?? process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const outputDirectory = readFlag(argv, "--out") ?? "releases/on-demand-ja";

const db = openLookupDb(resolve(dbPath));
const repository = openEnrichmentRepository(resolve(dbPath), db);
try {
  const entries = repository.acceptedEntries();
  const attempts = repository.attemptRecords();
  const artifacts = await exportOnDemandArtifacts(entries, attempts, resolve(outputDirectory));
  console.log(`Exported ${entries.length} accepted Japanese entr${entries.length === 1 ? "y" : "ies"}.`);
  console.log(artifacts.jsonl);
  console.log(artifacts.sqlite);
  console.log(artifacts.yomitan);
} finally {
  repository.close();
  db.close();
}

function readFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}
