import { Database } from "bun:sqlite";
import { parseApiLang } from "../src/lang";
import type { ApiLang } from "../src/types";
import { readJsonl } from "./ai-common";
import { sourceKey, validateGlosses, type AiGlossSource } from "./ai-gloss-validation";

type Args = {
  dbPath: string;
  inputPath: string;
  lang: ApiLang;
  maxGlosses: number;
  maxGlossLength: number;
};

type InvalidRow = {
  line: number;
  key: string | null;
  reasons: string[];
  row: unknown;
};

const args = parseArgs(Bun.argv.slice(2));
const rows = await readJsonl<AiGlossSource>(args.inputPath);
const db = new Database(args.dbPath, { readonly: true });
const seen = new Set<string>();
const invalid: InvalidRow[] = [];

rows.forEach((row, index) => {
  const reasons = rowReasons(row, args, db, seen);
  if (reasons.length > 0) {
    invalid.push({
      line: index + 1,
      key: isString(row.senseId) && isString(row.lang) ? `${row.senseId}:${row.lang}` : null,
      reasons,
      row
    });
    return;
  }

  seen.add(sourceKey(row));
});

db.close();

if (invalid.length > 0) {
  for (const item of invalid) {
    console.error(`${args.inputPath}:${item.line}: ${item.reasons.join("; ")}`);
  }
  throw new Error(`Found ${invalid.length} invalid AI gloss row(s)`);
}

console.log(`Validated ${rows.length} AI gloss row(s) in ${args.inputPath}`);

function parseArgs(argv: string[]): Args {
  const lang = parseApiLang(readFlag(argv, "--lang") ?? "zh-tw");
  if (!lang) {
    throw new Error("Unsupported --lang. Expected one of: en, de, zh-tw, zh-cn, ko");
  }

  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    inputPath: readFlag(argv, "--input") ?? `sources/ai-glosses/${lang}.jsonl`,
    lang,
    maxGlosses: parsePositiveInt(readFlag(argv, "--max-glosses") ?? "8", "--max-glosses"),
    maxGlossLength: parsePositiveInt(readFlag(argv, "--max-gloss-length") ?? "24", "--max-gloss-length")
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function rowReasons(row: AiGlossSource, args: Args, db: Database, seen: Set<string>): string[] {
  const reasons: string[] = [];

  if (!isString(row.senseId) || row.senseId.length === 0) {
    reasons.push("missing senseId");
  } else if (!senseExists(db, row.senseId)) {
    reasons.push(`unknown senseId: ${row.senseId}`);
  }

  if (row.lang !== args.lang) {
    reasons.push(`lang is ${String(row.lang)}, expected ${args.lang}`);
  }

  if (row.source !== "ai-assisted") {
    reasons.push(`source is ${String(row.source)}, expected ai-assisted`);
  }

  if (!isString(row.model) || row.model.length === 0) {
    reasons.push("missing model");
  }

  if (isString(row.senseId) && isString(row.lang)) {
    const key = sourceKey(row);
    if (seen.has(key)) {
      reasons.push(`duplicate source row for ${key}`);
    }
  }

  reasons.push(
    ...validateGlosses({
      glosses: Array.isArray(row.glosses) ? row.glosses : [],
      lang: args.lang,
      maxGlosses: args.maxGlosses,
      maxGlossLength: args.maxGlossLength
    })
  );

  return Array.from(new Set(reasons));
}

function senseExists(db: Database, senseId: string): boolean {
  return db.query("select 1 from senses where id = ? limit 1").get(senseId) !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
