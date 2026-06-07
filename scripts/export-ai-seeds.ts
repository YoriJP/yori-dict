import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { parseApiLang } from "../src/lang";
import type { ApiLang } from "../src/types";

type Args = {
  dbPath: string;
  outPath: string;
  targetLang: ApiLang;
  limit: number;
  skipKatakana: boolean;
};

type SeedRow = {
  entry_id: string;
  sense_id: string;
  word: string;
  reading: string | null;
  common: 0 | 1;
  position: number;
  part_of_speech: string;
  glosses_json: string;
};

type AiSeed = {
  entryId: string;
  senseId: string;
  word: string;
  reading: string | null;
  common: boolean;
  position: number;
  targetLang: ApiLang;
  pos: string[];
  glosses: string[];
};

const args = parseArgs(Bun.argv.slice(2));
await Bun.$`mkdir -p ${dirname(args.outPath)}`;

const db = new Database(args.dbPath, { readonly: true });
const rows = db
  .query<SeedRow, [ApiLang, number, number]>(
    `select
       e.id as entry_id,
       s.id as sense_id,
       (
         select f.text
         from forms f
         where f.entry_id = e.id
         order by f.common desc, case f.kind when 'kanji' then 0 else 1 end, f.text
         limit 1
       ) as word,
       (
         select f.reading
         from forms f
         where f.entry_id = e.id and f.reading is not null
         order by f.common desc, f.text
         limit 1
       ) as reading,
       (
         select max(f.common)
         from forms f
         where f.entry_id = e.id
       ) as common,
       s.position,
       s.part_of_speech,
       json_group_array(g.text) as glosses_json
     from entries e
     join senses s on s.entry_id = e.id
     join glosses g on g.sense_id = s.id and g.lang = 'en'
     where not exists (
       select 1
       from glosses target
       where target.sense_id = s.id and target.lang = ?
     )
     and (
       ? = 0
       or not exists (
         select 1
         from forms only_forms
         where only_forms.entry_id = e.id
           and only_forms.kind = 'kana'
           and only_forms.text glob '[ァ-ヴー・]*'
       )
     )
     group by e.id, s.id
     order by common desc, e.source_id, s.position
     limit ?`
  )
  .all(args.targetLang, args.skipKatakana ? 1 : 0, args.limit);
db.close();

const lines = rows.map((row) => JSON.stringify(toSeed(row, args.targetLang))).join("\n");
await Bun.write(args.outPath, lines.length > 0 ? `${lines}\n` : "");

console.log(`Exported ${rows.length} ${args.targetLang} AI seed(s) to ${args.outPath}`);

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
    skipKatakana: !argv.includes("--include-katakana")
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

function toSeed(row: SeedRow, targetLang: ApiLang): AiSeed {
  return {
    entryId: row.entry_id,
    senseId: row.sense_id,
    word: row.word,
    reading: row.reading,
    common: row.common === 1,
    position: row.position,
    targetLang,
    pos: JSON.parse(row.part_of_speech) as string[],
    glosses: JSON.parse(row.glosses_json) as string[]
  };
}
