import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { parseApiLang } from "../src/lang";
import type { ApiLang } from "../src/types";
import {
  prepareBlockedSenseTable,
  readBlockedSenseIds,
  readMissingSeedRows,
  toSeed
} from "./ai-seed-selection";

type Args = {
  dbPath: string;
  outPath: string;
  targetLang: ApiLang;
  limit: number;
  skipKatakana: boolean;
  includeRejected: boolean;
  rejectedDir: string;
  workDir: string;
};

const args = parseArgs(Bun.argv.slice(2));
await Bun.$`mkdir -p ${dirname(args.outPath)}`;

const blockedSenseIds = readBlockedSenseIds(args);
const db = new Database(args.dbPath);
prepareBlockedSenseTable(db, blockedSenseIds);
const rows = readMissingSeedRows(db, args);
db.close();

const lines = rows.map((row) => JSON.stringify(toSeed(row, args.targetLang))).join("\n");
await Bun.write(args.outPath, lines.length > 0 ? `${lines}\n` : "");

console.log(`Exported ${rows.length} ${args.targetLang} AI seed(s) to ${args.outPath}`);
if (!args.includeRejected) {
  console.log(`Skipped ${blockedSenseIds.size} previously rejected or failed sense(s)`);
}

function parseArgs(argv: string[]): Args {
  const targetLang = parseApiLang(readFlag(argv, "--lang") ?? "zh-tw");
  if (!targetLang) {
    throw new Error("Unsupported --lang. Expected one of: en, de, zh-tw, zh-cn, ko");
  }

  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    outPath: readFlag(argv, "--out") ?? `data/ai-seeds/${targetLang}-seeds.jsonl`,
    targetLang,
    limit: parsePositiveInt(readFlag(argv, "--limit") ?? "20"),
    skipKatakana: !argv.includes("--include-katakana"),
    includeRejected: argv.includes("--include-rejected"),
    rejectedDir: readFlag(argv, "--rejected-dir") ?? "data/ai-candidates",
    workDir: readFlag(argv, "--work-dir") ?? "data/ai-batches"
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}
