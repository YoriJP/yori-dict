import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { parseApiLang } from "../src/lang";
import type { ApiLang } from "../src/types";
import { readJsonl, type Candidate } from "./ai-common";
import {
  formatJsonl,
  normalizeGlosses,
  sourceKey,
  validateGlosses,
  type AiGlossSource
} from "./ai-gloss-validation";

type Args = {
  dbPath: string;
  inputPath: string;
  outPath: string;
  rejectedPath: string;
  lang: ApiLang;
  maxGlosses: number;
  maxGlossLength: number;
  append: boolean;
};

type RejectedCandidate = {
  senseId: string | null;
  reasons: string[];
  candidate: Candidate;
};

const args = parseArgs(Bun.argv.slice(2));
const candidates = await readJsonl<Candidate>(args.inputPath);
const existingRows = args.append && (await Bun.file(args.outPath).exists()) ? await readJsonl<AiGlossSource>(args.outPath) : [];
const db = new Database(args.dbPath, { readonly: true });
const seen = new Set(existingRows.map((row) => sourceKey(row)));
const filtered: AiGlossSource[] = [];
const rejected: RejectedCandidate[] = [];

for (const candidate of candidates) {
  const reasons = rejectionReasons(candidate, args, db, seen);

  if (reasons.length > 0) {
    rejected.push({
      senseId: typeof candidate.senseId === "string" ? candidate.senseId : null,
      reasons,
      candidate
    });
    continue;
  }

  const key = candidateKey(candidate);
  seen.add(key);
  filtered.push({
    senseId: candidate.senseId,
    lang: args.lang,
    glosses: normalizeGlosses(candidate.candidateGlosses),
    source: "ai-assisted",
    model: candidate.model
  });
}

db.close();

await Bun.$`mkdir -p ${dirname(args.outPath)}`;
await Bun.$`mkdir -p ${dirname(args.rejectedPath)}`;
await Bun.write(
  args.outPath,
  formatJsonl([...existingRows, ...filtered])
);
await Bun.write(
  args.rejectedPath,
  formatJsonl(rejected)
);

console.log(`${args.append ? "Appended" : "Filtered"} ${filtered.length} candidate(s) to ${args.outPath}`);
console.log(`Rejected ${rejected.length} candidate(s) to ${args.rejectedPath}`);

function parseArgs(argv: string[]): Args {
  const lang = parseApiLang(readFlag(argv, "--lang") ?? "zh-tw");
  if (!lang) {
    throw new Error("Unsupported --lang. Expected one of: en, de, zh-tw, zh-cn, ko");
  }

  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    inputPath: readFlag(argv, "--input") ?? `data/ai-candidates/${lang}-candidates.jsonl`,
    outPath: readFlag(argv, "--out") ?? `sources/ai-glosses/${lang}.jsonl`,
    rejectedPath: readFlag(argv, "--rejected") ?? `data/ai-candidates/${lang}-rejected.jsonl`,
    lang,
    maxGlosses: parsePositiveInt(readFlag(argv, "--max-glosses") ?? "8", "--max-glosses"),
    maxGlossLength: parsePositiveInt(readFlag(argv, "--max-gloss-length") ?? "24", "--max-gloss-length"),
    append: argv.includes("--append")
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

function rejectionReasons(candidate: Candidate, args: Args, db: Database, seen: Set<string>): string[] {
  const reasons: string[] = [];

  if (candidate.targetLang !== args.lang) {
    reasons.push(`targetLang is ${candidate.targetLang}, expected ${args.lang}`);
  }
  if (!senseExists(db, candidate.senseId)) {
    reasons.push(`unknown senseId: ${candidate.senseId}`);
  }
  if (hasExistingGlosses(db, candidate.senseId, args.lang)) {
    reasons.push(`sense already has ${args.lang} glosses`);
  }
  if (seen.has(candidateKey(candidate))) {
    reasons.push(`duplicate candidate or existing source row for ${candidate.senseId}:${args.lang}`);
  }

  reasons.push(
    ...validateGlosses({
      glosses: candidate.candidateGlosses,
      lang: args.lang,
      sourceGlosses: candidate.sourceGlosses,
      maxGlosses: args.maxGlosses,
      maxGlossLength: args.maxGlossLength
    }).map((reason) => (reason === "no glosses" ? "no candidate glosses" : reason))
  );

  return Array.from(new Set(reasons));
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.senseId}:${candidate.targetLang}`;
}

function senseExists(db: Database, senseId: string): boolean {
  return db.query("select 1 from senses where id = ? limit 1").get(senseId) !== null;
}

function hasExistingGlosses(db: Database, senseId: string, lang: ApiLang): boolean {
  const row = db
    .query<{ count: number }, [string, ApiLang]>("select count(*) as count from glosses where sense_id = ? and lang = ?")
    .get(senseId, lang);
  return (row?.count ?? 0) > 0;
}
