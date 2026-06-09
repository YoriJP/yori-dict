import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import type { JmdictFile, JmdictWord } from "../src/types";
import { parseApiLang, toApiLang } from "../src/lang";

type Args = {
  input: string;
  out: string;
  aiGlosses: string[];
};

type AiGlossSource = {
  senseId: string;
  lang: string;
  glosses: string[];
  source?: "ai-assisted";
  model?: string;
};

const args = parseArgs(Bun.argv.slice(2));
await Bun.$`mkdir -p ${dirname(args.out)}`;
await Bun.$`rm -f ${args.out}`;
await Bun.$`rm -f ${args.out}-shm`;
await Bun.$`rm -f ${args.out}-wal`;

const source = (await Bun.file(args.input).json()) as JmdictFile;
const aiGlosses = (await Promise.all(args.aiGlosses.map((path) => readJsonl<AiGlossSource>(path)))).flat();
const db = new Database(args.out);

createSchema(db);
insertMetadata(db, source);
insertWords(db, source.words);
insertAiGlosses(db, aiGlosses);
db.close();

console.log(`Imported ${source.words.length} JMdict entries into ${args.out}`);
if (aiGlosses.length > 0) {
  console.log(`Imported ${aiGlosses.length} AI gloss source row(s)`);
}

function parseArgs(argv: string[]): Args {
  const input = readFlag(argv, "--input");
  const out = readFlag(argv, "--out");
  if (!input || !out) {
    console.error(
      "Usage: bun run scripts/import-jmdict.ts --input path/to/jmdict.json --out data/yori.sqlite [--ai-glosses sources/ai-glosses/zh-tw.jsonl]..."
    );
    process.exit(1);
  }
  return { input, out, aiGlosses: readFlags(argv, "--ai-glosses") };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function readFlags(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) {
      values.push(argv[index + 1]);
    }
  }
  return values;
}

function createSchema(db: Database) {
  db.exec(`
    pragma journal_mode = OFF;
    pragma synchronous = OFF;

    create table metadata (
      key text primary key,
      value text not null
    );

    create table entries (
      id text primary key,
      source text not null,
      source_id text not null unique
    );

    create table forms (
      entry_id text not null references entries(id),
      text text not null,
      reading text,
      kind text not null check (kind in ('kanji', 'kana')),
      common integer not null check (common in (0, 1)),
      tags text not null
    );

    create table senses (
      id text primary key,
      entry_id text not null references entries(id),
      position integer not null,
      applies_to_kanji text not null,
      applies_to_kana text not null,
      part_of_speech text not null
    );

    create table glosses (
      sense_id text not null references senses(id),
      lang text not null,
      text text not null,
      source text not null check (source in ('jmdict', 'ai-assisted')),
      review_status text not null check (review_status in ('source', 'checked'))
    );

    create table lookup_terms (
      term text not null,
      entry_id text not null references entries(id),
      match_kind text not null check (match_kind in ('kanji', 'reading'))
    );

    create index lookup_terms_term_idx on lookup_terms(term);
    create index forms_entry_idx on forms(entry_id);
    create index senses_entry_idx on senses(entry_id);
    create index glosses_sense_idx on glosses(sense_id);
  `);
}

function insertMetadata(db: Database, source: JmdictFile) {
  const insert = db.prepare("insert into metadata (key, value) values (?, ?)");
  if (source.version) insert.run("jmdictSimplifiedVersion", source.version);
  if (source.dictDate) insert.run("dictDate", source.dictDate);
  if (source.languages) insert.run("sourceLanguages", JSON.stringify(source.languages));
}

function insertWords(db: Database, words: JmdictWord[]) {
  const insertEntry = db.prepare("insert into entries (id, source, source_id) values (?, 'jmdict', ?)");
  const insertForm = db.prepare(
    "insert into forms (entry_id, text, reading, kind, common, tags) values (?, ?, ?, ?, ?, ?)"
  );
  const insertSense = db.prepare(
    `insert into senses
      (id, entry_id, position, applies_to_kanji, applies_to_kana, part_of_speech)
     values (?, ?, ?, ?, ?, ?)`
  );
  const insertGloss = db.prepare(
    "insert into glosses (sense_id, lang, text, source, review_status) values (?, ?, ?, 'jmdict', 'source')"
  );
  const insertLookup = db.prepare(
    "insert into lookup_terms (term, entry_id, match_kind) values (?, ?, ?)"
  );

  const transaction = db.transaction((items: JmdictWord[]) => {
    for (const word of items) {
      const entryId = yoriEntryId(word.id);
      insertEntry.run(entryId, word.id);

      const lookupTerms = new Set<string>();
      for (const kanji of word.kanji) {
        const reading = readingForKanji(word, kanji.text);
        insertForm.run(entryId, kanji.text, reading, "kanji", kanji.common ? 1 : 0, JSON.stringify(kanji.tags));
        lookupTerms.add(`kanji:${kanji.text}`);
      }

      for (const kana of word.kana) {
        insertForm.run(entryId, kana.text, null, "kana", kana.common ? 1 : 0, JSON.stringify(kana.tags));
        lookupTerms.add(`reading:${kana.text}`);
      }

      for (const term of lookupTerms) {
        const [matchKind, text] = term.split(":");
        insertLookup.run(text, entryId, matchKind);
      }

      word.sense.forEach((sense, index) => {
        const senseId = yoriSenseId(word.id, index + 1);
        insertSense.run(
          senseId,
          entryId,
          index + 1,
          JSON.stringify(sense.appliesToKanji),
          JSON.stringify(sense.appliesToKana),
          JSON.stringify(sense.partOfSpeech)
        );

        for (const gloss of sense.gloss) {
          const apiLang = toApiLang(gloss.lang);
          if (!apiLang) continue;
          insertGloss.run(senseId, apiLang, gloss.text);
        }
      });
    }
  });

  transaction(words);
}

function insertAiGlosses(db: Database, rows: AiGlossSource[]) {
  if (rows.length === 0) return;

  const senseExists = db.prepare("select 1 from senses where id = ? limit 1");
  const existingGlosses = db.prepare("select count(*) as count from glosses where sense_id = ? and lang = ?");
  const insertGloss = db.prepare(
    "insert into glosses (sense_id, lang, text, source, review_status) values (?, ?, ?, 'ai-assisted', 'checked')"
  );

  const seen = new Set<string>();
  const transaction = db.transaction((items: AiGlossSource[]) => {
    for (const row of items) {
      const apiLang = parseApiLang(row.lang);
      if (!apiLang) {
        throw new Error(`Unsupported AI gloss lang: ${row.lang}`);
      }
      if (!Array.isArray(row.glosses) || row.glosses.length === 0) {
        throw new Error(`AI gloss row has no glosses: ${row.senseId}`);
      }
      if (!senseExists.get(row.senseId)) {
        throw new Error(`AI gloss references unknown senseId: ${row.senseId}`);
      }

      const key = `${row.senseId}:${apiLang}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate AI gloss row for ${key}`);
      }
      seen.add(key);

      const existing = existingGlosses.get(row.senseId, apiLang) as { count: number } | null;
      if ((existing?.count ?? 0) > 0) {
        throw new Error(`AI gloss row conflicts with existing ${apiLang} glosses: ${row.senseId}`);
      }

      for (const gloss of row.glosses) {
        const text = gloss.trim();
        if (text.length === 0) continue;
        insertGloss.run(row.senseId, apiLang, text);
      }
    }
  });

  transaction(rows);
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function readingForKanji(word: JmdictWord, kanjiText: string): string | null {
  const matchingKana = word.kana.find(
    (kana) => kana.appliesToKanji.includes("*") || kana.appliesToKanji.includes(kanjiText)
  );
  return matchingKana?.text ?? word.kana[0]?.text ?? null;
}

function yoriEntryId(sourceId: string): string {
  return `yori:e_jmdict_${sourceId}`;
}

function yoriSenseId(sourceId: string, position: number): string {
  return `yori:s_jmdict_${sourceId}_${position}`;
}
