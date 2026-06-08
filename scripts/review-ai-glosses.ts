import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { parseApiLang } from "../src/lang";
import type { ApiLang } from "../src/types";
import { readJsonl } from "./ai-common";
import { formatJsonl, type AiGlossSource } from "./ai-gloss-validation";

type Args = {
  dbPath: string;
  sourcePath: string;
  outPath: string;
  lang: ApiLang;
  limit: number;
  offset: number;
  commonOnly: boolean;
  nonCommonOnly: boolean;
};

type ContextRow = {
  entry_id: string;
  word: string;
  reading: string | null;
  common: 0 | 1;
  position: number;
  part_of_speech: string;
  english_glosses_json: string;
};

type ReviewRow = {
  senseId: string;
  entryId: string;
  word: string;
  reading: string | null;
  common: boolean;
  position: number;
  pos: string[];
  englishGlosses: string[];
  aiGlosses: string[];
  ai: {
    lang: ApiLang;
    model: string;
  };
};

const args = parseArgs(Bun.argv.slice(2));
const sourceRows = await readJsonl<AiGlossSource>(args.sourcePath);
const db = new Database(args.dbPath, { readonly: true });
const reviewRows: ReviewRow[] = [];
let skippedMissingContext = 0;
let skippedLang = 0;
let skippedCommon = 0;
let skippedNonCommon = 0;
let skippedOffset = 0;

for (const row of sourceRows) {
  if (row.lang !== args.lang) {
    skippedLang += 1;
    continue;
  }

  const context = readContext(db, row.senseId);
  if (!context) {
    skippedMissingContext += 1;
    continue;
  }
  if (args.commonOnly && context.common !== 1) {
    skippedNonCommon += 1;
    continue;
  }
  if (args.nonCommonOnly && context.common === 1) {
    skippedCommon += 1;
    continue;
  }
  if (skippedOffset < args.offset) {
    skippedOffset += 1;
    continue;
  }

  reviewRows.push(toReviewRow(row, context));
  if (reviewRows.length >= args.limit) break;
}

db.close();

await Bun.$`mkdir -p ${dirname(args.outPath)}`;
await Bun.write(args.outPath, formatJsonl(reviewRows));

console.log(`Wrote ${reviewRows.length} ${args.lang} review row(s) to ${args.outPath}`);
if (args.commonOnly) console.log(`Skipped ${skippedNonCommon} non-common AI row(s)`);
if (args.nonCommonOnly) console.log(`Skipped ${skippedCommon} common AI row(s)`);
if (skippedOffset > 0) console.log(`Skipped ${skippedOffset} eligible AI row(s) by offset`);
if (skippedLang > 0) console.log(`Skipped ${skippedLang} row(s) for another language`);
if (skippedMissingContext > 0) console.log(`Skipped ${skippedMissingContext} row(s) missing DB context`);
console.log("");
console.log("Claude review prompt:");
console.log(
  [
    `Review ${args.outPath}.`,
    "Only flag suspicious AI-generated dictionary gloss rows.",
    "Compare aiGlosses against word, reading, pos, and englishGlosses.",
    "Output JSONL only. One line per issue.",
    "Shape: {\"senseId\":\"...\",\"severity\":\"low|medium|high\",\"reason\":\"...\",\"suggestedGlosses\":[\"...\"]}",
    "If a row looks fine, output nothing for that row.",
    "Do not edit source files."
  ].join("\n")
);

function parseArgs(argv: string[]): Args {
  const lang = parseApiLang(readFlag(argv, "--lang") ?? "zh-tw");
  if (!lang) {
    throw new Error("Unsupported --lang. Expected one of: en, de, zh-tw, zh-cn, ko");
  }
  const commonOnly = argv.includes("--common-only");
  const nonCommonOnly = argv.includes("--non-common-only");
  if (commonOnly && nonCommonOnly) {
    throw new Error("Use either --common-only or --non-common-only, not both");
  }

  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    sourcePath: readFlag(argv, "--source") ?? `sources/ai-glosses/${lang}.jsonl`,
    outPath: readFlag(argv, "--out") ?? `data/ai-review/${lang}/review-bundle.jsonl`,
    lang,
    limit: parsePositiveInt(readFlag(argv, "--limit") ?? "200", "--limit"),
    offset: parseNonNegativeInt(readFlag(argv, "--offset") ?? "0", "--offset"),
    commonOnly,
    nonCommonOnly
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

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function readContext(db: Database, senseId: string): ContextRow | null {
  return db
    .query<ContextRow, [string]>(
      `select
         s.entry_id,
         (
           select f.text
           from forms f
           where f.entry_id = s.entry_id
           order by f.common desc, case f.kind when 'kanji' then 0 else 1 end, f.text
           limit 1
         ) as word,
         (
           select f.reading
           from forms f
           where f.entry_id = s.entry_id and f.reading is not null
           order by f.common desc, f.text
           limit 1
         ) as reading,
         (
           select max(f.common)
           from forms f
           where f.entry_id = s.entry_id
         ) as common,
         s.position,
         s.part_of_speech,
         json_group_array(g.text) as english_glosses_json
       from senses s
       join glosses g on g.sense_id = s.id and g.lang = 'en'
       where s.id = ?
       group by s.id`
    )
    .get(senseId);
}

function toReviewRow(row: AiGlossSource, context: ContextRow): ReviewRow {
  return {
    senseId: row.senseId,
    entryId: context.entry_id,
    word: context.word,
    reading: context.reading,
    common: context.common === 1,
    position: context.position,
    pos: JSON.parse(context.part_of_speech) as string[],
    englishGlosses: JSON.parse(context.english_glosses_json) as string[],
    aiGlosses: row.glosses,
    ai: {
      lang: row.lang,
      model: row.model
    }
  };
}
