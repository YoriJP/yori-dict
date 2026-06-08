import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { parseApiLang } from "../src/lang";
import type { ApiLang } from "../src/types";
import {
  prepareBlockedSenseTable,
  readBlockedSenseIds,
  readMissingSeedRows
} from "./ai-seed-selection";

type Args = {
  dbPath: string;
  targetLang: ApiLang;
  sourcePath: string | null;
  sampleLimit: number;
  skipKatakana: boolean;
  includeRejected: boolean;
  rejectedDir: string;
  workDir: string;
};

type CountRow = {
  count: number;
};

type LangRow = {
  lang: string;
  senses: number;
  glosses: number;
};

type SourceRow = {
  source: string;
  review_status: string;
  senses: number;
  glosses: number;
};

const args = parseArgs(Bun.argv.slice(2));
const blockedSenseIds = readBlockedSenseIds(args);
const db = new Database(args.dbPath);
prepareBlockedSenseTable(db, blockedSenseIds);

const totalSenses = count(db, "select count(*) as count from senses");
const commonSenses = count(
  db,
  `select count(*) as count
   from senses s
   where exists (
     select 1
     from forms f
     where f.entry_id = s.entry_id and f.common = 1
   )`
);
const coveredSenses = count(
  db,
  "select count(distinct sense_id) as count from glosses where lang = ?",
  args.targetLang
);
const coveredCommonSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses g on g.sense_id = s.id and g.lang = ?
   where exists (
     select 1
     from forms f
     where f.entry_id = s.entry_id and f.common = 1
   )`,
  args.targetLang
);
const exportableMissingSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses en on en.sense_id = s.id and en.lang = 'en'
   where not exists (
     select 1
     from glosses target
     where target.sense_id = s.id and target.lang = ?
   )`,
  args.targetLang
);
const exportableCommonMissingSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses en on en.sense_id = s.id and en.lang = 'en'
   where not exists (
     select 1
     from glosses target
     where target.sense_id = s.id and target.lang = ?
   )
   and exists (
     select 1
     from forms f
     where f.entry_id = s.entry_id and f.common = 1
   )`,
  args.targetLang
);
const exportableUnblockedMissingSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses en on en.sense_id = s.id and en.lang = 'en'
   where not exists (
     select 1
     from glosses target
     where target.sense_id = s.id and target.lang = ?
   )
   and not exists (
     select 1
     from blocked_senses blocked
     where blocked.id = s.id
   )`,
  args.targetLang
);
const exportableUnblockedCommonMissingSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses en on en.sense_id = s.id and en.lang = 'en'
   where not exists (
     select 1
     from glosses target
     where target.sense_id = s.id and target.lang = ?
   )
   and not exists (
     select 1
     from blocked_senses blocked
     where blocked.id = s.id
   )
   and exists (
     select 1
     from forms f
     where f.entry_id = s.entry_id and f.common = 1
   )`,
  args.targetLang
);
const seedableMissingSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses en on en.sense_id = s.id and en.lang = 'en'
   where not exists (
     select 1
     from glosses target
     where target.sense_id = s.id and target.lang = ?
   )
   and not exists (
     select 1
     from blocked_senses blocked
     where blocked.id = s.id
   )
   and (
     ? = 0
     or not exists (
       select 1
       from forms only_forms
       where only_forms.entry_id = s.entry_id
         and only_forms.kind = 'kana'
         and only_forms.text glob '[ァ-ヴー・]*'
     )
   )`,
  args.targetLang,
  args.skipKatakana ? 1 : 0
);
const seedableCommonMissingSenses = count(
  db,
  `select count(distinct s.id) as count
   from senses s
   join glosses en on en.sense_id = s.id and en.lang = 'en'
   where not exists (
     select 1
     from glosses target
     where target.sense_id = s.id and target.lang = ?
   )
   and not exists (
     select 1
     from blocked_senses blocked
     where blocked.id = s.id
   )
   and exists (
     select 1
     from forms f
     where f.entry_id = s.entry_id and f.common = 1
   )
   and (
     ? = 0
     or not exists (
       select 1
       from forms only_forms
       where only_forms.entry_id = s.entry_id
         and only_forms.kind = 'kana'
         and only_forms.text glob '[ァ-ヴー・]*'
     )
   )`,
  args.targetLang,
  args.skipKatakana ? 1 : 0
);
const langRows = db
  .query<LangRow, []>(
    `select lang, count(distinct sense_id) as senses, count(*) as glosses
     from glosses
     group by lang
     order by lang`
  )
  .all();
const sourceRows = db
  .query<SourceRow, [ApiLang]>(
    `select source, review_status, count(distinct sense_id) as senses, count(*) as glosses
     from glosses
     where lang = ?
     group by source, review_status
     order by source, review_status`
  )
  .all(args.targetLang);
const samples = readMissingSeedRows(db, {
  targetLang: args.targetLang,
  limit: args.sampleLimit,
  skipKatakana: args.skipKatakana
});

db.close();

console.log(`lang: ${args.targetLang}`);
console.log(`totalSenses: ${totalSenses}`);
console.log(`coveredSenses: ${coveredSenses} (${percent(coveredSenses, totalSenses)})`);
console.log(`missingSenses: ${totalSenses - coveredSenses}`);
console.log(`commonSenses: ${commonSenses}`);
console.log(
  `coveredCommonSenses: ${coveredCommonSenses} (${percent(coveredCommonSenses, commonSenses)})`
);
console.log(`missingCommonSenses: ${commonSenses - coveredCommonSenses}`);
console.log(`exportableMissingSenses: ${exportableMissingSenses}`);
console.log(`exportableCommonMissingSenses: ${exportableCommonMissingSenses}`);
console.log(`exportableUnblockedMissingSenses: ${exportableUnblockedMissingSenses}`);
console.log(`exportableUnblockedCommonMissingSenses: ${exportableUnblockedCommonMissingSenses}`);
console.log(`seedableMissingSenses: ${seedableMissingSenses}`);
console.log(`seedableCommonMissingSenses: ${seedableCommonMissingSenses}`);

if (args.sourcePath && existsSync(args.sourcePath)) {
  const sourceRowsCount = await countJsonlRows(args.sourcePath);
  console.log(`sourceRows: ${sourceRowsCount} (${args.sourcePath})`);
}
if (!args.includeRejected) {
  console.log(`skippedRejectedOrFailedSenses: ${blockedSenseIds.size}`);
}

console.log("");
console.log("languages:");
for (const row of langRows) {
  console.log(`  ${row.lang}: senses=${row.senses} glosses=${row.glosses}`);
}

console.log("");
console.log(`${args.targetLang} sources:`);
for (const row of sourceRows) {
  console.log(
    `  ${row.source}/${row.review_status}: senses=${row.senses} glosses=${row.glosses}`
  );
}

console.log("");
console.log(`nextMissingSamples: ${samples.length}`);
for (const [index, row] of samples.entries()) {
  const pos = JSON.parse(row.part_of_speech) as string[];
  const glosses = JSON.parse(row.glosses_json) as string[];
  const reading = row.reading ? ` [${row.reading}]` : "";
  console.log(
    `${index + 1}. ${row.word}${reading} ${row.sense_id} common=${row.common === 1} pos=${pos.join(",")} :: ${glosses.join("; ")}`
  );
}

function parseArgs(argv: string[]): Args {
  const targetLang = parseApiLang(readFlag(argv, "--lang") ?? "zh-tw");
  if (!targetLang) {
    throw new Error("Unsupported --lang. Expected one of: en, de, zh-tw, zh-cn, ko");
  }

  const explicitSource = readFlag(argv, "--source");
  const defaultSource = `sources/ai-glosses/${targetLang}.jsonl`;

  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    targetLang,
    sourcePath: explicitSource ?? (existsSync(defaultSource) ? defaultSource : null),
    sampleLimit: parseNonNegativeInt(readFlag(argv, "--samples") ?? "20"),
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

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--samples must be a non-negative integer");
  }
  return parsed;
}

function count(db: Database, sql: string, ...values: Array<string | number>): number {
  const row = db.query<CountRow, Array<string | number>>(sql).get(...values);
  return row?.count ?? 0;
}

function percent(value: number, total: number): string {
  if (total === 0) return "0.00%";
  return `${((value / total) * 100).toFixed(2)}%`;
}

async function countJsonlRows(path: string): Promise<number> {
  const text = await Bun.file(path).text();
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}
